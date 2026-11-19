"""One bounded copy of a direct MP3 response, collected as playback receives it."""

import re
import threading
from collections import deque
from time import monotonic

MAX_BYTES = 24 * 1024 * 1024
COPY_SECONDS = 120
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{16,100}")


def buffer_key(session, request, track, quality):
    if (session and REQUEST_ID.fullmatch(request or "")
            and quality in ("96", "128", "192", "256", "320")):
        return session, request, track, quality
    return None


def needs_buffer(response, mime, request_range):
    headers = response.headers
    return (
        request_range in (None, "bytes=0-") and response.status_code == 200
        and (headers.get("Content-Type") or mime or "").partition(";")[0].strip().lower() == "audio/mpeg"
        and not headers.get("Content-Length") and not headers.get("Content-Range")
        and headers.get("Accept-Ranges", "").strip().lower() != "bytes"
        and headers.get("Transfer-Encoding", "").strip().lower() == "chunked"
    )


def buffered_range(value, size):
    """Return the status and half-open byte interval for a single HTTP range."""
    match = re.fullmatch(r"bytes=([0-9]{0,20})-([0-9]{0,20})", value or "", re.IGNORECASE)
    if not match or not any(match.groups()):
        return 200, 0, size
    first, last = match.groups()
    if not first:
        length = int(last)
        return (206, max(0, size - length), size) if length else (416, 0, 0)
    start, end = int(first), min(size, int(last) + 1) if last else size
    return (206, start, end) if start < end else (416, 0, 0)


class Mp3Buffer:
    def __init__(self):
        self.lock = threading.Lock()
        self.retired = deque(maxlen=32)
        self.key = self.audio = None
        self.state = "unavailable"
        self.deadline = 0
        self.arrived = self.latest = 0

    def arrive(self):
        with self.lock:
            self.arrived += 1
            return self.arrived

    def begin(self, key, order):
        with self.lock:
            if (self.key and self.key[:2] == key[:2]) or key[:2] in self.retired:
                return False
            if order <= self.latest:
                self.retired.append(key[:2])
                return False
            self.latest = order
            if self.key:
                self.retired.append(self.key[:2])
            self.key, self.audio, self.state = key, bytearray(), "copying"
            self.deadline = monotonic() + COPY_SECONDS
            return True

    def skip(self, key):
        with self.lock:
            if not self.key or self.key[:2] != key[:2]:
                self.retired.append(key[:2])

    def release(self, session, request):
        with self.lock:
            self.retired.append((session, request))
            if self.key and self.key[:2] == (session, request):
                self.key = self.audio = None
                self.state = "unavailable"

    def clear(self):
        with self.lock:
            self.key = self.audio = None
            self.state = "unavailable"
            self.retired.clear()

    def append(self, key, chunk):
        with self.lock:
            if key != self.key or self.state != "copying":
                return False
            if len(self.audio) + len(chunk) > MAX_BYTES or monotonic() >= self.deadline:
                self.audio, self.state = None, "unavailable"
                return False
            self.audio.extend(chunk)
            return True

    def finish(self, key, complete=False):
        with self.lock:
            if key == self.key and self.state == "copying":
                if complete and self.audio and monotonic() < self.deadline:
                    self.state = "ready"
                else:
                    self.audio, self.state = None, "unavailable"

    def status(self, session, request):
        with self.lock:
            if self.key and self.key[:2] == (session, request):
                if self.state == "copying" and monotonic() >= self.deadline:
                    self.audio, self.state = None, "unavailable"
                return self.state
            return "unavailable" if (session, request) in self.retired else "unknown"

    def read(self, key):
        with self.lock:
            if key == self.key and self.state == "ready":
                return memoryview(self.audio).toreadonly()
        return None
