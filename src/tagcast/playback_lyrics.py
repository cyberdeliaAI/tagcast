"""Read-only, opt-in Unison/LRCLIB lyrics for Now playing. No disk writes.

Independent implementation of the documented Unison API and TTML/LRC formats;
no provider code or lyrics corpus is bundled. Audio and metadata saves stay separate.
"""

import json
import math
import re
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import OrderedDict

import requests
import yaml

from .library import ConflictError, LibraryError
from .sources import USER_AGENT, SourceError, artist_name_key

MAX_RESPONSE = 512000
MAX_TEXT = 50000
MAX_LINES = 2000
MAX_TIME = 86400
MAX_WORDS = 12000
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
    word_count = sum(len(line.get("words", [])) for line in lines)
    for line in lines:
        words = line.pop("words", None)
        if timed and word_count <= MAX_WORDS and _valid_words(words, line):
            line["words"] = words
    return {"status": "ready" if lines else "missing", "source": source,
            "timed": timed, "lines": lines}


def _valid_words(words, line):
    """Optional display segments; never invent words or lose the complete line."""
    if not isinstance(words, list) or not words or len(words) > 1000:
        return False
    if any(not isinstance(word, dict) or not isinstance(word.get("text"), str)
           or not word["text"] or "\x00" in word["text"] for word in words):
        return False
    if "".join(word["text"] for word in words) != line["text"]:
        return False
    starts = [word.get("start") for word in words]
    if any(type(start) not in (int, float) or not math.isfinite(start)
           or not line["start"] <= start <= line["end"] for start in starts) \
            or starts != sorted(starts):
        return False
    # Equal starts/overlapping segments are valid. Infer only absent end times.
    next_end, later = line["end"], None
    for word in reversed(words):
        if later is not None and word["start"] < later:
            next_end = later
        if word.get("end") is None:
            word["end"] = next_end
        end = word["end"]
        if type(end) not in (int, float) or not math.isfinite(end) \
                or not word["start"] <= end <= line["end"]:
            return False
        later = word["start"]
    return True


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
        content = raw[stamps.end():]
        markers = list(re.finditer(r"<(\d{1,3}:\d{2}(?:\.\d+)?)>", content))
        text = re.sub(r"<\d{1,3}:\d{2}(?:\.\d+)?>", "", content).strip()
        first_start = None
        # Blank timestamped lines mark instrumental breaks as well as the ending.
        for stamp in re.findall(r"\[([^]]+)\]", stamps[0]):
            stamp = re.sub(r"^(\d+:\d+):", r"\1.", stamp)
            start = lyric_time(stamp)
            if start is None:
                label = "LRCLIB" if source == "lrclib" else "Unison"
                raise SourceError(f"{label} returned invalid LRC timing.")
            if first_start is None:
                first_start = start
            line = {"start": max(0, start + offset), "end": None, "text": text}
            if markers and not content[:markers[0].start()].strip():
                words = []
                for i, marker in enumerate(markers):
                    word_start = lyric_time(marker[1])
                    word_text = content[marker.end():markers[i + 1].start() if i + 1 < len(markers) else len(content)]
                    if word_text:
                        words.append({"start": word_start + offset + start - first_start
                                      if word_start is not None else None,
                                      "end": None, "text": word_text})
                # A final empty marker supplies an explicit ending, not a word.
                if words and markers[-1].end() == len(content):
                    last = lyric_time(markers[-1][1])
                    words[-1]["end"] = last + offset + start - first_start if last is not None else None
                if words:
                    words[0]["text"] = words[0]["text"].lstrip()
                    words[-1]["text"] = words[-1]["text"].rstrip()
                line["words"] = words
            lines.append(line)
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
    pending = [(root, 0)]
    while pending:
        node, depth = pending.pop()
        if depth > 40:
            raise SourceError("Unison TTML is nested too deeply.")
        pending.extend((child, depth + 1) for child in node)
    # Apple lyric TTML uses absolute song times, including inside div/p elements.
    apple = any("itunes.apple.com" in name for node in nodes for name in node.attrib)
    lines = []

    def times(node, parent_start):
        begin = lyric_time(node.get("begin"))
        start = (begin if apple else parent_start + begin) if begin is not None else parent_start
        end = lyric_time(node.get("end"))
        if end is not None and not apple:
            end += parent_start
        length = lyric_time(node.get("dur"))
        if end is None and length is not None:
            end = start + length
        return begin, start, end

    def segments(node, parent_start, depth=0):
        if depth > 40:
            raise SourceError("Unison TTML is nested too deeply.")
        begin, start, end = times(node, parent_start)
        if any(node.get(key) is not None and lyric_time(node.get(key)) is None
               for key in ("begin", "end", "dur")):
            return [{"start": None, "end": None, "text": "".join(node.itertext())}]
        descendants = list(node.iter())[1:]
        if node.tag.rsplit("}", 1)[-1] == "span" and begin is not None \
                and not any(child.get("begin") is not None for child in descendants):
            return [{"start": start, "end": end, "text": "".join(node.itertext())}]
        parts = [{"start": None, "end": None, "text": node.text}] if node.text else []
        for child in node:
            parts.extend(segments(child, start, depth + 1))
            if child.tail:
                parts.append({"start": None, "end": None, "text": child.tail})
        return parts

    def visit(node, parent_start=0, depth=0):
        if depth > 40:
            raise SourceError("Unison TTML is nested too deeply.")
        begin, start, end = times(node, parent_start)
        if node.tag.rsplit("}", 1)[-1] == "p":
            for child in node.iter():
                if child.tag.rsplit("}", 1)[-1] == "br":
                    child.text = "\n"
            text = "".join(node.itertext()).strip()
            if text:
                words, prefix = [], ""
                for part in segments(node, parent_start):
                    if part["start"] is None and not part["text"].strip():
                        if words:
                            words[-1]["text"] += part["text"]
                        else:
                            prefix += part["text"]
                    else:
                        part["text"] = prefix + part["text"]
                        prefix = ""
                        words.append(part)
                if words:
                    words[0]["text"] = words[0]["text"].lstrip()
                    words[-1]["text"] = words[-1]["text"].rstrip()
                lines.append({"start": start if begin is not None else None,
                              "end": end, "text": text, "words": words})
            return
        for child in node:
            visit(child, start, depth + 1)

    visit(root)
    return _finish(lines, duration)


