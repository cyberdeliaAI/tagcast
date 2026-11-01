"""Filesystem-safe audio download engine adapted from ibfetch 1.3.1.

Source: https://github.com/cyberdeliaAI/ibfetch, commit 3691d75.
Copyright (c) 2026 Cyberdelia. MIT licensed; see src/tagcast/static/licenses/ibfetch.txt.
Only the transfer, naming and file-integrity engine is included. Tagcast owns
connection state, credentials, selection, review and the user interface.
"""

import errno
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from http.client import HTTPException
from pathlib import Path

QUALITIES = ("orig", "320", "256", "192", "128", "96")


DEFAULT_LAYOUT = "{albumartist}/{album} ({year})/{disctrack} {title}"


CHUNK = 256 * 1024


SOURCES = ("download", "stream")


MIME_EXT = {
    "audio/flac": "flac", "audio/x-flac": "flac", "audio/mpeg": "mp3", "audio/mp3": "mp3",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac",
    "audio/ogg": "ogg", "audio/vorbis": "ogg", "audio/opus": "opus", "audio/x-ms-wma": "wma",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/aiff": "aiff",
    "audio/x-aiff": "aiff", "audio/ape": "ape", "audio/x-ape": "ape", "audio/x-wavpack": "wv",
    "audio/dsf": "dsf", "audio/x-dsf": "dsf",
}


FORMAT_NAMES = {"mp3": "MP3", "flac": "FLAC", "m4a": "M4A", "aac": "AAC", "ogg": "OGG",
                "opus": "OPUS", "wma": "WMA", "wav": "WAV", "aiff": "AIFF", "ape": "APE",
                "wv": "WV", "dsf": "DSF"}


class Fail(Exception):
    """A problem to report to the user without a traceback."""


class TerminalTransferError(Fail):
    """Stop this batch: credentials, TLS or a local prerequisite must be fixed."""


class TransferStopped(Fail):
    """Cancellation is not a failed file."""


def text(value):
    return "" if value is None else str(value)


def number(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


def fold(value):
    """Compare without case, accents or extra spacing ("Björk" matches "bjork")."""
    value = unicodedata.normalize("NFKD", text(value))
    value = "".join(c for c in value if not unicodedata.combining(c))
    return " ".join(value.casefold().split())


def size(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.0f} {unit}" if unit == "B" else f"{nbytes:.1f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"


RESERVED = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')


WINDOWS_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
                 *(f"lpt{i}" for i in range(1, 10))}


def safe_name(value, limit=150):
    """One path component that works on Linux, macOS and Windows."""
    value = RESERVED.sub("_", text(value))
    value = " ".join(value.split())
    if len(value.encode("utf-8")) > limit:
        value = value.encode("utf-8")[:limit].decode("utf-8", "ignore").rstrip()
    value = value.rstrip(". ")
    if value.startswith("."):
        value = "_" + value[1:]
    if value.split(".")[0].casefold() in WINDOWS_NAMES:
        value += "_"
    return value or "_"


def write_private(path, data):
    if isinstance(path, DownloadRecord):
        path.write_bytes(data)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def read_object(path):
    """Local JSON must be an object; damaged or unrelated files are not trusted."""
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def status_of(response):
    return getattr(response, "status", None) or response.getcode()


NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError, OSError, HTTPException)


