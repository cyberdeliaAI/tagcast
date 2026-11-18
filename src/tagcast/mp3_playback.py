"""Make a complete, bounded chunked MP3 seekable on the local connection."""

import re
from time import monotonic

MAX_MP3_BYTES = 24 * 1024 * 1024
BUFFER_SECONDS = 6
READ_SIZE = 16 * 1024


def buffer_key(session, request, track, quality):
    if (session and quality in ("96", "128", "192", "256", "320")
            and re.fullmatch(r"[A-Za-z0-9_-]{16,100}", request or "")):
        return session, request, track, quality
    return None


def needs_buffer(response, mime, request_range):
    headers = response.headers
    return (request_range in (None, "bytes=0-") and response.status_code == 200
            and (headers.get("Content-Type") or mime).split(";", 1)[0].strip().lower() == "audio/mpeg"
            and not headers.get("Content-Length") and not headers.get("Content-Range")
            and headers.get("Accept-Ranges", "").strip().lower() != "bytes"
            and headers.get("Transfer-Encoding", "").strip().lower() == "chunked")


def read_prefix(chunks):
    """On reaching a limit, return the prefix and leave the iterator open for playback."""
    prefix = bytearray()
    deadline = monotonic() + BUFFER_SECONDS
    for chunk in chunks:
        prefix.extend(chunk)
        if len(prefix) > MAX_MP3_BYTES or monotonic() >= deadline:
            return prefix, False
    return prefix, bool(prefix)


def limit_reached(prefix):
    """Name what ended an incomplete read. Diagnostics only."""
    return "size_limit" if len(prefix) > MAX_MP3_BYTES else "time_limit" if prefix else "empty"


def buffered_range(value, size):
    """Return the status and half-open byte interval for one local HTTP response."""
    match = re.fullmatch(r"bytes=([0-9]{0,20})-([0-9]{0,20})", value or "", re.IGNORECASE)
    if not match or not any(match.groups()):
        return 200, 0, size
    first, last = match.groups()
    if not first:
        length = int(last)
        return (206, max(0, size - length), size) if length else (416, 0, 0)
    start, end = int(first), min(size, int(last) + 1) if last else size
    return (206, start, end) if start < end else (416, 0, 0)
