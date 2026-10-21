"""Lazy native track lyrics, explicit LRCLIB lookup and reviewed single-track saves.

The public web editor (inspected 2026-10-21) uses gettrackuserdata and replaces
userdata through update_track. Preserve all unrelated userdata, including unknown
types, compare the complete fresh snapshot and never retry an ambiguous write.
Native lyrics text has a separate account/track-bound persistent cache; complete
userdata and review tokens stay in memory. Public LRCLIB results stay separate.
"""

import hashlib
import hmac
import json
import math
import re
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict
from contextlib import closing

import requests

from .library import ConflictError, LibraryError, text
from .sources import USER_AGENT, SourceError, artist_name_key

MAX_LYRICS = 50000
MAX_RESPONSE = 512000
CACHE_TTL = 30 * 86400
NATIVE_CACHE_ENTRIES = 5000
NATIVE_CACHE_BYTES = 20 * 1024 * 1024


def lyric_text(value):
    if not isinstance(value, str) or len(value) > MAX_LYRICS or "\x00" in value:
        raise LibraryError("Lyrics must be text of at most 50,000 characters, without null characters.")
    return value.replace("\r\n", "\n").replace("\r", "\n")


def fetch_lrclib(track):
    """One bounded, credential-free public request; retain full version identity."""
    params = {"track_name": track["title"], "artist_name": track["artist"]}
    if track["length"] > 0:
        params["duration"] = track["length"]
    try:
        with requests.Session() as session:
            session.trust_env = False
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
            with session.get("https://lrclib.net/api/get", params=params, timeout=(5, 15),
                             stream=True, allow_redirects=False) as response:
                if response.status_code == 404:
                    return {"status": "missing", "text": "", "source": "lrclib"}
                if response.status_code != 200:
                    raise SourceError(f"LRCLIB returned HTTP {response.status_code}. Try again later.")
                chunks, size, started = [], 0, time.monotonic()
                for chunk in response.iter_content(16384):
                    size += len(chunk)
                    if size > MAX_RESPONSE or time.monotonic() - started > 20:
                        raise SourceError("LRCLIB returned too much data or took too long.")
                    chunks.append(chunk)
                data = json.loads(b"".join(chunks))
    except (requests.RequestException, ValueError):
        raise SourceError("LRCLIB could not be read. Try again later.") from None
    if not isinstance(data, dict):
        raise SourceError("LRCLIB returned an invalid response.")
    if not isinstance(data.get("trackName"), str) or not isinstance(data.get("artistName"), str):
        raise SourceError("LRCLIB returned invalid track metadata.")
    duration = data.get("duration")
    matching = (artist_name_key(data.get("trackName")) == artist_name_key(track["title"])
                and artist_name_key(data.get("artistName")) == artist_name_key(track["artist"]))
    if track["length"] > 0:
        matching = (matching and type(duration) in (int, float) and math.isfinite(duration)
                    and abs(duration - track["length"]) <= 2)
    if not matching:
        return {"status": "missing", "text": "", "source": "lrclib"}
    if data.get("instrumental") is True:
        return {"status": "instrumental", "text": "", "source": "lrclib"}
    lyrics = data.get("plainLyrics")
    if not lyrics and isinstance(data.get("syncedLyrics"), str):
        # Display text only; timestamps never drive playback in this first version.
        lyrics = re.sub(r"\[\d+:\d+(?:[.:]\d+)?\]", "", data["syncedLyrics"])
        lyrics = re.sub(r"(?m)^\[(?:ar|al|ti|by|offset|length):[^\n]*\]\s*", "", lyrics)
    try:
        lyrics = lyric_text(lyrics or "")
    except LibraryError:
        raise SourceError("LRCLIB returned invalid or oversized lyrics.") from None
    return {"status": "ready" if lyrics.strip() else "missing", "text": lyrics,
            "source": "lrclib"}