def textual(response):
    """True for an error page or API answer rather than file data."""
    kind = (response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    return (kind.startswith("text/") or kind in ("application/json", "application/xml", "application/xhtml+xml")
            or kind.endswith("+json"))


class ServiceError(Exception):
    """The download service could not deliver a track. retry: a new request may succeed."""

    def __init__(self, message, retry=False):
        super().__init__(message)
        self.retry = retry


class Table:
    """An iBroadcast library table. Rows stay compact lists, read through the field map."""

    def __init__(self, raw):
        raw = raw if isinstance(raw, dict) else {}
        mapping = raw.get("map") if isinstance(raw.get("map"), dict) else {}
        self.fields = {k: v for k, v in mapping.items() if type(v) is int and v >= 0}
        self.rows = {int(k): v for k, v in raw.items()
                     if str(k).isdigit() and isinstance(v, (list, dict))}

    def get(self, row_id, field, default=None):
        row = self.rows.get(row_id)
        if row is None:
            return default
        if isinstance(row, dict):
            return row.get(field, default)
        index = self.fields.get(field)
        if index is None or index >= len(row):
            return default
        return row[index]

    def __contains__(self, row_id):
        return row_id in self.rows

    def __iter__(self):
        return iter(self.rows)


class Library:
    def __init__(self, response, user_id, premium):
        raw = response.get("library", response)
        if not isinstance(raw, dict) or not all(k in raw for k in ("tracks", "albums", "artists")):
            raise Fail("iBroadcast didn't return a complete library. Try again with --refresh.")
        self.artists = Table(raw["artists"])
        self.albums = Table(raw["albums"])
        self.tracks = Table(raw["tracks"])
        self.playlists = Table(raw.get("playlists"))
        self.tags = Table(raw.get("tags"))
        self.expires = text(raw.get("expires"))
        self.user_id = user_id
        self.premium = premium
        self.username = ""
        self._discs = None
        self.plan_lock = threading.Lock()
        self._album_members = self._default_directories = None
        self._path_plans = {}

    def artist_name(self, artist_id):
        return text(self.artists.get(number(artist_id), "name"))

    def album_artist(self, album_id):
        return self.artist_name(self.albums.get(album_id, "artist_id")) or "Unknown Artist"

    def album_title(self, album_id):
        return text(self.albums.get(album_id, "name")) or "Unknown Album"

    def album_year(self, album_id, track_id=None):
        year = number(self.albums.get(album_id, "year"))
        if not year and track_id is not None:
            year = number(self.tracks.get(track_id, "year"))
        return year

    def disc(self, album_id):
        return number(self.albums.get(album_id, "disc")) or 1

    def multi_disc(self, album_id):
        """True when the same artist has more than one disc of this album title."""
        if self._discs is None:
            discs = {}
            for i in self.albums:
                if self.albums.get(i, "trashed"):
                    continue
                key = (number(self.albums.get(i, "artist_id")), fold(self.albums.get(i, "name")))
                discs.setdefault(key, set()).add(self.disc(i))
            self._discs = discs
        key = (number(self.albums.get(album_id, "artist_id")), fold(self.albums.get(album_id, "name")))
        return len(self._discs.get(key, ())) > 1 or self.disc(album_id) > 1

    def mime(self, track_id):
        return text(self.tracks.get(track_id, "type")).strip().lower()

    def format_name(self, track_id):
        mime = self.mime(track_id)
        ext = MIME_EXT.get(mime) or mime.split("/")[-1].replace("x-", "")
        return FORMAT_NAMES.get(ext, ext.upper() or "?")

    def genres(self, track_id):
        out = [text(self.tracks.get(track_id, "genre"))]
        extra = self.tracks.get(track_id, "genres_additional")
        if isinstance(extra, list):
            out += [text(g) for g in extra]
        return [g for g in out if g.strip()]

    def active(self, track_id):
        if self.tracks.get(track_id, "trashed"):
            return False
        album_id = number(self.tracks.get(track_id, "album_id"))
        return not self.albums.get(album_id, "trashed")


def sort_groups(lib, picked):
    """[(album_id, [track_id, ...]), ...] by artist, album and disc, tracks in album order."""
    def album_key(album_id):
        return (fold(lib.album_artist(album_id)), fold(lib.album_title(album_id)),
                lib.album_year(album_id), lib.disc(album_id), album_id)

    def track_key(track_id):
        return (number(lib.tracks.get(track_id, "track")) or 9999, fold(lib.tracks.get(track_id, "title")), track_id)

    return [(a, sorted(set(picked[a]), key=track_key)) for a in sorted(picked, key=album_key)]


class Layout:
    FIELDS = ("albumartist", "album", "year", "disc", "track", "disctrack", "title", "artist", "genre", "format")

    def __init__(self, template):
        template = template.replace("\\", "/").strip("/")
        try:
            template.format(**{f: "" for f in self.FIELDS})
        except (KeyError, IndexError, ValueError) as error:
            raise Fail(f"Unknown field in --layout: {error}. Use: {', '.join('{' + f + '}' for f in self.FIELDS)}") from None
        self.template = template

    def relpath(self, lib, album_id, track_id, ext):
        track_no = number(lib.tracks.get(track_id, "track"))
        disc = lib.disc(album_id)
        tn = f"{track_no:02}" if track_no else ""
        values = {
            "albumartist": lib.album_artist(album_id), "album": lib.album_title(album_id),
            "year": lib.album_year(album_id, track_id) or "", "disc": disc, "track": tn,
            "disctrack": f"{disc}-{tn}" if tn and lib.multi_disc(album_id) else tn,
            "title": text(lib.tracks.get(track_id, "title")) or f"Track {track_id}",
            "artist": lib.artist_name(lib.tracks.get(track_id, "artist_id")) or lib.album_artist(album_id),
            "genre": (lib.genres(track_id) or ["Unknown Genre"])[0], "format": lib.format_name(track_id),
        }
        values = {k: safe_name(v, 400) if isinstance(v, str) and v else v for k, v in values.items()}
        parts = []
        for part in self.template.format(**values).split("/"):
            part = re.sub(r"\s*\(\s*\)|\s*\[\s*\]", "", part)  # drop "()" left by an unknown year
            part = re.sub(r"^\s*[-.]\s+", "", part)
            parts.append(safe_name(part))
        parts[-1] = safe_name(parts[-1], 150 - len(ext) - 1) + "." + ext
        return Path(*parts)


def stream_path(lib, track_id, quality):
    path = text(lib.tracks.get(track_id, "file"))
    if not path.startswith("/"):
        return None
    if re.match(r"^/(?:96|128|192|256|320|orig)/", path):
        path = re.sub(r"^/[^/]+/", f"/{quality}/", path, count=1)
    return path


def extension(lib, track_id, quality):
    if quality != "orig":
        return "mp3"
    mime = lib.mime(track_id)
    ext = MIME_EXT.get(mime) or re.sub(r"[^a-z0-9]", "", mime.split("/")[-1].replace("x-", ""))
    return ext or "audio"


def plan_jobs(lib, groups, quality, layout, stop=None):
    """Reuse snapshot-local indexes; default layouts only name relevant albums."""
    def cancelled():
        if stop is not None and stop.is_set():
            raise Fail("Download preparation stopped.")

    cancelled()
    with lib.plan_lock:
        cancelled()
        if layout.template == DEFAULT_LAYOUT:
            if lib._album_members is None:
                members = {}
                for track_id in lib.tracks:
                    cancelled()
                    if lib.active(track_id):
                        album_id = number(lib.tracks.get(track_id, "album_id"))
                        members.setdefault(album_id, []).append(track_id)
                lib._album_members = members
            if lib._default_directories is None:
                directories = {}
                for album_id, tracks in lib._album_members.items():
                    cancelled()
                    samples = {}
                    if lib.album_year(album_id):
                        samples[lib.album_year(album_id)] = tracks[0]
                    else:
                        for tid in tracks:
                            samples.setdefault(lib.album_year(album_id, tid), tid)
                    for tid in samples.values():
                        parent = layout.relpath(lib, album_id, tid, "audio").parent
                        directories.setdefault(fold(str(parent)), set()).add(album_id)
                lib._default_directories = directories
            parents = {fold(str(layout.relpath(lib, a, t, "audio").parent))
                       for a, tracks in groups for t in tracks}
            album_ids = set()
            for parent in parents:
                album_ids.update(lib._default_directories.get(parent, ()))
            track_ids = [t for a in album_ids for t in lib._album_members[a]]
            cache_key = (quality, layout.template, tuple(sorted(parents)))
        else:
            # Arbitrary flat/cross-album templates need a global collision map once.
            track_ids, parents = None, None
            cache_key = (quality, layout.template)
        paths = lib._path_plans.get(cache_key)
        if paths is None:
            paths = _plan_paths(lib, quality, layout, track_ids, parents, cancelled)
            if len(lib._path_plans) >= 4:
                lib._path_plans.pop(next(iter(lib._path_plans)))
            lib._path_plans[cache_key] = paths
    cancelled()
    return [(paths[t], stream_path(lib, t, quality), t) for _, tracks in groups for t in tracks]


def _plan_paths(lib, quality, layout, track_ids, parents, cancelled):
    candidates = {}
    counts = {}
    for track_id in (lib.tracks if track_ids is None else track_ids):
        cancelled()
        if not lib.active(track_id):
            continue
        album_id = number(lib.tracks.get(track_id, "album_id"))
        rel = layout.relpath(lib, album_id, track_id, extension(lib, track_id, quality))
        if parents is not None and fold(str(rel.parent)) not in parents:
            continue
        if quality != "orig":
            rel = rel.with_name(f"{rel.stem} [{quality}kbps]{rel.suffix}")
        candidates[track_id] = rel
        key = fold(str(rel))
        counts[key] = counts.get(key, 0) + 1
    reserved, seen, paths = set(counts), set(), {}
    for track_id in sorted(candidates):
        cancelled()
        rel = candidates[track_id]
        if counts[fold(str(rel))] > 1:
            base, attempt = rel, 1
            while True:
                suffix = str(track_id) if attempt == 1 else f"{track_id}-{attempt}"
                rel = base.with_name(f"{base.stem} [{suffix}]{base.suffix}")
                if fold(str(rel)) not in reserved and fold(str(rel)) not in seen:
                    break
                attempt += 1
        seen.add(fold(str(rel)))
        paths[track_id] = rel
    return paths


def file_hasher(path):
    """SHA-256 state of a file's current contents, so appending can continue it."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return digest


def file_digest(path):
    return file_hasher(path).hexdigest()


def resolve_source(source, quality):
    """The download service has original files only; MP3 bitrates always stream."""
    if source in (None, "", "auto"):
        return "download" if quality == "orig" else "stream"
    if source not in SOURCES:
        raise Fail("Use download or stream as the source.")
    if source == "download" and quality != "orig":
        raise Fail("iBroadcast's download service only delivers original files. Use the stream source for MP3 bitrates.")
    return source


ZIP_TAIL = 64 * 1024  # held back while copying: the archive's directory and end marker follow the audio


EXTENSION_ALIASES = {".aif": ".aiff", ".wave": ".wav", ".oga": ".ogg", ".mp4": ".m4a"}


def copy_zip_entry(response, f, digest, suffix, stop, on_progress=None):
    """Copy the one stored file of a streamed single-track ZIP into f while hashing it.

    iBroadcast streams the archive: sizes and CRC-32 follow the data, then the central
    directory and the end marker. The last ZIP_TAIL bytes are held back until the end so
    only audio is written. Returns the audio length, or None when stopped. Raises
    ServiceError for an unexpected or incomplete archive.
    """
    chunks = iter(lambda: response.read(CHUNK), b"")
    buf = bytearray()

    def need(n):
        while len(buf) < n:
            chunk = next(chunks, None)
            if chunk is None:
                raise ServiceError("the download service's ZIP ended early", retry=True)
            buf.extend(chunk)

    need(30)
    sig, _, flags, method, _, _, crc, csize, _, nlen, xlen = struct.unpack("<IHHHHHIIIHH", bytes(buf[:30]))
    if sig != 0x04034B50:
        raise ServiceError("the download service didn't return a ZIP archive")
    if method != 0 or flags & 1:
        raise ServiceError("the download service returned a compressed or encrypted ZIP entry")
    need(30 + nlen + xlen)
    raw_name = bytes(buf[30:30 + nlen])
    name = raw_name.decode("utf-8" if flags & 0x800 else "cp437", "replace")
    archived_suffix = Path(name.replace("\\", "/")).suffix.lower()
    if EXTENSION_ALIASES.get(archived_suffix, archived_suffix) != EXTENSION_ALIASES.get(suffix.lower(), suffix.lower()):
        raise ServiceError(f"the download service returned {Path(name).suffix or 'a file without extension'}, "
                           f"not {suffix}")
    start = 30 + nlen + xlen
    del buf[:start]
    written, crc_now = 0, 0
    first = True
    while True:
        chunk = b"" if first else next(chunks, None)
        first = False
        if chunk is None:
            break
        if stop.is_set():
            return None
        buf.extend(chunk)
        if len(buf) > ZIP_TAIL:
            data = bytes(buf[:-ZIP_TAIL])
            del buf[:-ZIP_TAIL]
            f.write(data)
            digest.update(data)
            crc_now = zlib.crc32(data, crc_now)
            written += len(data)
            if on_progress:
                on_progress(written, 0, len(data))

    tail = bytes(buf)
    if not tail.endswith(b"EOF\n"):
        raise ServiceError("the download service stopped before its end marker", retry=True)
    tail = tail[:-4]
    end = tail.rfind(b"PK\x05\x06")
    if end < 0 or len(tail) - end < 22:
        raise ServiceError("the download service's ZIP has no directory", retry=True)
    _, disk, cd_disk, here, total, cd_size, cd_offset, comment = struct.unpack("<IHHHHIIH", tail[end:end + 22])
    if end + 22 + comment != len(tail) or disk or cd_disk:
        raise ServiceError("the download service returned an unexpected ZIP layout")
    if here != 1 or total != 1:
        raise ServiceError("the download service returned more than one file")
    cd = cd_offset - (start + written)  # tail-relative position of the central directory
    if cd_offset == 0xFFFFFFFF or cd < 0 or cd + cd_size != end or cd_size < 46:
        raise ServiceError("the download service returned an unexpected ZIP layout")
    (csig, _, _, _, cmethod, _, _, ccrc, ccsize, cusize, cnlen, _, _, _, _, _,
     local) = struct.unpack("<IHHHHHHIIIHHHHHII", tail[cd:cd + 46])
    if csig != 0x02014B50 or cmethod != 0 or local != 0 or ccsize != cusize or tail[cd + 46:cd + 46 + cnlen] != raw_name:
        raise ServiceError("the download service's ZIP directory doesn't match its file")
    data_end = cd
    if flags & 8:  # a data descriptor follows the data, with or without its signature
        for size_of in (16, 12):
            fields = tail[cd - 12:cd] if cd >= size_of else b""
            signed = size_of == 12 or tail[cd - 16:cd - 12] == b"PK\x07\x08"
            if len(fields) == 12 and signed and struct.unpack("<III", fields) == (ccrc, ccsize, cusize):
                data_end = cd - size_of
                break
        else:
            raise ServiceError("the download service's ZIP sizes don't match", retry=True)
    elif (crc, csize) != (ccrc, ccsize):
        raise ServiceError("the download service's ZIP sizes don't match", retry=True)
    data = tail[:data_end]
    f.write(data)
    digest.update(data)
    crc_now = zlib.crc32(data, crc_now)
    written += len(data)
    if on_progress and data:
        on_progress(written, 0, len(data))
    if written != ccsize or crc_now != ccrc:
        raise ServiceError("the downloaded file failed the ZIP's CRC-32 check", retry=True)
    return written


class TargetBusy(Fail):
    pass


LOCK_ERRORS = (errno.EACCES, errno.EAGAIN, errno.EDEADLK)


_enforced_lock_dirs = set()


_enforced_guard = threading.Lock()


def check_lock_enforcement(directory):
    """Refuse lock directories where a second flock is silently granted, as on macOS SMB shares."""
    if os.name == "nt":
        return
    import fcntl
    key = str(directory)
    with _enforced_guard:
        if key in _enforced_lock_dirs:
            return
        probe = str(directory / "probe.lock")
        first = os.open(probe, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            second = os.open(probe, os.O_RDWR)
            try:
                try:
                    fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as error:
                    if error.errno not in LOCK_ERRORS:
                        raise
                    # Another ibfetch process holds the probe: that is enforcement too.
                else:
                    try:
                        fcntl.flock(second, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError as error:
                        if error.errno not in LOCK_ERRORS:
                            raise
                    else:
                        raise Fail(f"File locks are not enforced in {directory}. "
                                   "Keep ibfetch's settings folder on a local disk.")
                    finally:
                        fcntl.flock(first, fcntl.LOCK_UN)
            finally:
                os.close(second)
        finally:
            os.close(first)
        _enforced_lock_dirs.add(key)


@contextmanager
def target_lock(out, rel, stop=None, locks=None):
    """At most 4096 OS-owned slots in a local lock folder; collisions serialize, never unlink.

    Locks live in ibfetch's own settings folder, not beside the audio: network shares
    can grant every flock silently, which would protect nothing.
    """
    if locks is None:
        raise ValueError("target_lock needs ibfetch's local lock folder")
    directory = Path(locks)
    directory.mkdir(parents=True, exist_ok=True)
    check_lock_enforcement(directory)
    key = hashlib.sha256(fold(str((out / rel).resolve())).encode()).hexdigest()[:3]
    fd = os.open(str(directory / ("slot-" + key + ".lock")), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in LOCK_ERRORS:
                    raise
                if stop is None or stop.wait(0.1):
                    raise TargetBusy("another download owns this lock slot; wait for it to finish") from None
        try:
            yield
        finally:
            if os.name == "nt":
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def lock_folder(home):
    return Path(home) / "locks"


MANIFEST_NAME = ".ibfetch.json"


_migrated_record_dirs = set()


class DownloadRecord:
    """One logical record in a folder's atomic manifest, guarded by local OS locks."""

    def __init__(self, audio, locks, partial=False):
        self.audio = Path(audio)
        self.locks = Path(locks)
        self.partial = partial
        self.manifest = self.audio.parent / MANIFEST_NAME
        self.section = "partials" if partial else "files"
        self.legacy = self.audio.with_name(self.audio.name + (".part" if partial else "") + ".ibfetch.json")

    def __eq__(self, other):
        return (isinstance(other, DownloadRecord) and self.audio == other.audio
                and self.locks == other.locks and self.partial == other.partial)

    @contextmanager
    def _locked(self):
        # Separate slot namespace: a target must never deadlock on its own slot.
        with target_lock(self.audio.parent, Path(MANIFEST_NAME), threading.Event(), self.locks / "manifests"):
            yield

    def _load(self):
        try:
            data = json.loads(self.manifest.read_text("utf-8"))
        except FileNotFoundError:
            data = {"version": 1, "files": {}, "partials": {}}
        except (OSError, ValueError) as error:
            raise Fail(f"Cannot read download records in {self.manifest}; preserved ({error.__class__.__name__}).") from None
        if (not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1
                or not isinstance(data.get("files"), dict) or not isinstance(data.get("partials"), dict)
                or any(not isinstance(v, dict) for section in ("files", "partials") for v in data[section].values())):
            raise Fail(f"Invalid download records in {self.manifest}; preserved. Restore the manifest before downloading here.")
        key = str(self.audio.parent.resolve())
        candidates = list(self.audio.parent.glob("*.ibfetch.json")) if key not in _migrated_record_dirs else [self.legacy]
        imported = []
        for path in candidates:
            if path == self.manifest or not path.is_file():
                continue
            raw = path.read_bytes()
            try:
                record = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError):
                continue
            identity = record.get("identity") if isinstance(record, dict) else None
            if (not isinstance(identity, dict) or type(identity.get("version")) is not int or identity["version"] != 1
                    or not isinstance(identity.get("user_id"), str)
                    or type(identity.get("track_id")) is not int or identity["track_id"] <= 0
                    or identity.get("quality") not in QUALITIES or not isinstance(identity.get("source"), str)):
                continue
            name = path.name[:-len(".ibfetch.json")]
            partial = name.endswith(".part") and (record.get("completed") is True or "size" not in record)
            if not partial or record.get("completed") is True:
                if (type(record.get("size")) is not int or record["size"] <= 0
                        or not isinstance(record.get("sha256"), str)
                        or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])):
                    continue
            section, name = ("partials", name[:-5]) if partial else ("files", name)
            if name in data[section] and data[section][name] != record:
                if section == self.section and name == self.audio.name:
                    raise Fail(f"Conflicting legacy download record for {self.audio.name}; both records preserved.")
                continue
            data[section][name] = record
            imported.append((path, raw))
        if imported:
            self._save(data)
            # A crash here is safe: the next pass sees identical duplicate records.
            for path, raw in imported:
                if path.read_bytes() == raw:
                    path.unlink()
        _migrated_record_dirs.add(key)
        return data

    def _save(self, data):
        if not data["files"] and not data["partials"]:
            try:
                self.manifest.unlink()
            except FileNotFoundError:
                pass
            return
        write_private(self.manifest, json.dumps(data, ensure_ascii=False).encode("utf-8"))
        if os.name == "nt":
            import ctypes
            attributes = ctypes.windll.kernel32.GetFileAttributesW(str(self.manifest))
            if attributes != -1:
                ctypes.windll.kernel32.SetFileAttributesW(str(self.manifest), attributes | 2)

    def exists(self):
        with self._locked():
            return self.audio.name in self._load()[self.section]

    def read_text(self, encoding="utf-8"):
        with self._locked():
            data = self._load()[self.section]
            if self.audio.name not in data:
                raise FileNotFoundError(str(self.manifest))
            return json.dumps(data[self.audio.name], ensure_ascii=False)

    def read_bytes(self):
        return self.read_text().encode("utf-8")

    def write_bytes(self, raw):
        record = json.loads(raw.decode("utf-8"))
        if not isinstance(record, dict):
            raise Fail("A download record must be an object.")
        with self._locked():
            data = self._load()
            data[self.section][self.audio.name] = record
            self._save(data)

    def write_text(self, value, encoding="utf-8"):
        self.write_bytes(value.encode(encoding))

    def unlink(self):
        with self._locked():
            data = self._load()
            if self.audio.name not in data[self.section]:
                raise FileNotFoundError(str(self.manifest))
            del data[self.section][self.audio.name]
            self._save(data)


