"""Opt-in album background text, fetched lazily into a bounded public-text cache."""

import json
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import closing

from .album_guide import guide_title_text
from .artist_bios import biography_text
from .collections import track_ids
from .library import ConflictError, LibraryError, number, text
from .sources import SourceError, TheAudioDB, artist_name_key

INFO_TTL = 30 * 86400
MISSING_TTL = 86400
RETRY_DELAY = 60
MAX_ENTRIES = 5000
MAX_BYTES = 20 * 1024 * 1024


def album_information_key(artist, album):
    # Retain punctuation, accents, numbered volumes and all edition/version text.
    return json.dumps([artist_name_key(artist), artist_name_key(album)], ensure_ascii=False)


class AlbumInformationRetryError(SourceError):
    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = max(1, min(RETRY_DELAY, math.ceil(retry_after)))


class AlbumInformation:
    def __init__(self, studio):
        self.studio = studio
        self.cache_lock = threading.Lock()
        self.fetch_lock = threading.Lock()
        self.revision = 0
        self.failures = {}

    def _db(self):
        self.studio.home.mkdir(parents=True, exist_ok=True)
        path = self.studio.home / "album-information.sqlite3"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        db = sqlite3.connect(path, timeout=2)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS albums ("
                       "source TEXT, album_key TEXT, language TEXT, data TEXT NOT NULL, "
                       "fetched_at REAL NOT NULL, expires_at REAL NOT NULL, "
                       "PRIMARY KEY (source, album_key, language))")
            db.commit()
            return db
        except Exception:
            db.close()
            raise

    def _read(self, key):
        with self.cache_lock, closing(self._db()) as db:
            row = db.execute("SELECT data, fetched_at, expires_at FROM albums "
                             "WHERE source = 'theaudiodb' AND album_key = ? AND language = 'en'",
                             (key,)).fetchone()
        if not row:
            return None
        data = json.loads(row[0])
        if not isinstance(data, dict) or data.get("status") not in ("ready", "missing", "ambiguous", "unavailable") \
                or data.get("source") != "theaudiodb" or data.get("language") != "en" \
                or any(not isinstance(data.get(field), str) for field in ("artist", "album", "description", "url")) \
                or len(data["description"]) > 20000 \
                or album_information_key(data["artist"], data["album"]) != key \
                or data["url"] and not re.fullmatch(r"https://www\.theaudiodb\.com/album/[0-9]{1,20}", data["url"]) \
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in row[1:]):
            raise ValueError("Invalid cached album information")
        lookup_album = guide_title_text(data["album"]) or data["album"]
        if "lookup_album" in data and (data["lookup_album"] != lookup_album
                                      or lookup_album == data["album"]):
            raise ValueError("Invalid cached album information lookup title")
        # Revisit only old misses that have not tried the new edition fallback.
        edition_lookup_missing = (data["status"] == "missing" and lookup_album != data["album"]
                                  and "lookup_album" not in data)
        return {**data, "cached": True, "fetched_at": row[1], "expires_at": row[2],
                "needs_lookup": time.time() >= row[2] or edition_lookup_missing}

    def _write(self, key, data):
        now = time.time()
        ttl = INFO_TTL if data["status"] == "ready" else MISSING_TTL
        encoded = json.dumps(data, ensure_ascii=False)
        with self.cache_lock, closing(self._db()) as db, db:
            db.execute("INSERT OR REPLACE INTO albums VALUES ('theaudiodb', ?, 'en', ?, ?, ?)",
                       (key, encoded, now, now + ttl))
            rows = db.execute("SELECT album_key, language, length(CAST(data AS BLOB)) "
                              "FROM albums ORDER BY fetched_at DESC, rowid DESC").fetchall()
            size = 0
            for position, (album, language, length) in enumerate(rows):
                size += length
                if position >= MAX_ENTRIES or size > MAX_BYTES:
                    db.execute("DELETE FROM albums WHERE source = 'theaudiodb' "
                               "AND album_key = ? AND language = ?", (album, language))

    def _selection(self, body):
        studio = self.studio
        studio._require_client()
        library = studio.library
        if not library or body.get("session") != studio.playback_session:
            raise ConflictError("The account or library changed. Reload the library.")
        [album_id] = track_ids([body.get("album_id")], 1)
        album = library.albums.get(album_id)
        if not album or album.get("trashed") or not library.active_track_ids(album_id):
            raise ConflictError("This album is no longer available. Reload the library.")
        if body.get("album") != (text(album.get("name")) or "Untitled album") \
                or body.get("artist") != library.artist_name(album.get("artist_id")):
            raise ConflictError("This album's name or artist changed. Reload the library.")
        name = text(album.get("name")).strip()
        artist = text(library.artists.get(number(album.get("artist_id")), {}).get("name")).strip()
        return library, artist, name

    def view(self, body):
        studio = self.studio
        lookup = body.get("lookup", False)
        if type(lookup) is not bool:
            raise LibraryError("Choose whether to look up this album information.")
        with studio.lock:
            if studio.config.get("album_information") is not True:
                return {"enabled": False}
            library, artist, album = self._selection(body)
            if not artist or not album:
                return {"enabled": True, "status": "unavailable", "reason": "missing_identity",
                        "needs_lookup": False}
            if len(artist) > 200 or len(album) > 1000:
                raise LibraryError("The artist or album name is too long for an album information lookup.")
            client, account, revision = studio.client, studio.library_user, self.revision

        def current():
            if not (studio.client is client and studio.library is library
                    and studio.library_user == account and body.get("session") == studio.playback_session
                    and studio.config.get("album_information") is True and self.revision == revision):
                return False
            # In-place metadata changes must not attach text to an older album identity.
            try:
                return self._selection(body)[1:] == (artist, album)
            except LibraryError:
                return False

        key = album_information_key(artist, album)
        try:
            cached = self._read(key)
            if lookup and (not cached or cached["needs_lookup"]):
                with self.fetch_lock:
                    with studio.lock:
                        if not current():
                            raise ConflictError("The account, library or album information setting changed.")
                    cached = self._read(key)
                    failure = self.failures.get(key)
                    if failure and failure[0] > time.time():
                        raise AlbumInformationRetryError(failure[1], failure[0] - time.time())
                    if not cached or cached["needs_lookup"]:
                        try:
                            source = TheAudioDB(studio.lookup.http, {})
                            data = source.album_information(artist, album)
                            lookup_album = guide_title_text(album) or album
                            if data["status"] == "missing" and lookup_album != album:
                                with studio.lock:
                                    if not current():
                                        raise ConflictError("The account, library or album information setting changed.")
                                # Only public background text gets this fallback. Keep the
                                # stored full identity for caching and all library guards.
                                data = {**source.album_information(artist, lookup_album),
                                        "artist": artist, "album": album, "lookup_album": lookup_album}
                        except SourceError as error:
                            message = f"TheAudioDB {error}."
                            self.failures[key] = (time.time() + RETRY_DELAY, message)
                            while len(self.failures) > 100:
                                self.failures.pop(next(iter(self.failures)))
                            raise AlbumInformationRetryError(message, RETRY_DELAY) from None
                        data["description"] = biography_text(data["description"])
                        if data["status"] == "ready" and not data["description"]:
                            data["status"] = "unavailable"
                        with studio.lock:
                            if not current():
                                raise ConflictError("The account, library or album information setting changed.")
                            self._write(key, data)
                        self.failures.pop(key, None)
                        cached = self._read(key)
        except LibraryError:
            raise
        except (OSError, sqlite3.Error, ValueError) as error:
            raise LibraryError("Could not read or save the local album information cache. "
                               "Check album-information.sqlite3 in the settings folder.") from error
        with studio.lock:
            if not current():
                raise ConflictError("The account, library or album information setting changed.")
        return {"enabled": True, **(cached or {"status": "not_cached", "needs_lookup": True})}
