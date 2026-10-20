"""Explicit, bounded reads of public playlists; no login, audio or metadata writes."""

import json
import math
import re
import time
from urllib.parse import parse_qs, urljoin, urlsplit

import requests

from .library import LibraryError
from .sources import USER_AGENT

MAX_TRACKS = 10000
MAX_BYTES = 24 * 1024 * 1024
MAX_PAGE_BYTES = 12 * 1024 * 1024
MAX_SECONDS = 60
PLAYLIST_EXTENSION = "https://musicbrainz.org/doc/jspf#playlist"
UUID = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"
DEEZER_HOSTS = {"deezer.com", "www.deezer.com"}
SHORT_HOSTS = {"link.deezer.com", "deezer.page.link"}
API_HOSTS = {"api.deezer.com", "api.listenbrainz.org"}
COLUMNS = ["Track title", "Artist", "Album title", "Duration", "Year", "Track number"]


def valid_origin(origin):
    return (isinstance(origin, dict) and set(origin) == {"provider", "id"}
            and isinstance(origin["id"], str)
            and ((origin["provider"] == "deezer" and bool(re.fullmatch(r"[1-9][0-9]{0,19}", origin["id"])))
                 or (origin["provider"] == "listenbrainz" and bool(re.fullmatch(UUID, origin["id"])))))


def source_url(origin):
    if not valid_origin(origin):
        raise LibraryError("Choose a supported public playlist link.")
    host = "www.deezer.com" if origin["provider"] == "deezer" else "listenbrainz.org"
    return f'https://{host}/playlist/{origin["id"]}'


def split_url(value):
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
            raise ValueError
        parts = urlsplit(value)
        if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
            raise ValueError
        return parts
    except ValueError:
        raise LibraryError("Paste an HTTPS public Deezer or ListenBrainz playlist link.") from None


def identify(value):
    parts = split_url(value)
    if parts.hostname in DEEZER_HOSTS:
        match = re.fullmatch(r"/(?:[a-z]{2}(?:-[a-z]{2})?/)?playlist/([1-9][0-9]{0,19})/?", parts.path)
        if match:
            return {"provider": "deezer", "id": match[1]}
    if parts.hostname in {"listenbrainz.org", "www.listenbrainz.org"}:
        match = re.fullmatch(rf"/playlist/({UUID})/?", parts.path)
        if match:
            return {"provider": "listenbrainz", "id": match[1].lower()}
    raise LibraryError("Use a public Deezer playlist or ListenBrainz playlist link. Other services are not supported.")


def cell(value):
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > 2000 or re.search(r"[\ud800-\udfff\x00]", value):
        raise LibraryError("The playlist contains invalid or oversized text. No partial import was prepared.")
    return value


def duration(value, divisor=1):
    if value is None or value == 0:
        return ""
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value / divisor <= 86400:
        raise LibraryError("The playlist contains an invalid duration. No partial import was prepared.")
    return str(value / divisor)