def work_root(work, out):
    """Each download folder gets its own subfolder inside the work folder."""
    return Path(work) / hashlib.sha256(fold(str(Path(out).resolve())).encode()).hexdigest()[:16]


def check_work_folder(work, out):
    work_path, out_path = Path(work).resolve(), Path(out).resolve()
    if work_path == out_path or work_path in out_path.parents or out_path in work_path.parents:
        raise Fail("Use a work folder outside the download folder.")
    work_path.mkdir(parents=True, exist_ok=True)


def fetch_track(session, lib, out, rel, path, track_id, stop, on_progress=None, quality="orig",
                verify=False, adopt_existing=False, locks=None, work=None, source="stream"):
    """source: "download" for iBroadcast's download service, "stream" for the streaming server."""
    if source not in SOURCES or (source == "download" and quality != "orig"):
        raise ValueError("the download service only provides original files")
    try:
        with target_lock(out, rel, stop, locks):
            if work:
                return _fetch_via_work(session, lib, out, rel, path, track_id, stop, on_progress,
                                       quality, verify, adopt_existing, Path(work), locks, source)
            return _fetch_track(session, lib, out, rel, path, track_id, stop, on_progress,
                                quality, verify, adopt_existing, locks, source)
    except TargetBusy as error:
        if stop.is_set():
            return "stopped", 0, ""
        return "fail", 0, str(error)