def _pause_lyrics(delay, check_current):
    """Short cancellable sleeps; no cache/library lock is held."""
    while delay > .00001:
        check_current()
        step = min(.05, delay)
        time.sleep(step)
        delay -= step
    check_current()


def _retry_after(value):
    # Keep the server's actual delay, including values longer than our lookup budget.
    # Such delays skip this provider; they never turn into long interactive sleeps.
    return int(value) if isinstance(value, str) and re.fullmatch(r"\d{1,10}", value) else 2


class _ProviderReader:
    """Bounded anonymous JSON reads with one short, explicitly requested retry."""

    def __init__(self, source, check_current, policy=None):
        self.source, self.check_current, self.policy = source, check_current, policy
        self.deadline, self.previous, self.retry_until = time.monotonic() + 12, 0, 0

    def read(self, session, url, params):
        label = "Unison" if self.source == "unison" else "LRCLIB"
        for attempt in range(2):
            self.check_current()
            delay = max(0, self.previous + .25 - time.monotonic(), self.retry_until - time.monotonic())
            if delay > 2 or time.monotonic() + delay >= self.deadline:
                error = SourceError(f"{label} is temporarily unavailable.")
                error.temporary, error.retry_after = True, delay
                raise error
            _pause_lyrics(delay, self.check_current)
            if self.policy:
                self.policy.before_request(self.source, self.check_current, self.deadline)
            self.check_current()
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise SourceError(f"{label} took too long. Try again later.")
            self.previous = time.monotonic()
            session.cookies.clear()
            with session.get(url, params=params,
                             timeout=(min(4, remaining), min(5, remaining)), stream=True,
                             allow_redirects=False) as response:
                self.check_current()
                if response.status_code == 404:
                    return None
                if response.status_code != 200:
                    error = SourceError(f"{label} is temporarily unavailable.")
                    error.temporary = response.status_code in (429, 500, 502, 503, 504)
                    error.retry_after = _retry_after(response.headers.get("Retry-After", ""))
                    if error.temporary:
                        self.retry_until = time.monotonic() + error.retry_after
                        if self.policy:
                            self.policy.defer(self.source, error.retry_after)
                    if response.status_code in (429, 503) and attempt == 0 \
                            and error.retry_after <= 2 and time.monotonic() + error.retry_after < self.deadline:
                        # Exit/close the response context before waiting and retrying.
                        continue
                    raise error
                if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise SourceError(f"{label} returned an invalid response.")
                chunks, size = [], 0
                for chunk in response.iter_content(16384):
                    self.check_current()
                    size += len(chunk)
                    if size > MAX_RESPONSE or time.monotonic() > self.deadline:
                        raise SourceError(f"{label} returned too much data or took too long.")
                    chunks.append(chunk)
                self.check_current()
                data = json.loads(b"".join(chunks))
                if not isinstance(data, (dict, list)):
                    raise SourceError(f"{label} returned an invalid response.")
                return data


