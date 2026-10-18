"""Opt-in, lazy public artist biographies in a separate bounded local SQLite cache."""

import json
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import closing
from html.parser import HTMLParser

from .library import ConflictError, LibraryError, text
from .sources import SourceError, TheAudioDB, artist_name_key

BIO_TTL = 30 * 86400
MISSING_TTL = 86400
RETRY_DELAY = 60
MAX_ENTRIES = 5000
MAX_BYTES = 20 * 1024 * 1024


class BiographyRetryError(SourceError):
    """A provider failure with the remaining local backoff, without retrying it."""

    def __init__(self, message, retry_after):
        super().__init__(message)
        self.retry_after = max(1, min(RETRY_DELAY, math.ceil(retry_after)))


class _BiographyText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        if tag in ("p", "br", "div", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1
        if tag in ("p", "div", "li"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def biography_text(value):
    parser = _BiographyText()
    parser.feed(value[:100000])
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in "".join(parser.parts).splitlines()]
    return "\n\n".join(line for line in lines if line)[:20000]


class ArtistBiographies:
    def __init__(self, studio):
        self.studio = studio
        self.cache_lock = threading.Lock()
        self.fetch_lock = threading.Lock()
        self.revision = 0
        self.failures = {}

    def _db(self):
        self.studio.home.mkdir(parents=True, exist_ok=True)
        path = self.studio.home / "artist-biographies.sqlite3"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
        db = sqlite3.connect(path, timeout=2)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS biographies ("
                       "source TEXT, artist_key TEXT, language TEXT, data TEXT NOT NULL, "
                       "fetched_at REAL NOT NULL, expires_at REAL NOT NULL, "
                       "PRIMARY KEY (source, artist_key, language))")
            db.commit()
            return db
        except Exception:
            db.close()
            raise

    def _read(self, key):
        with self.cache_lock, closing(self._db()) as db:
            row = db.execute("SELECT data, fetched_at, expires_at FROM biographies "
                             "WHERE source = 'theaudiodb' AND artist_key = ? AND language = 'en'",
                             (key,)).fetchone()
        if not row:
            return None
        data = json.loads(row[0])
        if not isinstance(data, dict) or data.get("status") not in ("ready", "missing", "ambiguous", "unavailable") \
                or data.get("source") != "theaudiodb" or data.get("language") != "en" \
                or not isinstance(data.get("name"), str) \
                or not isinstance(data.get("biography"), str) or len(data["biography"]) > 20000 \
                or not isinstance(data.get("url"), str) \
                or data["url"] and not re.fullmatch(r"https://www\.theaudiodb\.com/artist/\d{1,20}", data["url"]):
            raise ValueError("Invalid cached biography")
        return {**data, "cached": True, "fetched_at": row[1], "expires_at": row[2],
                "needs_lookup": time.time() >= row[2]}

    def _write(self, key, data):
        now = time.time()
        ttl = BIO_TTL if data["status"] == "ready" else MISSING_TTL
        encoded = json.dumps(data, ensure_ascii=False)
        with self.cache_lock, closing(self._db()) as db, db:
            db.execute("INSERT OR REPLACE INTO biographies VALUES ('theaudiodb', ?, 'en', ?, ?, ?)",
                       (key, encoded, now, now + ttl))
            # Keep only bounded public text, not library tracks, images or credentials.
            rows = db.execute("SELECT artist_key, language, length(CAST(data AS BLOB)) "
                              "FROM biographies ORDER BY fetched_at DESC").fetchall()
            size = 0
            for position, (artist, language, length) in enumerate(rows):
                size += length
                if position >= MAX_ENTRIES or size > MAX_BYTES:
                    db.execute("DELETE FROM biographies WHERE source = 'theaudiodb' "
                               "AND artist_key = ? AND language = ?", (artist, language))

    def view(self, body):
        studio = self.studio
        lookup = body.get("lookup", False)
        if type(lookup) is not bool:
            raise LibraryError("Choose whether to look up this biography.")
        with studio.lock:
            if studio.config.get("artist_biographies") is not True:
                return {"enabled": False}
            library, ids, name = studio.collections.artist_selection(body)
            if not all(text(library.artists[int(i)].get("name")).strip() for i in ids):
                # Display fallbacks are not actual artist names and must never leave this server.
                return {"enabled": True, "status": "unavailable", "reason": "missing_name",
                        "needs_lookup": False}
            if len(name) > 200:
                raise LibraryError("The artist name is too long for a biography lookup.")
            client, account, revision = studio.client, studio.library_user, self.revision

        def current():
            return (studio.client is client and studio.library is library
                    and studio.library_user == account and body.get("session") == studio.playback_session
                    and studio.config.get("artist_biographies") is True and self.revision == revision)

        key = artist_name_key(name)
        try:
            cached = self._read(key)
            if lookup and (not cached or cached["needs_lookup"]):
                # Coalesce simultaneous visits and share the online sources' host pacing.
                with self.fetch_lock:
                    with studio.lock:
                        if not current():
                            raise ConflictError("The account, library or biography setting changed.")
                    cached = self._read(key)
                    failure = self.failures.get(key)
                    if failure and failure[0] > time.time():
                        raise BiographyRetryError(failure[1], failure[0] - time.time())
                    if not cached or cached["needs_lookup"]:
                        try:
                            data = TheAudioDB(studio.lookup.http, {}).biography(name)
                        except SourceError as error:
                            message = f"TheAudioDB {error}."
                            self.failures[key] = (time.time() + RETRY_DELAY, message)
                            # Limit failed-name memory as well as successful disk records.
                            while len(self.failures) > 100:
                                self.failures.pop(next(iter(self.failures)))
                            raise BiographyRetryError(message, RETRY_DELAY) from None
                        data["biography"] = biography_text(data["biography"])
                        if data["status"] == "ready" and not data["biography"]:
                            data["status"] = "unavailable"
                        with studio.lock:
                            if not current():
                                raise ConflictError("The account, library or biography setting changed.")
                            self._write(key, data)
                        self.failures.pop(key, None)
                        cached = self._read(key)
        except LibraryError:
            raise
        except (OSError, sqlite3.Error, ValueError) as error:
            raise LibraryError("Could not read or save the local biography cache. Check artist-biographies.sqlite3 in the settings folder.") from error
        with studio.lock:
            if not current():
                raise ConflictError("The account, library or biography setting changed.")
        return {"enabled": True, **(cached or {"status": "not_cached", "needs_lookup": True})}