class PlaylistSources:
    def __init__(self, pacing, check, session=None):
        self.session = session or requests.Session()
        # A separate session never receives iBroadcast credentials or source keys.
        self.session.trust_env = False  # Do not attach credentials from the user's netrc.
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.pacing, self.check = pacing, check
        self.deadline, self.bytes, self.requests = time.monotonic() + MAX_SECONDS, 0, 0

    def _remaining(self):
        self.check()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise LibraryError("Fetching the playlist timed out. Try again or use CSV; no partial import was prepared.")
        return min(15, remaining)

    def _get(self, url, *, redirect=False):
        self.requests += 1
        if self.requests > 105:
            raise LibraryError("The playlist needs too many requests. No partial import was prepared; use CSV.")
        parts = split_url(url)
        if parts.hostname not in (SHORT_HOSTS if redirect else API_HOSTS):
            raise LibraryError("The playlist returned an unsupported destination.")
        self._remaining()
        self.pacing._wait(parts.hostname)
        timeout = self._remaining()
        try:
            with self.session.get(url, timeout=(min(5, timeout), timeout), stream=True, allow_redirects=False) as response:
                if redirect and response.status_code in (301, 302, 303, 307, 308):
                    return urljoin(url, response.headers.get("Location", ""))
                if response.status_code != 200:
                    raise LibraryError("The public playlist could not be fetched (private, missing, blocked or temporarily unavailable). Try again or use CSV.")
                if redirect:
                    raise LibraryError("This short link did not resolve. Paste the full Deezer playlist link.")
                if "json" not in response.headers.get("Content-Type", "").lower():
                    raise LibraryError("The source returned a browser check or a non-JSON response. Try again later or use CSV.")
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    self._remaining()
                    size += len(chunk)
                    self.bytes += len(chunk)
                    if size > MAX_PAGE_BYTES or self.bytes > MAX_BYTES:
                        raise LibraryError("The playlist response is too large. No partial import was prepared; use CSV.")
                    chunks.append(chunk)
                data = json.loads(b"".join(chunks))
                if not isinstance(data, dict) or data.get("error") or data.get("errors"):
                    raise LibraryError("The source did not return a readable public playlist. Try again or use CSV.")
                return data
        except LibraryError:
            raise
        except (requests.RequestException, ValueError, RecursionError):
            raise LibraryError("The playlist source could not be read. Try again later or use CSV; no partial import was prepared.") from None

    def fetch(self, value):
        try:
            short = split_url(value).hostname in SHORT_HOSTS
            for _ in range(4):
                if split_url(value).hostname not in SHORT_HOSTS:
                    break
                self.check("deezer")
                value = self._get(value, redirect=True)
            origin = identify(value)
            if short and origin["provider"] != "deezer":
                raise LibraryError("The Deezer short link returned an unsupported destination.")
            self.check(origin["provider"])
            self.origin = origin
            data = self._deezer() if origin["provider"] == "deezer" else self._listenbrainz()
            self.check(origin["provider"])
            return {**data, "origin": origin, "columns": COLUMNS, "delimiter": ",", "blanks": 0}
        finally:
            self.session.close()

    def _deezer(self):
        base = f'https://api.deezer.com/playlist/{self.origin["id"]}'
        before = self._get(base)
        count = before.get("nb_tracks")
        if str(before.get("id")) != self.origin["id"] or before.get("public") is not True or type(count) is not int or not 1 <= count <= MAX_TRACKS:
            raise LibraryError("Choose a nonempty public playlist with at most 10,000 tracks.")
        rows = []
        while len(rows) < count:
            data = self._get(f"{base}/tracks?limit=100&index={len(rows)}")
            page = data.get("data")
            if type(data.get("total")) is not int or data["total"] != count or not isinstance(page, list) or not 1 <= len(page) <= 100 or len(rows) + len(page) > count:
                raise LibraryError("The playlist is incomplete or changed while fetching. Try again; no partial import was prepared.")
            for track in page:
                if not isinstance(track, dict) or track.get("type", "track") != "track":
                    raise LibraryError("The playlist returned an invalid track. No partial import was prepared.")
                artist, album = track.get("artist") or {}, track.get("album") or {}
                if not isinstance(artist, dict) or not isinstance(album, dict):
                    raise LibraryError("The playlist returned invalid track metadata.")
                title, version = cell(track.get("title")), cell(track.get("title_version"))
                if version and version.casefold() not in title.casefold():
                    title = cell(f"{title} {version}".strip())
                rows.append({"line": len(rows) + 2, "cells": [title, cell(artist.get("name")), cell(album.get("title")), duration(track.get("duration")), "", ""]})
            more = data.get("next")
            if bool(more) != (len(rows) < count):
                raise LibraryError("The playlist pagination is incomplete. No partial import was prepared.")
            if more:
                parts = split_url(more)
                query = parse_qs(parts.query)
                if parts.hostname != "api.deezer.com" or parts.path != urlsplit(base).path + "/tracks" or query.get("index") != [str(len(rows))]:
                    raise LibraryError("The playlist returned invalid pagination. No partial import was prepared.")
        after = self._get(base)
        if after.get("public") is not True or any(before.get(k) != after.get(k) for k in ("id", "nb_tracks", "checksum", "time_mod")):
            raise LibraryError("The playlist changed while fetching. Try again; no partial import was prepared.")
        return {"records": rows, "name": cell(before.get("title")) or "Imported playlist"}

    def _listenbrainz(self):
        data = self._get(f'https://api.listenbrainz.org/1/playlist/{self.origin["id"]}')
        playlist = data.get("playlist")
        if not isinstance(playlist, dict):
            raise LibraryError("ListenBrainz returned an unexpected playlist format. Try CSV instead.")
        if playlist.get("identifier") != source_url(self.origin):
            raise LibraryError("ListenBrainz returned a different playlist identity. No import was prepared.")
        extensions = playlist.get("extension", {})
        visibility = extensions.get(PLAYLIST_EXTENSION, {}) if isinstance(extensions, dict) else {}
        if not isinstance(visibility, dict) or visibility.get("public") is not True:
            raise LibraryError("Only explicitly public ListenBrainz playlists can be imported.")
        tracks = playlist.get("track")
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS:
            raise LibraryError("Choose a nonempty public playlist with at most 10,000 tracks.")
        if data.get("next") or playlist.get("next") or data.get("truncated"):
            raise LibraryError("ListenBrainz returned an incomplete playlist. No partial import was prepared.")
        rows = []
        for track in tracks:
            if not isinstance(track, dict):
                raise LibraryError("ListenBrainz returned an invalid track.")
            rows.append({"line": len(rows) + 2, "cells": [cell(track.get("title")), cell(track.get("creator")), cell(track.get("album")), duration(track.get("duration"), 1000), "", ""]})
        return {"records": rows, "name": cell(playlist.get("title")) or "Imported playlist"}
