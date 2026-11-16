"""Bounded, explicit Last.fm artist similarity reads; no user login or listening data."""

import hashlib
import json
import math
import re
import threading
import time
from collections import OrderedDict
from email.utils import parsedate_to_datetime

import requests

from .sources import USER_AGENT, LastFm, SourceError, artist_name_key

MAX_BODY = 512 * 1024
MAX_ARTISTS = 100
CACHE_BYTES = 2 * 1024 * 1024
CACHE_ENTRIES = 64


def cache_lifetime(headers):
    """Honor origin cache controls; never retain a response longer than six hours."""
    control = headers.get("Cache-Control", "").lower()
    if any(x.strip().split("=", 1)[0] in {"no-store", "no-cache", "private"}
           for x in control.split(",")):
        return 0
    age = max(0, int(headers.get("Age", "0"))) if str(headers.get("Age", "0")).isdigit() else 0
    match = re.search(r'(?:^|,)\s*max-age\s*=\s*"?(\d+)', control)
    if match:
        return max(0, min(21600, int(match[1]) - age))
    if headers.get("Expires"):
        try:
            return max(0, min(21600, parsedate_to_datetime(headers["Expires"]).timestamp() - time.time()))
        except (ValueError, TypeError, OverflowError):
            return 0
    return 3600


def lastfm_error(kind):
    if kind == "unavailable":
        return SourceError("Last.fm could not be reached. Try again later.", code="discover.lastfm_unavailable")
    if kind == "busy":
        return SourceError("Last.fm is busy. Wait before trying again.", code="discover.lastfm_busy")
    if kind == "key":
        return SourceError("Last.fm refused the API key. Check Sources & keys in Settings.", code="discover.lastfm_key")
    if kind == "identity":
        return SourceError("Last.fm could not identify this artist exactly. You can turn off Last.fm in Settings → Discovery to use local genres.", code="discover.lastfm_identity")
    return SourceError("Last.fm returned an unusable response. Try again later.", code="discover.lastfm_response")


class LastfmSimilar:
    def __init__(self, http):
        self.http = http
        self.gate = threading.Lock()
        self.cache = OrderedDict()
        self.size = 0
        self.next_request = 0
        self.retry_at = 0

    def read(self, artist, key, context, valid):
        """One fixed HTTPS GET; shared provider pacing, bounded RAM and no automatic retry."""
        identity = (context, artist_name_key(artist), hashlib.sha256(key.encode()).digest())
        if not self.gate.acquire(timeout=12):
            raise lastfm_error("busy")
        try:
            valid()
            now = time.monotonic()
            for cache_key, row in list(self.cache.items()):
                if row[0] <= now:
                    self.size -= row[2]
                    del self.cache[cache_key]
            if identity in self.cache:
                expires, artists, _ = self.cache[identity]
                self.cache.move_to_end(identity)
                return artists, max(0, math.floor(expires - now))
            if self.retry_at > now:
                raise lastfm_error("busy")
            delay = self.next_request - now
            if delay > 0:
                time.sleep(min(delay, 1))
            self.http._wait("ws.audioscrobbler.com")
            valid()
            self.next_request = time.monotonic() + 1
            try:
                # A fresh Session sends no cookies/auth from metadata or account requests.
                with requests.Session() as session:
                    session.trust_env = False
                    session.headers["User-Agent"] = USER_AGENT
                    response = session.get(LastFm.API, params={"method": "artist.getSimilar",
                        "artist": artist, "autocorrect": 0, "limit": MAX_ARTISTS,
                        "api_key": key, "format": "json"}, timeout=(4, 8),
                        allow_redirects=False, stream=True)
                    with response:
                        if response.status_code in (429, 503):
                            retry = response.headers.get("Retry-After", "60")
                            try:
                                wait = float(retry) if str(retry).isdigit() else parsedate_to_datetime(retry).timestamp() - time.time()
                            except (ValueError, TypeError, OverflowError):
                                wait = 60
                            self.retry_at = time.monotonic() + max(1, wait)
                            raise lastfm_error("busy")
                        if response.status_code in (401, 403):
                            raise lastfm_error("key")
                        if response.status_code != 200:
                            raise lastfm_error("unavailable")
                        body = bytearray()
                        deadline = time.monotonic() + 12
                        for chunk in response.iter_content(16384):
                            valid()
                            body.extend(chunk)
                            if len(body) > MAX_BODY or time.monotonic() > deadline:
                                raise lastfm_error("response")
                        ttl = cache_lifetime(response.headers)
                data = json.loads(body)
            except (requests.RequestException, UnicodeError, json.JSONDecodeError):
                raise lastfm_error("unavailable") from None
            valid()
            if not isinstance(data, dict):
                raise lastfm_error("response")
            error = data.get("error")
            if error in (10, 26):
                raise lastfm_error("key")
            if error == 29:
                self.retry_at = time.monotonic() + 60
                raise lastfm_error("busy")
            if error == 6:
                raise lastfm_error("identity")
            if error:
                raise lastfm_error("unavailable")
            result = data.get("similarartists")
            if not isinstance(result, dict) or not isinstance(result.get("@attr"), dict) \
                    or artist_name_key(result["@attr"].get("artist")) != artist_name_key(artist):
                raise lastfm_error("identity")
            rows = result.get("artist", [])
            if not isinstance(rows, list) or len(rows) > MAX_ARTISTS:
                raise lastfm_error("response")
            artists, seen = [], set()
            for row in rows:
                if not isinstance(row, dict):
                    raise lastfm_error("response")
                name = row.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 200:
                    continue
                try:
                    name.encode("utf-8")
                except UnicodeError:
                    continue
                try:
                    score = float(row.get("match"))
                except (ValueError, TypeError):
                    continue
                normalized = artist_name_key(name)
                if not math.isfinite(score) or not 0 < score <= 1 or normalized in seen \
                        or normalized == artist_name_key(artist):
                    continue
                seen.add(normalized)
                artists.append((name.strip(), score))
            artists = tuple(sorted(artists, key=lambda row: (-row[1], artist_name_key(row[0]))))
            valid()
            size = len(body)
            if ttl > 0:
                while self.cache and (len(self.cache) >= CACHE_ENTRIES or self.size + size > CACHE_BYTES):
                    _, old = self.cache.popitem(last=False)
                    self.size -= old[2]
                self.cache[identity] = (time.monotonic() + ttl, artists, size)
                self.size += size
            return artists, math.floor(ttl)
        finally:
            self.gate.release()