def _same_track(record, lib, track_id, quality):
    recorded = record.get("identity")
    return (isinstance(recorded, dict) and recorded.get("user_id") == text(lib.user_id)
            and recorded.get("track_id") == track_id and recorded.get("quality") == quality)


def record_note(record):
    """Only our saved fallback notice is a success note; other text never authorizes a move."""
    note = record.get("note")
    return note if isinstance(note, str) and note.startswith("Fallback:") else ""


def _fetch_via_work(session, lib, out, rel, path, track_id, stop, on_progress, quality,
                    verify, adopt_existing, work, locks, source="stream"):
    """Download into a local work folder, then move each complete, hashed file to out."""
    target = out / rel
    local_out = work_root(work, out)
    local = local_out / rel
    local_record = DownloadRecord(local, locks)
    if target.exists():
        recovered = _recover_move(lib, track_id, quality, target, local, local_record, local_out)
        if recovered:
            return recovered
        result = _fetch_track(session, lib, out, rel, path, track_id, stop, on_progress,
                              quality, verify, adopt_existing, locks, source)
        if result[0] == "skip" and (not result[2] or result[2].startswith("Fallback:")):
            note = _discard_moved_copy(target, local, local_record, local_out)
            return "skip", 0, " ".join(n for n in (result[2], note) if n)
        return result
    state, nbytes, note = _fetch_track(session, lib, local_out, rel, path, track_id, stop,
                                       on_progress, quality, verify=verify, locks=locks, source=source)
    if state == "skip" and note and not note.startswith(("Recovered:", "Fallback:")):
        return "fail", 0, f"the copy in the work folder can't be moved: {note}"
    if state not in ("ok", "skip"):
        return state, nbytes, note
    record = read_object(local_record)
    saved_note = record_note(record)
    if (not saved_note and source == "download" and not record.get("adopted")
            and record.get("identity", {}).get("route") == "stream"):
        saved_note = ("Fallback: the copy in the work folder was fetched by streaming; "
                      "saved with the tags as uploaded, without iBroadcast's tag edits.")
        write_private(local_record, json.dumps({**record, "note": saved_note}).encode())
    try:
        moved = _move_to_output(local, local_record, target, local_out)
    except Fail as error:
        return "fail", 0, str(error)
    except OSError as error:
        return "fail", 0, ("downloaded to the work folder, but moving it failed "
                           f"({error.strerror or error}); it stays there and moves on the next run")
    return "ok", moved, saved_note or (note if state == "ok" else "")