def fetch_unison(track, album, check_current=lambda: None, policy=None):
    """Anonymous, bounded lookup. No cookies, account tokens or redirects."""
    params = {"song": track["title"], "artist": track["artist"], "album": album}
    duration = track["length"]
    if duration > 0:
        params["song"] = lyrics_title(track["title"]) or track["title"]
        params["duration"] = int(duration + .5)
    reader = _ProviderReader("unison", check_current, policy)
    try:
        with requests.Session() as session:
            session.trust_env = False
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
            data = reader.read(session, UNISON_URL, params)
    except (requests.RequestException, ValueError):
        raise SourceError("Unison could not be read. Try again later.") from None
    if data is None:
        return _finish([], duration)
    if not isinstance(data, dict) or data.get("success") is not True \
            or not isinstance(data.get("data"), dict):
        raise SourceError("Unison returned an invalid response.")
    data = data["data"]
    if any(not isinstance(data.get(key), str) for key in ("song", "artist", "lyrics")):
        raise SourceError("Unison returned invalid track details.")
    if not _lyrics_identity(data["song"], data["artist"], track, album, data.get("album")):
        return _finish([], duration)
    length = data.get("duration")
    # GET /lyrics applies the requested duration filter but omits it in its reply.
    if duration > 0 and "duration" in data and (type(length) not in (int, float) or not math.isfinite(length)
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


def lyrics_title(value):
    """Remove recognized release labels only; recording qualifiers remain identity."""
    def release_label(label):
        key = lyrics_name_key(label).strip()
        if re.search(r"\b(?:live|acoustic|remix|demo|instrumental)\b", key):
            return False
        if re.match(r"^(?:feat\.?|ft\.?|featuring)\s+\S", key):
            return True
        words = re.findall(r"\w+", key)
        allowed = {"remaster", "remastered", "version", "edition", "single", "album",
                   "mono", "stereo", "radio", "edit", "deluxe", "expanded", "anniversary",
                   "bonus", "track", "explicit", "clean"}
        return bool(words) and all(word in allowed or re.fullmatch(r"\d{4}|\d{1,3}(?:st|nd|rd|th)", word)
                                   for word in words)

    value = re.sub(r"\(([^()]*)\)|\[([^\[\]]*)\]",
                   lambda match: " " if release_label(match[1] or match[2] or "") else match[0], value)
    while True:
        parts = re.split(r"\s+[-–—]\s+", value)
        if len(parts) < 2 or not release_label(parts[-1]):
            break
        value = " - ".join(parts[:-1])
    return " ".join(value.split())


def _lyrics_letters(value):
    value = unicodedata.normalize("NFD", value.casefold())
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = unicodedata.normalize("NFC", value)
    return " ".join("".join(char for char in value if char.isalnum() or char.isspace()).split())


def _lyrics_credits(value):
    parts = re.split(r"\s*[,;&/×]\s*|\s+(?:and|x|feat\.?|ft\.?|featuring|with)\s+", value, flags=re.I)
    return [re.sub(r"^the\s+", "", key) for part in parts if (key := _lyrics_letters(part))]


def _lyrics_artists(left, right):
    """Whole credited names, or an entire consecutive credit run; no substrings."""
    left, right = _lyrics_credits(left), _lyrics_credits(right)
    if set(left) & set(right):
        return True
    for parts, other in ((left, right), (right, left)):
        for start in range(len(parts)):
            for end in range(start + 2, len(parts) + 1):
                run = " ".join(parts[start:end])
                if any(run == re.sub(r"\bthe\s+", "", name) for name in other):
                    return True
    return False


def _lyrics_identity(title, artist, track, album, returned_album):
    if not isinstance(title, str) or not isinstance(artist, str):
        return False
    if track["length"] > 0:
        key = _lyrics_letters(lyrics_title(title))
        return bool(key) and key == _lyrics_letters(lyrics_title(track["title"])) \
            and _lyrics_artists(artist, track["artist"])
    return lyrics_name_key(title) == lyrics_name_key(track["title"]) \
        and lyrics_name_key(artist) == lyrics_name_key(track["artist"]) \
        and bool(album.strip()) and lyrics_name_key(returned_album) == lyrics_name_key(album)


def _lrclib_match(data, track, album):
    if not isinstance(data, dict) or any(not isinstance(data.get(key), str)
                                         for key in ("trackName", "artistName")):
        return False
    if not _lyrics_identity(data["trackName"], data["artistName"], track, album, data.get("albumName")):
        return False
    length = data.get("duration")
    if type(length) not in (int, float) or not math.isfinite(length) or not 0 < length <= MAX_TIME:
        return False
    if track["length"] > 0:
        return abs(length - track["length"]) <= 2
    # Without a known duration, require a unique full album identity instead.
    return bool(album.strip()) and lyrics_name_key(data.get("albumName")) == lyrics_name_key(album)


class _LyricsfileLoader(yaml.SafeLoader):
    """Small, non-extensible YAML subset; no aliases, tags or duplicate keys."""

    def __init__(self, stream):
        super().__init__(stream)
        self.lyric_depth = self.lyric_nodes = 0

    def compose_node(self, parent, index):
        event = self.peek_event()
        self.lyric_nodes += 1
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None) \
                or self.lyric_depth >= 40 or self.lyric_nodes > 100000:
            raise ValueError("Unsupported or excessive Lyricsfile structure")
        self.lyric_depth += 1
        try:
            node = super().compose_node(parent, index)
        finally:
            self.lyric_depth -= 1
        if node.tag not in {"tag:yaml.org,2002:" + kind
                            for kind in ("map", "seq", "str", "int", "bool", "null")}:
            raise ValueError("Unsupported Lyricsfile value")
        return node

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError("Invalid or repeated Lyricsfile key")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def _lyricsfile_lines(value, data, duration):
    """Read the documented 1.0 draft only; unsupported documents use legacy LRC."""
    if not isinstance(value, str) or not value or len(value) > MAX_RESPONSE or "\x00" in value:
        return None
    try:
        document = yaml.load(value, Loader=_LyricsfileLoader)
        if not isinstance(document, dict) or document.get("version") != "1.0":
            return None
        meta = document.get("metadata")
        if not isinstance(meta, dict) or any(not isinstance(meta.get(key), str) for key in ("title", "artist")):
            return None
        if duration > 0:
            if not _lyrics_identity(meta["title"], meta["artist"], {
                    "title": data["trackName"], "artist": data["artistName"], "length": duration}, "", ""):
                return None
        elif any(lyrics_name_key(meta[key]) != lyrics_name_key(data.get(record))
                 for key, record in (("title", "trackName"), ("artist", "artistName"))):
            return None
        # The draft explicitly leaves offset semantics unresolved. Never guess.
        if type(meta.get("offset_ms", 0)) is not int or meta.get("offset_ms", 0) != 0:
            return None
        length = meta.get("duration_ms")
        if length is not None and (type(length) is not int or not 0 <= length <= MAX_TIME * 1000
                                   or abs(length / 1000 - data["duration"]) > 2):
            return None
        raw_lines = document.get("lines", [])
        if not isinstance(raw_lines, list) or len(raw_lines) > MAX_LINES:
            return None

        def segment(raw):
            if not isinstance(raw, dict) or not isinstance(raw.get("text"), str) \
                    or "\x00" in raw["text"] or len(raw["text"]) > MAX_TEXT:
                raise ValueError("Invalid Lyricsfile text")
            start, end = raw.get("start_ms"), raw.get("end_ms")
            if type(start) is not int or not 0 <= start <= MAX_TIME * 1000 \
                    or end is not None and (type(end) is not int or not start <= end <= MAX_TIME * 1000):
                raise ValueError("Invalid Lyricsfile timing")
            return {"text": raw["text"], "start": start / 1000,
                    "end": end / 1000 if end is not None else None}

        lines = []
        for raw in raw_lines:
            line = segment(raw)
            words = raw.get("words")
            if isinstance(words, list) and len(words) <= 1000:
                try:
                    line["words"] = [segment(word) for word in words]
                except ValueError:
                    pass  # A malformed optional word never removes its complete line.
            lines.append(line)
        if lines:
            return _finish(lines, duration, "lrclib")
        plain = document.get("plain", "")
        if not isinstance(plain, str) or "\x00" in plain or len(plain) > MAX_TEXT:
            return None
        return _finish([{"start": None, "end": None, "text": line}
                        for line in plain.splitlines()], duration, "lrclib")
    except (yaml.YAMLError, ValueError, SourceError):
        return None


