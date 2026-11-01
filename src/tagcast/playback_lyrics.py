"""Read-only, opt-in Unison/LRCLIB lyrics for Now playing. No disk writes.

Independent implementation of the documented Unison API and TTML/LRC formats;
no provider code or lyrics corpus is bundled. Audio and metadata saves stay separate.
"""

import json
import math
import re
import threading
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict

import requests

from .library import ConflictError, LibraryError
from .sources import USER_AGENT, SourceError, artist_name_key

MAX_RESPONSE = 512000
MAX_TEXT = 50000
MAX_LINES = 2000
MAX_TIME = 86400
UNISON_URL = "https://unison.boidu.dev/lyrics"
LRCLIB_URL = "https://lrclib.net/api/"


def lyric_time(value):
    """Bounded clock/offset time; unsupported TTML frame/tick timing stays untimed."""
    if not isinstance(value, str):
        return None
    offset = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h)", value)
    if offset:
        result = float(offset[1]) * {"ms": .001, "s": 1, "m": 60, "h": 3600}[offset[2]]
    elif re.fullmatch(r"(?:\d{1,3}:)?\d{1,3}:\d{2}(?:\.\d+)?", value):
        parts = [float(part) for part in value.split(":")]
        if parts[-1] >= 60 or len(parts) == 3 and parts[-2] >= 60:
            return None
        result = sum(part * 60 ** i for i, part in enumerate(reversed(parts)))
    else:
        return None
    return result if math.isfinite(result) and 0 <= result <= MAX_TIME else None


def _finish(lines, duration, source="unison"):
    label = "LRCLIB" if source == "lrclib" else "Unison"
    if len(lines) > MAX_LINES or sum(len(line["text"]) for line in lines) > MAX_TEXT:
        raise SourceError(f"{label} returned too much lyrics text.")
    timed = bool(lines) and all(line["start"] is not None for line in lines)
    if timed:
        lines.sort(key=lambda line: line["start"])
        if any(not 0 <= line["start"] <= MAX_TIME for line in lines):
            raise SourceError(f"{label} returned invalid lyrics timing.")
        if duration > 0 and any(line["start"] > duration + 2 for line in lines):
            raise SourceError(f"{label} timing does not fit this recording.")
        next_start = duration if duration > 0 else MAX_TIME
        later_start = None
        for line in reversed(lines):
            if later_start is not None and line["start"] < later_start:
                next_start = later_start
            if line["end"] is None:
                line["end"] = next_start
            if not line["start"] <= line["end"] <= MAX_TIME:
                raise SourceError(f"{label} returned invalid lyrics timing.")
            later_start = line["start"]
    else:
        for line in lines:
            line.update(start=None, end=None)
    return {"status": "ready" if lines else "missing", "source": source,
            "timed": timed, "lines": lines}


def parse_lrc(value, duration, source="unison"):
    lines = []
    offset = re.search(r"(?im)^\[offset:([+-]?\d{1,7})\]", value)
    offset = int(offset[1]) / 1000 if offset else 0
    for raw in value.splitlines():
        stamps = re.match(r"^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+", raw)
        if not stamps:
            if raw.strip() and not re.match(r"^\[[a-z_]+:", raw, re.I):
                lines.append({"start": None, "end": None, "text": raw.strip()})
            continue
        text = re.sub(r"<\d{1,3}:\d{2}(?:\.\d+)?>", "", raw[stamps.end():]).strip()
        # Blank timestamped lines mark instrumental breaks as well as the ending.
        for stamp in re.findall(r"\[([^]]+)\]", stamps[0]):
            stamp = re.sub(r"^(\d+:\d+):", r"\1.", stamp)
            start = lyric_time(stamp)
            if start is None:
                label = "LRCLIB" if source == "lrclib" else "Unison"
                raise SourceError(f"{label} returned invalid LRC timing.")
            lines.append({"start": max(0, start + offset), "end": None, "text": text})
    return _finish(lines, duration, source)


def parse_ttml(value, duration):
    # Reject DTDs/entities before the standard XML parser can expand them.
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)", value, re.I):
        raise SourceError("Unison returned unsupported XML declarations.")
    try:
        root = ET.fromstring(value)
    except ET.ParseError:
        raise SourceError("Unison returned invalid TTML lyrics.") from None
    nodes = list(root.iter())
    if len(nodes) > 12000:
        raise SourceError("Unison returned too much TTML data.")
    # Apple lyric TTML uses absolute song times, including inside div/p elements.
    apple = any("itunes.apple.com" in name for node in nodes for name in node.attrib)
    lines = []

    def visit(node, parent_start=0, depth=0):
        if depth > 40:
            raise SourceError("Unison TTML is nested too deeply.")
        begin = lyric_time(node.get("begin"))
        start = (begin if apple else parent_start + begin) if begin is not None else parent_start
        end = lyric_time(node.get("end"))
        if end is not None and not apple:
            end += parent_start
        length = lyric_time(node.get("dur"))
        if end is None and length is not None:
            end = start + length
        if node.tag.rsplit("}", 1)[-1] == "p":
            for child in node.iter():
                if child.tag.rsplit("}", 1)[-1] == "br":
                    child.text = "\n"
            text = "".join(node.itertext()).strip()
            if text:
                lines.append({"start": start if begin is not None else None,
                              "end": end, "text": text})
            return
        for child in node:
            visit(child, start, depth + 1)

    visit(root)
    return _finish(lines, duration)