def _move_to_output(local, local_record, target, local_out):
    record = read_object(local_record)
    info = local.stat()
    if record.get("size") != info.st_size or record.get("mtime_ns") != info.st_mtime_ns:
        raise Fail("the copy in the work folder changed before it could be moved; it is kept there")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".ibfetch-move")
    shutil.copyfile(str(local), str(temporary))
    if temporary.stat().st_size != info.st_size:
        raise OSError(errno.EIO, "the copied file has the wrong size")
    if target.exists():
        temporary.unlink()
        raise Fail("another file appeared at the target during the move; both are kept")
    os.replace(temporary, target)
    moved = target.stat()
    if moved.st_size != info.st_size:
        raise OSError(errno.EIO, "the moved file has the wrong size")
    # Network shares may set their own timestamp on rename; the baseline uses the final one.
    write_private(DownloadRecord(target, local_record.locks), json.dumps({
        "identity": record["identity"], "size": moved.st_size, "mtime_ns": moved.st_mtime_ns,
        "sha256": record["sha256"], "adopted": bool(record.get("adopted")),
        **({"note": record_note(record)} if record_note(record) else {})}).encode())
    _remove_local_copy(local, local_record, local_out)
    return moved.st_size


def _recover_move(lib, track_id, quality, target, local, local_record, local_out):
    """Restore a move interrupted after rename, including replacement of an old baseline."""
    target_record = DownloadRecord(target, local_record.locks)
    if not local.exists():
        return None
    record = read_object(local_record)
    existing = read_object(target_record)
    info = target.stat()
    if target_record.exists():
        if not _same_track(existing, lib, track_id, quality):
            return None
        if (existing.get("sha256") == record.get("sha256") and existing.get("size") == record.get("size") == info.st_size
                and existing.get("mtime_ns") == info.st_mtime_ns and record_note(existing) == record_note(record)
                and existing.get("identity") == record.get("identity")):
            return None  # already registered; the normal stat/verify path handles it
    if (not _same_track(record, lib, track_id, quality) or record.get("size") != info.st_size
            or local.stat().st_size != info.st_size or record.get("sha256") != file_digest(target)):
        return None
    after = target.stat()
    if (after.st_size, after.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
        return "skip", 0, "Modified: file changed during move recovery; preserved."
    write_private(target_record, json.dumps({
        "identity": record["identity"], "size": info.st_size, "mtime_ns": info.st_mtime_ns,
        "sha256": record["sha256"], "adopted": bool(record.get("adopted")),
        **({"note": record_note(record)} if record_note(record) else {})}).encode())
    note = _discard_moved_copy(target, local, local_record, local_out)
    return "skip", 0, " ".join(n for n in ("Recovered: an interrupted move from the work folder was completed.",
                                          record_note(record), note) if n)


def _discard_moved_copy(target, local, local_record, local_out):
    """Delete only a matching, unchanged leftover; return a note when preserving it."""
    if not local.exists():
        return ""
    record = read_object(local_record)
    target_record = read_object(DownloadRecord(target, local_record.locks))
    identity, moved_identity = record.get("identity"), target_record.get("identity")
    if (not isinstance(identity, dict) or not isinstance(moved_identity, dict)
            or any(k not in identity or identity[k] != moved_identity.get(k)
                   for k in ("user_id", "track_id", "quality"))
            or not record.get("sha256") or record["sha256"] != target_record.get("sha256")
            or record.get("size") != target_record.get("size")):
        return "Unverified: leftover audio in the work folder has no matching moved baseline; preserved."
    info = local.stat()
    if (record.get("size") != info.st_size or record.get("mtime_ns") != info.st_mtime_ns
            or record["sha256"] != file_digest(local)):
        return "Modified: leftover audio in the work folder changed; preserved."
    try:
        _remove_local_copy(local, local_record, local_out)
    except Fail as error:
        return str(error)
    return ""


def _remove_local_copy(local, local_record, local_out):
    # Recheck immediately before cleanup, including after a leftover's checksum.
    # Fresh downloads keep their streaming digest and do not need an extra read.
    if local.exists():
        record, info = read_object(local_record), local.stat()
        if record.get("size") != info.st_size or record.get("mtime_ns") != info.st_mtime_ns:
            raise Fail("Modified: audio in the work folder changed before cleanup; preserved.")
    for path in (local, local_record):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    parent = local.parent
    while parent != local_out and local_out in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _fetch_track(session, lib, out, rel, path, track_id, stop, on_progress, quality,
                 verify=False, adopt_existing=False, locks=None, source="stream"):
    """Download one file to out/rel, from the download service or by streaming.

    Returns (state, bytes, note) with state ok, skip, fail or stopped.
    on_progress(received, expected, new_bytes) is called while data arrives;
    expected is 0 when the size isn't known in advance.
    The SHA-256 is computed while the data arrives, so completion never reads
    the file again; a resumed .part is read once to continue its checksum.
    Only the streaming server resumes a .part. The download service starts each
    attempt over, and falls back to streaming when it can't deliver the file.
    """
    final = out / rel
    record_path = DownloadRecord(final, locks)
    part = final.with_name(final.name + ".part")
    part_record = DownloadRecord(final, locks, partial=True)
    # "route" tells how the bytes were fetched. Completed files match without it, so a
    # track saved by either route is skipped; partial files must match it to resume.
    identity = {"version": 1, "user_id": text(lib.user_id), "track_id": track_id,
                "quality": quality, "source": text(lib.tracks.get(track_id, "file")), "route": source}

    def save_record(digest, adopted=False, expected=None, note="", provenance=None):
        info = final.stat()
        if expected and (info.st_size, info.st_mtime_ns) != (expected.st_size, expected.st_mtime_ns):
            return False
        write_private(record_path, json.dumps({"identity": provenance if provenance is not None else identity,
                      "size": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": digest, "adopted": adopted,
                      **({"note": note} if note else {})}).encode())
        return True

    def matches(record):
        recorded = record.get("identity")
        return isinstance(recorded, dict) and all(recorded.get(k) == identity[k]
                                                  for k in ("user_id", "track_id", "quality"))

    def cleanup_pending(record):
        pending = read_object(part_record)
        if (not part.exists() and pending.get("completed") is True and matches(pending)
                and pending.get("sha256") == record.get("sha256")
                and pending.get("size") == record.get("size")):
            part_record.unlink()

    if final.exists():
        record = read_object(record_path)
        recorded = record.get("identity")
        matching = matches(record)
        info = final.stat()
        if not final.is_file() or not info.st_size:
            return "skip", 0, "Unverified: existing target is empty or not a regular file; preserved."
        if isinstance(recorded, dict) and not matching:
            return "skip", 0, "Unverified: existing file belongs to another track, account or quality; preserved."
        # A completion receipt was saved before rename. A partial identity alone is
        # insufficient: validate the completed length and checksum before recovery.
        pending = read_object(part_record)
        unchanged = matching and record.get("size") == info.st_size and record.get("mtime_ns") == info.st_mtime_ns
        registered_pending = (unchanged and pending.get("sha256") == record.get("sha256")
                              and pending.get("size") == record.get("size")
                              and pending.get("identity") == record.get("identity")
                              and record_note(pending) == record_note(record))
        if ((not record_path.exists() or matching) and not registered_pending
                and not part.exists() and pending.get("completed") is True
                and matches(pending) and pending.get("size") == info.st_size
                and pending.get("sha256") == file_digest(final)):
            if not save_record(pending["sha256"], expected=info, note=record_note(pending), provenance=pending["identity"]):
                return "skip", 0, "Modified: file changed during crash recovery; preserved."
            part_record.unlink()
            return "skip", 0, "Recovered: completed download receipt restored after interruption." + (
                " " + record_note(pending) if record_note(pending) else "")
        if adopt_existing and not unchanged:
            if not save_record(file_digest(final), adopted=True, expected=info,
                               note=record_note(record), provenance=recorded if matching else None):
                return "skip", 0, "Modified: file changed during adoption; baseline left unchanged."
            return "skip", 0, "Adopted: existing file accepted as a local baseline, not remotely verified."
        if not matching:
            return "skip", 0, "Unverified: existing file preserved; use explicit adoption only if you trust it."
        if verify:
            if record.get("sha256") != file_digest(final):
                return "skip", 0, "Modified: checksum differs from the saved baseline; preserved."
            if not save_record(record["sha256"], adopted=bool(record.get("adopted")), expected=info,
                               note=record_note(record), provenance=recorded):
                return "skip", 0, "Modified: file changed during verification; baseline left unchanged."
            cleanup_pending(record)
            return "skip", 0, record_note(record)
        if unchanged:
            cleanup_pending(record)
            return "skip", 0, record_note(record)
        if "mtime_ns" not in record:
            return "skip", 0, "Unverified: older record needs full verification or explicit adoption; preserved."
        return "skip", 0, "Modified: local size or modification time changed; preserved."
    final.parent.mkdir(parents=True, exist_ok=True)

    def without_route(value):
        return {k: v for k, v in value.items() if k != "route"} if isinstance(value, dict) else None

    def discard_part():
        for leftover in (part, part_record):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass

    if part.exists():
        recorded = read_object(part_record).get("identity")
        if without_route(recorded) != without_route(identity):
            return "fail", 0, "partial file has no matching download record; choose another folder"
        if source == "download" or recorded.get("route", "stream") != "stream":
            discard_part()  # this track's own incomplete download; only a streamed one can resume

    hashing = {"state": None, "length": 0}  # checksum of the bytes written to .part so far

    def checksum_for(length):
        if hashing["state"] is None or hashing["length"] != length:
            hashing["state"] = file_hasher(part) if length else hashlib.sha256()
            hashing["length"] = part.stat().st_size if length else 0
        return hashing["state"]

    def finish(note=""):
        length = part.stat().st_size
        if not length:
            return "fail", 0, "iBroadcast returned an empty audio file"
        digest = checksum_for(length).hexdigest()
        write_private(part_record, json.dumps({"identity": identity, "completed": True,
                      "size": length, "sha256": digest, **({"note": note} if note else {})}).encode())
        os.replace(part, final)
        # Network shares may give the renamed file their own timestamp. The content was
        # hashed as it was written under this target's lock, so size and the final stat
        # are the baseline; reading the whole file again would only double the traffic.
        renamed = final.stat()
        if renamed.st_size != length or not save_record(digest, expected=renamed, note=note):
            return "fail", 0, "file changed locally during completion; preserved without a new baseline"
        part_record.unlink()
        return "ok", length, note

    fallback = service_note = ""
    if source == "download":
        note = "failed"
        for attempt in range(3):
            if stop.is_set() or (attempt and stop.wait(3 * attempt)):
                return "stopped", 0, ""
            try:
                response = session.download(track_id, lib.user_id)
            except ServiceError as error:
                note = str(error)
                if error.retry:
                    continue
                break
            except NETWORK_ERRORS as error:
                # Tagcast wraps transport failures without errno. Actual filesystem
                # errors must never become retries or a different download route.
                if isinstance(error, OSError) and error.errno is not None:
                    raise
                note = f"network error ({error.__class__.__name__})"
                continue
            digest = hashlib.sha256()
            try:
                with response:
                    write_private(part_record, json.dumps({"identity": identity}).encode())
                    with open(part, "wb") as f:
                        length = copy_zip_entry(response, f, digest, final.suffix, stop, on_progress)
            except ServiceError as error:
                note = str(error)
                if error.retry:
                    continue
                break
            except NETWORK_ERRORS as error:
                # Tagcast wraps transport failures without errno. Actual filesystem
                # errors must never become retries or a different download route.
                if isinstance(error, OSError) and error.errno is not None:
                    raise
                note = f"connection dropped ({error.__class__.__name__})"
                continue
            if length is None:
                return "stopped", 0, ""
            hashing["state"], hashing["length"] = digest, length
            return finish()
        # The streaming server still has the original upload: finish the track from there.
        service_note = note
        fallback = f"Fallback: {note}; saved the file as uploaded, without iBroadcast's tag edits."
        identity = dict(identity, route="stream")
        discard_part()
        hashing["state"], hashing["length"] = None, 0

    if not path:
        return "fail", 0, "no stream path in the library, try refreshing the library"
    note = "failed"

    def resume_error(total, headers):
        previous = read_object(part_record)
        known = previous.get("total")
        if type(known) is not int or known <= 0:
            return "cannot safely resume this older partial without its original size; partial preserved, choose another folder to restart"
        if known != total:
            return "remote file size changed; partial preserved, choose another folder to restart"
        for key, header in (("etag", "ETag"), ("last_modified", "Last-Modified")):
            if previous.get(key) and previous[key] != headers.get(header):
                return "remote file identity changed or is unavailable; partial preserved, choose another folder to restart"
        return ""

    for attempt in range(4):
        if stop.is_set():
            return "stopped", 0, ""
        if attempt and stop.wait(3 * attempt):
            return "stopped", 0, ""
        offset = part.stat().st_size if part.exists() else 0
        try:
            response = session.stream(path, track_id, lib.user_id, lib.expires, offset)
        except NETWORK_ERRORS as error:
            if isinstance(error, OSError) and error.errno is not None:
                raise
            note = f"network error ({error.__class__.__name__})"
            continue
        with response:
            code = status_of(response)
            if code == 416 and offset:
                total = re.fullmatch(r"bytes \*/(\d+)", response.headers.get("Content-Range") or "")
                if total and int(total.group(1)) == offset:
                    error = resume_error(offset, response.headers)
                    if error:
                        return "fail", 0, error
                    return finish(fallback)
                return "fail", 0, "server range does not confirm the partial file is complete"
            if code in (401, 403):
                return "fail", 0, f"iBroadcast refused it (HTTP {code}), refresh the library or sign in again"
            if code == 404:
                return "fail", 0, "not found on iBroadcast (HTTP 404), refresh the library"
            if code not in (200, 206):
                note = f"HTTP {code}"
                continue
            if textual(response):
                return "fail", 0, "iBroadcast returned a non-audio response"
            if code == 200:
                offset = 0  # the server sent the whole file, start over
            raw_expected = response.headers.get("Content-Length")
            if raw_expected is not None and not re.fullmatch(r"\d+", str(raw_expected)):
                return "fail", 0, "server returned an invalid Content-Length"
            expected = number(raw_expected)
            if code == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range") or "")
                if not match:
                    return "fail", 0, "missing or invalid Content-Range on resumed download"
                start, end, total = map(int, match.groups())
                if start != offset or end < start or end >= total or (raw_expected is not None and expected != end - start + 1):
                    return "fail", 0, "server returned an unexpected byte range"
                if offset:
                    error = resume_error(total, response.headers)
                    if error:
                        return "fail", 0, error
                expected = end - start + 1
            else:
                total = expected
            received = 0
            try:
                if stop.is_set():
                    return "stopped", 0, ""
                checksum = checksum_for(offset)
                # Persist the response's continuity information before any bytes arrive.
                # A local SHA-256 alone cannot detect splicing two remote file versions.
                partial = {"identity": identity, "total": total}
                etag = response.headers.get("ETag")
                if etag and not etag.startswith("W/"):
                    partial["etag"] = etag
                elif response.headers.get("Last-Modified"):
                    partial["last_modified"] = response.headers["Last-Modified"]
                write_private(part_record, json.dumps(partial).encode())
                with open(part, "ab" if offset else "wb") as f:
                    while True:
                        if stop.is_set():
                            return "stopped", 0, ""
                        chunk = response.read(CHUNK)
                        if not chunk:
                            break
                        f.write(chunk)
                        checksum.update(chunk)
                        hashing["length"] += len(chunk)
                        received += len(chunk)
                        if on_progress:
                            on_progress(offset + received, offset + expected if expected else 0, len(chunk))
            except NETWORK_ERRORS as error:
                if isinstance(error, OSError) and error.errno is not None:
                    raise
                note = f"connection dropped ({error.__class__.__name__})"
                continue
        if expected and received != expected:
            note = f"incomplete ({size(received)} of {size(expected)})"
            continue
        if total and offset + received < total:
            note = "server returned only part of the remaining file"
            continue
        return finish(fallback)
    if fallback:
        return "fail", 0, f"{service_note}; streaming also failed: {note}"
    return "fail", 0, note


class Transfer:
    """Downloads a list of jobs with a few workers. snapshot() is safe to call from any thread."""

    def __init__(self, session, lib, jobs, out, workers, on_item=None, quality="orig",
                 verify=False, adopt_existing=False, prepare=None, total=None, valid=None,
                 locks=None, work=None, source="stream"):
        self.session, self.lib, self.jobs, self.out = session, lib, jobs, out
        self.workers, self.on_item = workers, on_item
        self.quality, self.source = quality, source
        self.locks, self.work = locks, work
        self.verify, self.adopt_existing = verify, adopt_existing
        self.prepare, self.valid = prepare, valid
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.total, self.done = len(jobs) if total is None else total, 0
        self.counts = {"ok": 0, "skip": 0, "fail": 0}
        self.bytes = 0        # size of the files finished this run
        self.moved = 0        # bytes received this run, for the speed
        self.live = {}        # rel -> [received, expected]
        self.failures = []
        self.existing = []
        self.notes = []       # saved files with a remark, such as a streaming fallback
        self.recent = deque(maxlen=40)
        self.samples = deque()
        self.futures = []
        self.state = "ready"
        self.started = self.finished = None

    def _work(self, rel, path, track_id):
        def progress(received, expected, new):
            with self.lock:
                self.live[rel] = [received, expected]
                self.moved += new
        with self.lock:  # visible while the download service prepares the file
            self.live[rel] = [0, 0]
        try:
            return fetch_track(self.session, self.lib, self.out, rel, path, track_id, self.stop,
                               progress, self.quality, self.verify, self.adopt_existing,
                               self.locks, self.work, self.source)
        except TransferStopped:
            return "stopped", 0, ""
        except TerminalTransferError as error:
            self.stop.set()
            return "fail", 0, str(error)
        except Fail as error:
            return ("stopped", 0, "") if self.stop.is_set() else ("fail", 0, str(error))
        except OSError as error:
            if error.errno is not None:
                self.stop.set()
                return "fail", 0, f"Local file operation failed ({error.__class__.__name__}, errno {error.errno}). Check the download folder before restarting."
            return "fail", 0, str(error)
        except Exception as error:  # one bad file shouldn't stop the rest
            return "fail", 0, f"{error.__class__.__name__}: {error}"
        finally:
            with self.lock:
                self.live.pop(rel, None)

    def _finish(self, rel, state, nbytes, note):
        if state == "stopped":
            return
        with self.lock:
            self.done += 1
            self.counts[state] += 1
            self.bytes += nbytes
            if state == "fail":
                self.failures.append({"name": str(rel), "note": note})
            if state == "skip" and note:
                self.existing.append({"name": str(rel), "note": note})
            if state == "ok" and note:
                self.notes.append({"name": str(rel), "note": note})
            self.recent.appendleft({"name": str(rel), "state": state, "bytes": nbytes, "note": note})
            done = self.done
        if self.on_item:
            self.on_item(done, self.total, state, rel, nbytes, note)

    def run(self):
        self.state, self.started = "planning", time.time()
        try:
            if self.prepare:
                self.jobs = self.prepare(self.stop)
            if self.valid and not self.valid():
                self.stop.set()
            if self.stop.is_set():
                self.finished, self.state = time.time(), "stopped"
                return
            self.total = len(self.jobs)
        except Exception as error:
            if not self.stop.is_set():
                self.total = 1
                self._finish("Download preparation", "fail", 0, str(error))
            self.finished = time.time()
            self.state = "stopped" if self.stop.is_set() else "done"
            return
        self.state = "running"
        pool = ThreadPoolExecutor(max_workers=self.workers)
        self.futures = {pool.submit(self._work, rel, path, tid): rel for rel, path, tid in self.jobs}
        try:
            for future in as_completed(self.futures):
                if future.cancelled():
                    continue
                state, nbytes, note = future.result()
                self._finish(self.futures[future], state, nbytes, note)
        except KeyboardInterrupt:
            self.cancel()
        finally:
            pool.shutdown(wait=True)
            self.finished = time.time()
            self.state = "stopped" if self.stop.is_set() else "done"

    def cancel(self):
        self.stop.set()
        for future in list(self.futures):
            future.cancel()

    def snapshot(self):
        now = time.time()
        with self.lock:
            self.samples.append((now, self.moved))
            while len(self.samples) > 2 and now - self.samples[0][0] > 8:
                self.samples.popleft()
            (t0, b0), (t1, b1) = self.samples[0], self.samples[-1]
            speed = (b1 - b0) / (t1 - t0) if t1 - t0 > 0.5 and self.state == "running" else 0
            elapsed = (self.finished or now) - (self.started or now)
            left = self.total - self.done
            eta = elapsed / self.done * left if self.done >= 3 and self.state == "running" else None
            return {
                "state": self.state, "total": self.total, "done": self.done, **self.counts,
                "bytes": self.bytes + sum(r for r, _ in self.live.values()), "speed": speed,
                "elapsed": elapsed, "eta": eta, "out": str(self.out.resolve()),
                "active": [{"name": str(k), "received": v[0], "expected": v[1]} for k, v in self.live.items()],
                "recent": list(self.recent)[:12], "failures": self.failures[-200:],
                "existing": self.existing[-200:], "existing_count": len(self.existing),
                "notes": self.notes[-200:], "notes_count": len(self.notes), "source": self.source,
            }


def choose_folder(start):
    """Show the system's folder picker. Returns a path, "" when cancelled, None when unavailable."""
    prompt = "Choose where Tagcast saves your music"
    if sys.platform == "darwin":
        script = f'POSIX path of (choose folder with prompt "{prompt}")'
        command = ["osascript", "-e", script]
    elif os.name == "nt":
        ps = ("Add-Type -AssemblyName System.Windows.Forms;"
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
              f"$d.Description = '{prompt}'; $d.SelectedPath = $env:IBFETCH_START;"
              "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }")
        command = ["powershell", "-NoProfile", "-STA", "-Command", ps]
    elif shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", f"--title={prompt}", f"--filename={start}/"]
    elif shutil.which("kdialog"):
        command = ["kdialog", "--getexistingdirectory", start, "--title", prompt]
    else:
        return None
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=900,
                                env={**os.environ, "IBFETCH_START": start})
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip().rstrip("/\\") if result.returncode == 0 else ""