def _lrclib_lines(data, duration):
    result = _finish([], duration, "lrclib")
    if data.get("instrumental") is True:
        return {**result, "status": "instrumental"}
    synced, plain = data.get("syncedLyrics"), data.get("plainLyrics")
    if any(value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT
                                  or "\x00" in value) for value in (synced, plain)):
        raise SourceError("LRCLIB returned invalid or oversized lyrics.")
    rich = _lyricsfile_lines(data.get("lyricsfile"), data, duration)
    if rich and rich["timed"]:
        return rich
    if synced and synced.strip():
        return parse_lrc(synced, duration, "lrclib")
    if rich and rich["status"] == "ready":
        return rich
    return _finish([{"start": None, "end": None, "text": line}
                    for line in (plain or "").splitlines()], duration, "lrclib")


def fetch_lrclib_display(track, album, check_current, policy=None):
    """Search the database first; use exact get only without a usable candidate."""
    reader = _ProviderReader("lrclib", check_current, policy)
    params = {"track_name": track["title"], "artist_name": track["artist"]}
    if album.strip():
        params["album_name"] = album
    if 1 <= track["length"] <= 3600:
        params["duration"] = track["length"]
    variants = [(track["title"], track["artist"]),
                (lyrics_name_key(track["title"]), lyrics_name_key(track["artist"]))]
    if track["length"] > 0:
        # One bounded extra query; local identity/duration checks still decide the hit.
        primary = re.split(r"\s*[,;&/×]\s*|\s+(?:and|x|feat\.?|ft\.?|featuring|with)\s+",
                           track["artist"], maxsplit=1, flags=re.I)[0].strip()
        variants.append((lyrics_title(track["title"]) or track["title"], primary))
    seen, candidates, errors = set(), [], []

    def candidate_result():
        if track["length"] <= 0 and len(candidates) != 1:
            return None
        candidates.sort(key=lambda hit: (abs(hit["duration"] - track["length"]),
                        not bool(hit.get("syncedLyrics") or hit.get("hasWordSync")),
                        lyrics_name_key(hit.get("albumName")) != lyrics_name_key(album)))
        for hit in candidates:
            check_current()
            try:
                result = _lrclib_lines(hit, track["length"])
                if result["status"] != "missing":
                    return result
            except SourceError:
                continue  # Invalid timing/text invalidates one candidate, not its siblings.
        return None

    try:
        with requests.Session() as session:
            session.trust_env = False
            session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
            for title, artist in variants:
                query = (title.casefold(), artist.casefold())
                if query in seen:
                    continue
                seen.add(query)
                try:
                    hits = reader.read(session, LRCLIB_URL + "search", {"track_name": title, "artist_name": artist})
                except SourceError as error:
                    if not getattr(error, "temporary", False):
                        raise
                    errors.append(error)
                    continue
                if hits is None:
                    hits = []
                if not isinstance(hits, list) or len(hits) > 100:
                    raise SourceError("LRCLIB returned invalid search results.")
                for hit in hits:
                    if _lrclib_match(hit, track, album) and hit not in candidates:
                        candidates.append(hit)
            result = candidate_result()
            if result:
                return result
            # Ambiguous unknown-duration database results must not be narrowed by /get.
            if track["length"] <= 0 and len(candidates) > 1:
                return _finish([], 0, "lrclib")
            try:
                data = reader.read(session, LRCLIB_URL + "get", params)
            except SourceError as error:
                if not getattr(error, "temporary", False):
                    raise
                errors.append(error)
                data = None
            if data is not None and (not isinstance(data, dict)
                                     or any(not isinstance(data.get(key), str)
                                            for key in ("trackName", "artistName"))):
                raise SourceError("LRCLIB returned an invalid response.")
            if _lrclib_match(data, track, album):
                candidates[:] = [data]
                result = candidate_result()
                if result:
                    return result
            if errors:
                raise errors[-1]
    except LibraryError:
        raise
    except (requests.RequestException, ValueError):
        raise SourceError("LRCLIB could not be read. Try again later.") from None
    return _finish([], track["length"], "lrclib")