def fetch_unison(track, album):
    """One anonymous, bounded request. No cookies, account tokens or retries."""
    params = {"song": track["title"], "artist": track["artist"], "album": album}
    duration = track["length"]
    if duration > 0:
        params["duration"] = duration
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.get(UNISON_URL, params=params,
                             headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                             timeout=(4, 8), stream=True, allow_redirects=False) as response:
                if response.status_code == 404:
                    return _finish([], duration)
                if response.status_code != 200:
                    error = SourceError("Unison is unavailable. Try again later.")
                    retry = response.headers.get("Retry-After", "")
                    error.retry_after = min(3600, max(60, int(retry))) if re.fullmatch(r"\d{1,6}", retry) else 60
                    raise error
                chunks, size, started = [], 0, time.monotonic()
                for chunk in response.iter_content(16384):
                    size += len(chunk)
                    if size > MAX_RESPONSE or time.monotonic() - started > 12:
                        raise SourceError("Unison returned too much data or took too long.")
                    chunks.append(chunk)
                data = json.loads(b"".join(chunks))
    except (requests.RequestException, ValueError):
        raise SourceError("Unison could not be read. Try again later.") from None
    if not isinstance(data, dict) or data.get("success") is not True \
            or not isinstance(data.get("data"), dict):
        raise SourceError("Unison returned an invalid response.")
    data = data["data"]
    if any(not isinstance(data.get(key), str) for key in ("song", "artist", "lyrics")):
        raise SourceError("Unison returned invalid track details.")
    # Never discard live/remix/version identity or accept partial word overlap.
    if artist_name_key(data["song"]) != artist_name_key(track["title"]) \
            or artist_name_key(data["artist"]) != artist_name_key(track["artist"]):
        return _finish([], duration)
    length = data.get("duration")
    if duration > 0 and (type(length) not in (int, float) or not math.isfinite(length)
                         or abs(length - duration) > 2):
        return _finish([], duration)
    value = data["lyrics"]
    if len(value) > MAX_RESPONSE or "\x00" in value:
        raise SourceError("Unison returned oversized or invalid lyrics.")
    if data.get("format") == "ttml":
        return parse_ttml(value, duration)
    if data.get("format") == "lrc":
        return parse_lrc(value, duration)
    if data.get("format") == "plain":
        return _finish([{"start": None, "end": None, "text": line}
                        for line in value.splitlines() if line.strip()], duration)
    raise SourceError("Unison returned an unsupported lyrics format.")


def lyrics_name_key(value):
    """Typography-only variants; keep accents, collaborators and version text."""
    return artist_name_key(value).translate(str.maketrans({
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\u2013": "-", "\u2014": "-",
    }))


def _lrclib_match(data, track, album):
    if not isinstance(data, dict) or any(not isinstance(data.get(key), str)
                                         for key in ("trackName", "artistName")):
        return False
    if any(lyrics_name_key(data[key]) != lyrics_name_key(track[name])
           for key, name in (("trackName", "title"), ("artistName", "artist"))):
        return False
    length = data.get("duration")
    if type(length) not in (int, float) or not math.isfinite(length) or not 0 < length <= MAX_TIME:
        return False
    if track["length"] > 0:
        return abs(length - track["length"]) <= 2
    # Without a known duration, require a unique full album identity instead.
    return bool(album.strip()) and lyrics_name_key(data.get("albumName")) == lyrics_name_key(album)


def _lrclib_lines(data, duration):
    result = _finish([], duration, "lrclib")
    if data.get("instrumental") is True:
        return {**result, "status": "instrumental"}
    synced, plain = data.get("syncedLyrics"), data.get("plainLyrics")
    if any(value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT
                                  or "\x00" in value) for value in (synced, plain)):
        raise SourceError("LRCLIB returned invalid or oversized lyrics.")
    if synced and synced.strip():
        return parse_lrc(synced, duration, "lrclib")
    return _finish([{"start": None, "end": None, "text": line}
                    for line in (plain or "").splitlines()], duration, "lrclib")