class Lyrics:
    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.Lock()
        self.secret = secrets.token_bytes(32)
        self.context = None
        self.native = OrderedDict()
        self.reviews = OrderedDict()
        self.failures = {}
        self.last_lookup = 0

    def _selection(self, body):
        studio = self.studio
        client = studio._require_client()
        library = studio.library
        track_id = body.get("track_id")
        if not library or body.get("session") != studio.playback_session or not body.get("session"):
            raise ConflictError("The account or library changed. Reopen the track.")
        if not isinstance(track_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", track_id):
            raise LibraryError("Choose one track for lyrics.")
        album_id = library.active_track_album(int(track_id))
        track = library.track_view(int(track_id))
        if body.get("title") != track["title"] or body.get("artist") != track["artist"]:
            raise ConflictError("This track changed. Reload the library before reading lyrics.")
        fingerprint = [track_id, album_id, track["title"], track["artist_id"],
                       track["length"], text(library.albums[album_id].get("name"))]
        return client, library, studio.library_user, track, fingerprint

    def _current(self, selection, body):
        client, library, account, _, _ = selection
        return (self.studio.client is client and self.studio.library is library
                and self.studio.library_user == account
                and body.get("session") == self.studio.playback_session)

    def _userdata(self, client, track_id):
        data = client._jsonrequest("gettrackuserdata", track_id=int(track_id))
        rows = data.get("userdata")
        if not isinstance(rows, list) or len(rows) > 100 \
                or any(not isinstance(row, dict) for row in rows) \
                or len(json.dumps(rows, ensure_ascii=False)) > 200000:
            raise LibraryError("iBroadcast returned invalid or oversized track userdata.")
        lyrics = [row for row in rows if row.get("type") == "lyrics"]
        if len(lyrics) > 1:
            raise LibraryError("This track has multiple lyrics fields. Check it in iBroadcast first.")
        return rows, lyric_text(lyrics[0].get("value")) if lyrics else ""

    def _token(self, selection, body, rows):
        payload = [selection[2], body["session"], selection[4], rows]
        return hmac.new(self.secret, json.dumps(payload, sort_keys=True).encode(), hashlib.sha256).hexdigest()

    def _db(self):
        self.studio.home.mkdir(parents=True, exist_ok=True)
        path = self.studio.home / "lyrics.sqlite3"
        # This database holds public text; native lyrics use a separate private cache.
        # Complete native userdata stays in memory.
        path.touch(mode=0o600, exist_ok=True)
        db = sqlite3.connect(path, timeout=2)
        db.execute("CREATE TABLE IF NOT EXISTS lyrics (identity TEXT PRIMARY KEY, data TEXT, expires REAL, saved REAL)")
        return db

    def _native_db(self):
        self.studio.home.mkdir(parents=True, exist_ok=True)
        path = self.studio.home / "native-lyrics.sqlite3"
        path.touch(mode=0o600, exist_ok=True)
        db = sqlite3.connect(path, timeout=2)
        db.execute("CREATE TABLE IF NOT EXISTS native_lyrics (account TEXT, track_id TEXT, identity TEXT, lyrics TEXT, saved REAL, PRIMARY KEY(account, track_id))")
        return db

    def _native_key(self, selection):
        if selection[2] is None or str(selection[2]) in ("", "0"):
            raise ConflictError("Reload the library before reading saved lyrics.")
        identity = json.dumps([selection[4], selection[3]["artist"]], ensure_ascii=False)
        return str(selection[2]), selection[3]["id"], hashlib.sha256(identity.encode()).hexdigest()

    def _native_cached(self, selection):
        with closing(self._native_db()) as db:
            row = db.execute("SELECT lyrics FROM native_lyrics WHERE account=? AND track_id=? AND identity=?",
                             self._native_key(selection)).fetchone()
        return None if row is None else lyric_text(row[0])

    def _native_store(self, selection, lyrics):
        with closing(self._native_db()) as db, db:
            db.execute("INSERT OR REPLACE INTO native_lyrics VALUES (?, ?, ?, ?, ?)",
                       (*self._native_key(selection), lyric_text(lyrics), time.time()))
            rows = db.execute("SELECT account, track_id, length(CAST(lyrics AS BLOB)) FROM native_lyrics ORDER BY saved DESC").fetchall()
            size = 0
            for i, (account, track_id, length) in enumerate(rows):
                size += length
                if i >= NATIVE_CACHE_ENTRIES or size > NATIVE_CACHE_BYTES:
                    db.execute("DELETE FROM native_lyrics WHERE account=? AND track_id=?", (account, track_id))

    def _native_forget(self, selection):
        with closing(self._native_db()) as db, db:
            db.execute("DELETE FROM native_lyrics WHERE account=? AND track_id=?", self._native_key(selection)[:2])

    def _result(self, selection, body, lyrics, rows=None):
        enabled = "lrclib" not in self.studio.disabled_sources()
        result = {"status": "ready" if lyrics.strip() else "missing", "text": lyrics,
                  "source": "ibroadcast", "native_text": lyrics, "can_save": self.studio.premium,
                  "can_lookup": enabled and not lyrics.strip(), "persisted": rows is None}
        if rows is not None:
            result["before_token"] = self._token(selection, body, rows)
        if lyrics.strip() or not enabled:
            return result
        track = selection[3]
        key = json.dumps([artist_name_key(track["title"]), artist_name_key(track["artist"]), track["length"]])
        cached = self._cached(key)
        return {**result, **(cached or {"status": "not_cached"}), "can_lookup": not cached}

    def cached_album(self, body):
        """Read only previously checked text for the visible album; never contact a service."""
        ids = body.get("album_ids")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20 \
                or any(not isinstance(i, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", i) for i in ids):
            raise LibraryError("Choose one album or disc set for saved lyrics.")
        with self.lock, self.studio.lock:
            self.studio._require_client()
            library = self.studio.library
            if not library or not body.get("session") or body["session"] != self.studio.playback_session:
                raise ConflictError("The account or library changed. Reopen the album.")
            track_ids = []
            for album_id in dict.fromkeys(ids):
                album = library.albums.get(int(album_id))
                if not album or album.get("trashed"):
                    raise ConflictError("This album is no longer available.")
                track_ids.extend(library.active_track_ids(int(album_id)))
            if len(set(track_ids)) > 100:
                return {"tracks": []}
            results = []
            try:
                for track_id in dict.fromkeys(track_ids):
                    track = library.track_view(track_id)
                    selection_body = {"track_id": str(track_id), "title": track["title"],
                                      "artist": track["artist"], "session": body["session"]}
                    selection = self._selection(selection_body)
                    lyrics = self._native_cached(selection)
                    if lyrics is not None:
                        results.append({"selection": selection_body, "data": self._result(selection, selection_body, lyrics)})
            except (OSError, sqlite3.Error, ValueError) as error:
                raise LibraryError("Could not read the saved lyrics cache in the settings folder.") from error
            return {"tracks": results}

    def _cached(self, key):
        with closing(self._db()) as db:
            row = db.execute("SELECT data FROM lyrics WHERE identity=? AND expires>?", (key, time.time())).fetchone()
        if not row:
            return None
        data = json.loads(row[0])
        if not isinstance(data, dict) or data.get("source") != "lrclib" \
                or data.get("status") not in ("ready", "missing", "instrumental"):
            raise ValueError("Invalid lyrics cache")
        lyric_text(data.get("text"))
        return {"source": "lrclib", "status": data["status"], "text": data["text"], "cached": True}

    def _cache(self, key, data):
        now = time.time()
        ttl = CACHE_TTL if data["status"] in ("ready", "instrumental") else 86400
        with closing(self._db()) as db, db:
            db.execute("INSERT OR REPLACE INTO lyrics VALUES (?, ?, ?, ?)",
                       (key, json.dumps(data, ensure_ascii=False), now + ttl, now))
            rows = db.execute("SELECT identity, length(CAST(data AS BLOB)) FROM lyrics ORDER BY saved DESC").fetchall()
            size = 0
            for i, (identity, length) in enumerate(rows):
                size += length
                if i >= 1000 or size > 10 * 1024 * 1024:
                    db.execute("DELETE FROM lyrics WHERE identity=?", (identity,))

    def view(self, body):
        lookup = body.get("lookup", False)
        refresh = body.get("refresh", False)
        if type(lookup) is not bool or type(refresh) is not bool:
            raise LibraryError("Choose whether to find lyrics on LRCLIB.")
        with self.lock:
            with self.studio.lock:
                selection = self._selection(body)
                enabled = "lrclib" not in self.studio.disabled_sources()
                context = (selection[0], selection[1], selection[2], body["session"])
                if context != self.context:
                    self.native.clear()
                    self.context = context
            track = selection[3]
            if not lookup and not refresh:
                try:
                    lyrics = self._native_cached(selection)
                    if lyrics is not None:
                        with self.studio.lock:
                            if not self._current(selection, body):
                                raise ConflictError("The account or library changed while reading saved lyrics.")
                            return self._result(selection, body, lyrics)
                except LibraryError:
                    raise
                except (OSError, sqlite3.Error, ValueError) as error:
                    raise LibraryError("Could not read the saved lyrics cache in the settings folder.") from error
            item = None if lookup or refresh else self.native.get(track["id"])
            if not item or time.monotonic() - item[0] > 60:
                rows, lyrics = self._userdata(selection[0], track["id"])
                item = (time.monotonic(), rows, lyrics)
                self.native[track["id"]] = item
                while len(self.native) > 100:
                    self.native.popitem(last=False)
            with self.studio.lock:
                if not self._current(selection, body):
                    raise ConflictError("The account or library changed while reading lyrics.")
                try:
                    self._native_store(selection, item[2])
                except (OSError, sqlite3.Error) as error:
                    raise LibraryError("Could not save native-lyrics.sqlite3 in the settings folder.") from error
            rows, lyrics = item[1:]
            result = {"status": "ready" if lyrics.strip() else "missing", "text": lyrics,
                      "source": "ibroadcast", "before_token": self._token(selection, body, rows),
                      "native_text": lyrics, "can_save": self.studio.premium,
                      "can_lookup": enabled and not lyrics.strip()}
            if lyrics.strip() or not enabled:
                return result
            if len(track["title"]) > 200 or len(track["artist"]) > 200 \
                    or not text(selection[1].tracks[int(track["id"])].get("title")).strip() \
                    or not text(selection[1].artists.get(track["artist_id"], {}).get("name")).strip():
                return {**result, "can_lookup": False}
            key = json.dumps([artist_name_key(track["title"]), artist_name_key(track["artist"]), track["length"]])
            try:
                cached = self._cached(key)
                if lookup and not cached:
                    if time.monotonic() < self.failures.get(key, 0):
                        raise SourceError("LRCLIB lookup failed recently. Wait one minute before trying again.")
                    if time.monotonic() - self.last_lookup < 1:
                        raise SourceError("Please wait a moment between lyrics searches.")
                    with self.studio.lock:
                        if not self._current(selection, body) or "lrclib" in self.studio.disabled_sources():
                            raise ConflictError("The account, library or source preference changed.")
                    self.last_lookup = time.monotonic()
                    try:
                        cached = fetch_lrclib(track)
                    except SourceError:
                        self.failures[key] = time.monotonic() + 60
                        while len(self.failures) > 100:
                            self.failures.pop(next(iter(self.failures)))
                        raise
                    with self.studio.lock:
                        if not self._current(selection, body) or "lrclib" in self.studio.disabled_sources():
                            raise ConflictError("The account, library or source preference changed.")
                    self._cache(key, cached)
            except LibraryError:
                raise
            except (OSError, sqlite3.Error, ValueError) as error:
                raise LibraryError("Could not read or save lyrics.sqlite3 in the settings folder.") from error
            with self.studio.lock:
                if not self._current(selection, body) or "lrclib" in self.studio.disabled_sources():
                    raise ConflictError("The account, library or source preference changed.")
            return {**result, **(cached or {"status": "not_cached"}), "can_lookup": not cached}

    def prepare(self, body):
        after = lyric_text(body.get("lyrics"))
        with self.lock:
            with self.studio.lock:
                selection = self._selection(body)
                if not self.studio.premium:
                    raise LibraryError("Saving lyrics to iBroadcast requires Premium.")
            rows, before = self._userdata(selection[0], body["track_id"])
            if body.get("before_token") != self._token(selection, body, rows):
                self.native.pop(body["track_id"], None)
                self._native_forget(selection)
                raise ConflictError("Track lyrics or additional metadata changed. Reopen lyrics before saving.")
            with self.studio.lock:
                if not self._current(selection, body):
                    raise ConflictError("The account or library changed. Review lyrics again.")
            if before == after:
                raise LibraryError("There are no lyrics changes to save.")
            wanted = [row for row in rows if row.get("type") != "lyrics"]
            if after:
                wanted.append({"type": "lyrics", "value": after})
            if len(wanted) > 100 or len(json.dumps(wanted, ensure_ascii=False)) > 200000:
                raise LibraryError("The combined track userdata would be too large to save safely.")
            review_id = secrets.token_urlsafe(24)
            self.reviews[review_id] = (time.monotonic(), selection, dict(body), rows, after)
            while len(self.reviews) > 10:
                self.reviews.popitem(last=False)
            return {"id": review_id, "before": before, "after": after, "title": selection[3]["title"]}

    def save(self, body):
        if body.get("approved") is not True:
            raise LibraryError("Review and confirm the lyrics change first.")
        if not isinstance(body.get("id"), str):
            raise LibraryError("Choose the reviewed lyrics change.")
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            with self.lock:
                review = self.reviews.pop(body.get("id"), None)
                if not review or time.monotonic() - review[0] > 900:
                    raise ConflictError("This lyrics review expired or was already used. Review again.")
                _, selection, before_body, rows, after = review
                with self.studio.lock:
                    if not self._current(selection, before_body) or not self.studio.premium:
                        raise ConflictError("The account or library changed. Review lyrics again.")
                client = selection[0]
                self.studio._current(client)  # Fresh remote revision/membership check before a write.
                with self.studio.lock:
                    current = self._selection(before_body)
                    if current[0] is not client or current[2] != selection[2] or current[4] != selection[4]:
                        raise ConflictError("The track changed. Review lyrics again.")
                fresh_rows, _ = self._userdata(client, before_body["track_id"])
                if fresh_rows != rows:
                    self.native.pop(before_body["track_id"], None)
                    self._native_forget(current)
                    raise ConflictError("Lyrics or additional metadata changed. Review lyrics again.")
                wanted = [row for row in rows if row.get("type") != "lyrics"]
                if after:
                    wanted.append({"type": "lyrics", "value": after})
                with self.studio.lock:
                    if not self._current(current, before_body) or not self.studio.premium:
                        raise ConflictError("The account or library changed. Review lyrics again.")
                # Intent is consumed above. A failed/uncertain request is never replayed.
                self.native.pop(before_body["track_id"], None)
                self._native_forget(current)
                client._jsonrequest("update_track", _retry=False,
                                    tracks=[{"file_id": int(before_body["track_id"]), "userdata": wanted}])
                try:
                    got, actual = self._userdata(client, before_body["track_id"])
                    confirmed = actual == after and [r for r in got if r.get("type") != "lyrics"] == [r for r in rows if r.get("type") != "lyrics"]
                except Exception:
                    confirmed = False
                with self.studio.lock:
                    if not self._current(current, before_body):
                        raise ConflictError("Lyrics were sent, but the account or library changed before confirmation. Check iBroadcast.")
                    if confirmed:
                        try:
                            self._native_store(current, after)
                        except (OSError, sqlite3.Error):
                            return {"status": "saved", "cache_error": "Lyrics were saved, but the local lyrics cache could not be updated."}
                return {"status": "saved" if confirmed else "unverified"}
        finally:
            self.studio.save_lock.release()