class PlaybackLyrics:
    """Bounded RAM results, newest-selection wins; network work never holds a lock."""

    def __init__(self, lyrics):
        self.lyrics = lyrics
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.context = None
        self.revision = 0
        self.active = None
        self.backoff = {"unison": 0, "lrclib": 0}
        self.spacing = {"unison": 0, "lrclib": 0}

    def defer(self, source, delay):
        with self.lock:
            self.backoff[source] = max(self.backoff[source], time.monotonic() + delay)

    def before_request(self, source, check_current, deadline):
        check_current()
        with self.lock:
            now = time.monotonic()
            if now < self.backoff[source]:
                error = SourceError(f"{source} is temporarily unavailable.")
                error.temporary, error.retry_after = True, self.backoff[source] - now
                raise error
            when = max(now, self.spacing[source])
            self.spacing[source] = when + .25
        if when >= deadline:
            raise SourceError("Online lyrics took too long. Try again later.")
        _pause_lyrics(when - now, check_current)

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
                fallback = fallback and "lrclib" not in studio.disabled_sources()
            if context != self.context:
                self.cache.clear()
                self.context = context
                self.revision += 1
            track = selection[3]
            if not track["title"].strip() or not track["artist"].strip() \
                    or len(track["title"]) > 200 or len(track["artist"]) > 200:
                self.revision += 1
                if self.active:
                    self.active["event"].set()
                    self.active = None
                return _finish([], track["length"])
            key = json.dumps([selection[4], fallback])
            pending = self.active
            owner = not pending or pending["key"] != key or pending["context"] != context
            if owner:
                self.revision += 1
                if pending:
                    pending["event"].set()  # Release waiters for a superseded selection.
                pending = {"key": key, "context": context, "revision": self.revision,
                           "event": threading.Event(), "result": None, "error": None}
                self.active = pending
            cached = self.cache.get(key)
            if cached and time.monotonic() < cached[0]:
                if owner:
                    self.active = None
                return cached[1]

        def check_locked(source=None):
            if self.context != context or self.revision != pending["revision"]:
                raise ConflictError("The requested lyrics track changed.")
            with studio.lock:
                if not self.lyrics._current(selection, body) \
                        or source == "lrclib" and "lrclib" in studio.disabled_sources():
                    raise ConflictError("The account, library or lyrics source changed.")

        def check_current(source=None):
            with self.lock:
                check_locked(source)

        if not owner:
            deadline = time.monotonic() + 30
            while not pending["event"].wait(.05):
                check_current()
                if time.monotonic() >= deadline:
                    raise SourceError("Online lyrics are still being checked. Try again later.")
            check_current()
            if pending["error"]:
                raise pending["error"]
            return pending["result"]

        try:
            result, unavailable = _finish([], track["length"]), []
            for source in (["unison", "lrclib"] if fallback else ["unison"]):
                check_current(source)
                with self.lock:
                    blocked = time.monotonic() < self.backoff[source]
                if blocked:
                    unavailable.append(source)
                    continue
                try:
                    def current(source=source):
                        check_current(source)
                    result = (fetch_unison(track, selection[4][-1], current, self) if source == "unison"
                              else fetch_lrclib_display(track, selection[4][-1], current, self))
                    check_current(source)
                    if result["status"] in ("ready", "instrumental"):
                        break
                except SourceError as error:
                    check_current(source)
                    self.defer(source, getattr(error, "retry_after", 2))
                    unavailable.append(source)
            check_current(result.get("source"))
            if result["status"] == "missing" and unavailable:
                result = {**result, "status": "unavailable", "message":
                          "Online lyrics are temporarily unavailable. You can check again."}
            with self.lock:
                check_locked(result.get("source"))
                if result["status"] != "unavailable":
                    self.cache[key] = (time.monotonic() + 300, result)
                    while len(self.cache) > 12:
                        self.cache.popitem(last=False)
                pending["result"] = result
            return result
        except Exception as error:
            pending["error"] = error
            raise
        finally:
            with self.lock:
                if self.active is pending:
                    self.active = None
                pending["event"].set()