def fetch_lrclib_display(track, album, check_current):
    """Exact get, then at most two sequential searches; display-only and bounded."""
    deadline, previous = time.monotonic() + 12, 0

    def read(session, endpoint, params):
        nonlocal previous
        delay = max(0, previous + .25 - time.monotonic())
        if delay:
            time.sleep(delay)
        check_current()  # Recheck account, session and source before every request.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SourceError("LRCLIB took too long. Try again later.")
        previous = time.monotonic()
        session.cookies.clear()
        with session.get(LRCLIB_URL + endpoint, params=params,
                         timeout=(min(4, remaining), min(5, remaining)), stream=True,
                         allow_redirects=False) as response:
            if response.status_code == 404:
                return None
            if response.status_code != 200:
                error = SourceError("LRCLIB is unavailable. Try again later.")
                retry = response.headers.get("Retry-After", "")
                error.retry_after = max(60, int(retry)) if re.fullmatch(r"\d{1,8}", retry) else 60
                raise error
            if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise SourceError("LRCLIB returned an invalid response.")
            chunks, size = [], 0
            for chunk in response.iter_content(16384):
                size += len(chunk)
                if size > MAX_RESPONSE or time.monotonic() > deadline:
                    raise SourceError("LRCLIB returned too much data or took too long.")
                chunks.append(chunk)
            check_current()
            data = json.loads(b"".join(chunks))
            if not isinstance(data, (dict, list)):
                raise SourceError("LRCLIB returned an invalid response.")
            return data

    params = {"track_name": track["title"], "artist_name": track["artist"]}
    if album.strip():
        params["album_name"] = album
    # The public endpoint accepts durations from 1 to 3600 seconds.
    if 1 <= track["length"] <= 3600:
        params["duration"] = track["length"]
    try:
        with requests.Session() as session:
            session.trust_env = False
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
            data = read(session, "get", params)
            if data is not None and (not isinstance(data, dict)
                                     or any(not isinstance(data.get(key), str)
                                            for key in ("trackName", "artistName"))):
                raise SourceError("LRCLIB returned an invalid response.")
            if _lrclib_match(data, track, album):
                result = _lrclib_lines(data, track["length"])
                if result["status"] != "missing":
                    return result
            variants = [(track["title"], track["artist"]),
                        (lyrics_name_key(track["title"]), lyrics_name_key(track["artist"]))]
            seen, candidates = set(), []
            for title, artist in variants:
                query = (title.casefold(), artist.casefold())
                if query in seen:
                    continue
                seen.add(query)
                hits = read(session, "search", {"track_name": title, "artist_name": artist})
                if hits is None:
                    hits = []
                if not isinstance(hits, list) or len(hits) > 100:
                    raise SourceError("LRCLIB returned invalid search results.")
                for hit in hits:
                    if _lrclib_match(hit, track, album) and hit not in candidates:
                        candidates.append(hit)
            if track["length"] <= 0 and len(candidates) != 1:
                return _finish([], 0, "lrclib")
            candidates.sort(key=lambda hit: (abs(hit["duration"] - track["length"]),
                            not bool(hit.get("syncedLyrics")),
                            lyrics_name_key(hit.get("albumName")) != lyrics_name_key(album)))
            for hit in candidates:
                result = _lrclib_lines(hit, track["length"])
                if result["status"] != "missing":
                    return result
    except LibraryError:
        raise
    except (requests.RequestException, ValueError):
        raise SourceError("LRCLIB could not be read. Try again later.") from None
    return _finish([], track["length"], "lrclib")


class PlaybackLyrics:
    """Small account/session-bound RAM cache, independent of native/save locks."""

    def __init__(self, lyrics):
        self.lyrics = lyrics
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.context = None
        self.next_request = 0

    def view(self, body):
        if body.get("enabled") is not True:
            raise LibraryError("Enable online Now playing lyrics before looking up Unison.")
        fallback = body.get("fallback_lrclib", False)
        if type(fallback) is not bool:
            raise LibraryError("Choose whether to use the LRCLIB lyrics fallback.")
        studio = self.lyrics.studio
        with self.lock:
            with studio.lock:
                selection = self.lyrics._selection(body)
                context = (id(selection[0]), id(selection[1]), selection[2], body["session"])
                if context != self.context:
                    self.cache.clear()
                    self.context = context
                track = selection[3]
                if not track["title"].strip() or not track["artist"].strip() \
                        or len(track["title"]) > 200 or len(track["artist"]) > 200:
                    return _finish([], track["length"])
                fallback = fallback and "lrclib" not in studio.disabled_sources()
                key = json.dumps([selection[4], fallback])
                cached = self.cache.get(key)
                if cached and time.monotonic() < cached[0]:
                    return cached[1]
                if time.monotonic() < self.next_request:
                    raise SourceError("Please wait a moment before another Unison search.")
                self.next_request = time.monotonic() + 1
            try:
                result = fetch_unison(track, selection[4][-1])
                if result["status"] == "missing" and fallback:
                    def check_current():
                        with studio.lock:
                            if not self.lyrics._current(selection, body) \
                                    or "lrclib" in studio.disabled_sources():
                                raise ConflictError("The account, library or lyrics source changed.")
                    result = fetch_lrclib_display(track, selection[4][-1], check_current)
            except SourceError as error:
                self.next_request = time.monotonic() + getattr(error, "retry_after", 60)
                raise
            with studio.lock:
                if not self.lyrics._current(selection, body) \
                        or result.get("source") == "lrclib" and "lrclib" in studio.disabled_sources():
                    raise ConflictError("The account, library or source changed while reading online lyrics.")
                self.cache[key] = (time.monotonic() + 300, result)
                while len(self.cache) > 12:
                    self.cache.popitem(last=False)
            return result
