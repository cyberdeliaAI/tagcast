"""Public, keyless artist discovery through MusicBrainz and ListenBrainz Radio."""

import json
import math
import time
from collections import OrderedDict
from email.utils import parsedate_to_datetime
from threading import Lock
from urllib.parse import urlsplit

import requests

from .discover_lastfm import CACHE_ENTRIES, MAX_BODY, cache_lifetime
from .sources import USER_AGENT, MusicBrainz, SourceError, artist_name_key
from .track_comparison import MBID

RADIO = "https://api.listenbrainz.org/1/lb-radio/artist/"
SEARCH_LIMIT = 25
RELATED_LIMIT = 30


class ListenBrainzSimilar:
    def __init__(self, http):
        self.http = http
        self.gate = Lock()
        self.cache = OrderedDict()
        self.retry_at = {}

    def _get(self, session, url, params, valid):
        host = urlsplit(url).hostname
        if time.monotonic() < self.retry_at.get(host, 0):
            raise SourceError("The discovery source is busy.")
        self.http._wait(host)
        valid()
        try:
            with session.get(url, params=params, timeout=(4, 8), allow_redirects=False,
                             stream=True) as response:
                if response.status_code in (429, 503):
                    retry = response.headers.get("Retry-After", "60")
                    try:
                        delay = int(retry) if retry.isdigit() else (
                            parsedate_to_datetime(retry).timestamp() - time.time())
                    except (ValueError, TypeError, OverflowError):
                        delay = 60
                    self.retry_at[host] = time.monotonic() + max(1, delay)
                if response.status_code != 200:
                    raise SourceError("The discovery source is unavailable.")
                body = bytearray()
                deadline = time.monotonic() + 12
                for chunk in response.iter_content(16384):
                    valid()
                    body.extend(chunk)
                    if len(body) > MAX_BODY or time.monotonic() > deadline:
                        raise SourceError("The discovery response exceeded its limits.")
                data = json.loads(body)
                ttl = math.floor(cache_lifetime(response.headers))
        except (requests.RequestException, UnicodeError, json.JSONDecodeError, RecursionError):
            raise SourceError("The discovery response could not be read.") from None
        valid()
        if not isinstance(data, dict):
            raise SourceError("The discovery source returned an invalid response.")
        return data, ttl

    def read(self, artist, context, valid):
        key = (context, artist_name_key(artist))
        if not self.gate.acquire(timeout=12):
            raise SourceError("The discovery source is busy.")
        try:
            valid()
            now = time.monotonic()
            for cached, (expires, _) in list(self.cache.items()):
                if expires <= now:
                    del self.cache[cached]
            if key in self.cache:
                expires, artists = self.cache[key]
                self.cache.move_to_end(key)
                return artists, math.floor(expires - now)

            with requests.Session() as session:
                session.trust_env = False
                session.headers["User-Agent"] = USER_AGENT
                search, identity_ttl = self._get(session, f"{MusicBrainz.API}/artist", {
                    "query": f"artist:{MusicBrainz._quote(artist)}", "fmt": "json",
                    "limit": SEARCH_LIMIT,
                }, valid)
                rows, count = search.get("artists"), search.get("count")
                if not isinstance(rows, list) or type(count) is not int \
                        or count != len(rows) or count > SEARCH_LIMIT:
                    return (), 0
                matches = [row.get("id") for row in rows
                           if isinstance(row, dict) and isinstance(row.get("name"), str)
                           and artist_name_key(row.get("name")) == key[1]]
                if len(matches) != 1 or not isinstance(matches[0], str) \
                        or not MBID.fullmatch(matches[0]):
                    return (), 0
                mbid = matches[0].lower()
                radio, radio_ttl = self._get(session, RADIO + mbid, {
                    "mode": "easy", "max_similar_artists": RELATED_LIMIT,
                    "max_recordings_per_artist": 3, "pop_begin": 0, "pop_end": 100,
                }, valid)

            artists = []
            seen = {key[1]}
            for identifier, recordings in list(radio.items())[:RELATED_LIMIT + 1]:
                if not MBID.fullmatch(identifier) or identifier.lower() == mbid \
                        or not isinstance(recordings, list) or not recordings:
                    continue
                first = recordings[0]
                if not isinstance(first, dict) or first.get("similar_artist_mbid") != identifier:
                    continue
                name = first.get("similar_artist_name")
                if not isinstance(name, str) or not name.strip() or len(name) > 200:
                    continue
                try:
                    name.encode("utf-8")
                except UnicodeError:
                    continue
                identity = artist_name_key(name)
                if identity not in seen:
                    seen.add(identity)
                    artists.append((name.strip(), identifier.lower()))
            valid()
            artists = tuple(artists[:RELATED_LIMIT])
            ttl = min(identity_ttl, radio_ttl)
            if ttl > 0:
                self.cache[key] = (time.monotonic() + ttl, artists)
                if len(self.cache) > CACHE_ENTRIES:
                    self.cache.popitem(last=False)
            return artists, ttl
        finally:
            self.gate.release()
