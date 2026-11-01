"""Explicit music uploads to iBroadcast through the documented upload service.

Tagcast only reads the chosen audio files and sends copies. It never modifies, moves or
deletes local files and never removes anything from the iBroadcast library. Folder
watching and the delete-when-missing behaviour of the official MediaSync apps are left
out on purpose: every upload starts from an explicit selection and a reviewed plan.

Protocol (``upload.ibroadcast.com``, the route used by ibroadcast-python 2.x; the
account must grant the ``user.upload`` OAuth permission):

- POST with an empty form body answers ``{"md5": [...]}``: the MD5 of every file the
  account has already uploaded.
- POST ``multipart/form-data`` with ``client``, ``version``, ``file_path``, ``method`` and
  the audio in field ``file`` uploads one file. Only an answer with ``result: true`` and
  a message naming the new track (``"... (123456) uploaded successfully"``) counts as
  confirmation.

The MD5 is of the complete file, so it recognises byte-identical files only. The same
recording with different tags or a different encoding has a different MD5.

An unclear outcome is never resent automatically. The engine looks for the file's MD5
in a fresh list; if it is not there (yet), the file stays ``uncertain`` until the user
plans again. Interrupted transfers are reported as uncertain as well, because how
iBroadcast treats incomplete requests is not verified.

This module is the engine only. Connection state, session binding, review and the user
interface belong to the caller, as with ``download_engine``.
"""

import hashlib
import os
import re
import secrets
import socket
import stat as stat_module
import threading
from dataclasses import dataclass, field
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool

UPLOAD_URL = "https://upload.ibroadcast.com"
# Point at a test server, e.g. TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9000
_test_base = os.environ.get("TAGCAST_IBROADCAST_BASE", "").rstrip("/")
if _test_base:
    UPLOAD_URL = f"{_test_base}/upload"

UPLOAD_SCOPE = "user.upload"
MAX_FILE_BYTES = 1536 * 1024 * 1024  # help center: 1.5 GB per file
MAX_FILES = 100_000  # per scan; above this, ask for a smaller selection
CHUNK = 1024 * 1024
RETRY_DELAYS = (2, 6)  # list retries, and MD5 checks after an unclear upload answer
LIST_TIMEOUT = 120
# Connect, then read. Both apply per socket operation, not as a total; the connect value
# applies per address tried. Neither bounds the DNS lookup, which the system resolver does.
SEND_TIMEOUT = (15, 600)
HASH_FILE = "upload-hashes.json"
HASH_LIMIT = 200_000
TRACK_ID = re.compile(r"\((\d+)\)\s*uploaded successfully")
OPEN_FLAGS = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
              | getattr(os, "O_NONBLOCK", 0))  # never follow a link or block on a pipe

# Plan states. Only "new" files are sent.
NEW, UPLOADED, DUPLICATE = "new", "uploaded", "duplicate"
TOO_LARGE, EMPTY, UNREADABLE, UNSUPPORTED = "too_large", "empty", "unreadable", "unsupported"
NOT_REGULAR = "not_regular"
# Result states after a job.
QUEUED, SENDING, SENT, CONFIRMED = "queued", "sending", "sent", "confirmed"
FAILED, UNCERTAIN, STOPPED, NOT_SENT = "failed", "uncertain", "stopped", "not_sent"

CHECK_AGAIN = "It is not sent again automatically; plan again later to check."


class UploadError(Exception):
    """A problem to show the user. iBroadcast did not accept the file."""


class UncertainUpload(UploadError):
    """The file may have arrived. Only the MD5 list can confirm it."""


class AuthRejected(UploadError):
    """iBroadcast refused the session or the upload permission. Stops the whole job."""


class Unreachable(UploadError):
    """No usable answer before any audio was sent (no connection, or a redirect).

    Stops the whole job.
    """


class FileChanged(Exception):
    """The file is not the one that was planned."""


class Stopped(Exception):
    """An explicit stop."""


class SessionChanged(Exception):
    """The caller's account or session binding is no longer valid."""


def file_identity(stat):
    """What must stay equal for a file to count as unchanged since it was checked."""
    ctime = 0 if os.name == "nt" else stat.st_ctime_ns  # creation time on Windows
    return (stat.st_size, stat.st_mtime_ns, stat.st_ino, ctime)


def _regular_stat(path):
    """lstat of a regular, unlinked file, or None."""
    stat = os.lstat(path)
    return stat if stat_module.S_ISREG(stat.st_mode) else None


def open_checked(path, identity=None):
    """Open a regular file without following links; optionally require its identity."""
    fd = os.open(path, OPEN_FLAGS)
    try:
        stat = os.fstat(fd)
        if not stat_module.S_ISREG(stat.st_mode):
            raise FileChanged("It is no longer a regular file.")
        if identity is not None and file_identity(stat) != identity:
            raise FileChanged("The file changed after it was checked.")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def file_md5(path, identity=None, stop=None):
    """MD5 of a complete file, read in chunks; the file must not change while reading."""
    digest = hashlib.md5(usedforsecurity=False)
    with open_checked(path, identity) as handle:
        while chunk := handle.read(CHUNK):
            if stop is not None and stop.is_set():
                raise Stopped()
            digest.update(chunk)
        if identity is not None and file_identity(os.fstat(handle.fileno())) != identity:
            raise FileChanged("The file changed while it was being checked.")
    return digest.hexdigest()


def supported_extensions(status):
    """Lower-case extensions (".flac") from the ``supported`` list of a ``status`` answer."""
    entries = status.get("supported") if isinstance(status, dict) else None
    found = set()
    for entry in entries if isinstance(entries, list) else ():
        extension = entry.get("extension") if isinstance(entry, dict) else None
        if isinstance(extension, str) and extension.strip(" ."):
            extension = extension.strip().lower()
            found.add(extension if extension.startswith(".") else f".{extension}")
    return frozenset(found)


# -- local files ----------------------------------------------------------------------------


class HashIndex:
    """Remembered MD5s of local files, reused only while the file identity matches.

    The identity is size, modification time, inode and (outside Windows) change time,
    so a replaced or rewritten file is read again. Holds local file knowledge only, no
    account data. ``read(name)`` and ``write(name, data)`` are the Studio's storage
    helpers, so the index lives in the Tagcast folder and never inside a music folder.
    """

    def __init__(self, read, write, limit=HASH_LIMIT):
        self._read, self._write, self._limit = read, write, limit
        self._lock = threading.Lock()
        self._entries = None
        self._dirty = False

    def _load(self):
        if self._entries is not None:
            return
        data = self._read(HASH_FILE)
        files = data.get("files") if isinstance(data, dict) and data.get("version") == 1 else None
        self._entries = {key: value for key, value in (files or {}).items()
                         if isinstance(key, str) and isinstance(value, list) and len(value) == 5
                         and isinstance(value[0], str)
                         and all(isinstance(part, int) for part in value[1:])}

    def md5(self, path, identity, stop=None):
        key = str(path)
        with self._lock:
            self._load()
            entry = self._entries.get(key)
        if entry and tuple(entry[1:]) == identity:
            return entry[0]
        value = file_md5(path, identity, stop)
        with self._lock:
            self._entries.pop(key, None)  # most recent last, so trimming drops the oldest
            self._entries[key] = [value, *identity]
            self._dirty = True
        return value

    def save(self):
        with self._lock:
            if not self._dirty or self._entries is None:
                return
            excess = len(self._entries) - self._limit
            if excess > 0:
                for key in list(self._entries)[:excess]:
                    del self._entries[key]
            data = {"version": 1, "files": dict(self._entries)}
            self._dirty = False
        self._write(HASH_FILE, data)


@dataclass
class LocalFile:
    path: Path
    root: Path  # the chosen file or folder this file was found through
    size: int


def _hidden(name):
    # Also skips macOS "._name" AppleDouble files on external drives.
    return name.startswith(".")


def scan(roots, extensions, *, stop=None, limit=MAX_FILES):
    """Audio files in the chosen files and folders.

    Regular files only: hidden and linked entries are skipped and never followed.
    Returns ``(files, ignored)`` where ``ignored`` counts other files inside the chosen
    folders, such as artwork or cue sheets. A file chosen directly is always listed, so
    an unsupported one can be reported in the plan. Planning checks every file again.
    """
    found, seen, ignored = [], set(), 0

    def add(path, root, size):
        key = os.path.normcase(str(path))
        if key not in seen:
            seen.add(key)
            if len(found) >= limit:
                raise UploadError(f"More than {limit:,} files. Choose a smaller selection.")
            found.append(LocalFile(path, root, size))

    for chosen in roots:
        root = Path(chosen).expanduser()
        if not root.is_absolute():
            raise UploadError("Choose a complete file or folder path.")
        if root.is_symlink():
            raise UploadError(f"{root.name} is a link. Choose the original file or folder.")
        if root.is_file():
            add(root, root, root.stat().st_size)
            continue
        if not root.is_dir():
            raise UploadError(f"{root} is not an available file or folder.")
        def unreadable(error):
            raise UploadError("A selected folder or subfolder could not be read. Check file access before preparing again.") from None
        for folder, dirnames, filenames in os.walk(root, followlinks=False, onerror=unreadable):
            if stop is not None and stop.is_set():
                raise Stopped()
            dirnames[:] = sorted((d for d in dirnames if not _hidden(d)), key=str.casefold)
            for name in sorted(filenames, key=str.casefold):
                if _hidden(name):
                    continue
                path = Path(folder, name)
                try:
                    stat = _regular_stat(path)
                except OSError:
                    continue
                if stat is None:
                    continue
                if path.suffix.lower() not in extensions:
                    ignored += 1
                    continue
                add(path, root, stat.st_size)
    return found, ignored


def path_label(path, root, mode="relative"):
    """The ``file_path`` iBroadcast stores and shows as the upload folder.

    ``relative`` (default) starts at the chosen folder's own name, so the home folder
    and drive layout stay on this computer. ``absolute`` matches the official apps.
    """
    if mode == "absolute":
        label = str(path)
    else:
        base = root.parent if root.is_dir() else root.parent.parent
        try:
            label = path.relative_to(base).as_posix()
        except ValueError:
            label = path.name
    return " ".join(label.splitlines()) or path.name


@dataclass
class UploadItem:
    path: Path
    label: str
    size: int
    status: str = NEW
    md5: str = ""
    identity: tuple = field(default=(), repr=False)
    note: str = ""
    track_id: str = ""
    sent: int = 0
    verified: bool = False

    def view(self):
        return {"label": self.label, "size": self.size, "status": self.status,
                "note": self.note, "track_id": self.track_id, "sent": self.sent,
                "verified": self.verified}


def plan_uploads(files, extensions, remote_md5s, index, *, stop=None, path_mode="relative",
                 progress=None):
    """Decide per file whether it needs sending. Reads files to hash them; sends nothing.

    Every file is checked again here (type, link, current size), because it can change
    after the scan. ``remote_md5s`` is the account's current MD5 list;
    ``progress(done, total)`` is called after each file.
    """
    items, planned = [], {}
    for done, local in enumerate(files, 1):
        item = UploadItem(local.path, path_label(local.path, local.root, path_mode), local.size)
        items.append(item)
        _plan_one(item, extensions, remote_md5s, index, planned, stop)
        if progress:
            progress(done, len(files))
    index.save()
    return items


def _plan_one(item, extensions, remote_md5s, index, planned, stop):
    if item.path.suffix.lower() not in extensions:
        item.status, item.note = UNSUPPORTED, "iBroadcast does not accept this file type."
        return
    try:
        stat = _regular_stat(item.path)
    except OSError as error:
        item.status, item.note = UNREADABLE, f"Could not read the file ({error.strerror})."
        return
    if stat is None:
        item.status, item.note = NOT_REGULAR, "It is a link or not a regular file."
        return
    item.size, item.identity = stat.st_size, file_identity(stat)
    if item.size == 0:
        item.status, item.note = EMPTY, "The file is empty."
        return
    if item.size > MAX_FILE_BYTES:
        item.status, item.note = TOO_LARGE, "Larger than iBroadcast's 1.5 GB per file."
        return
    try:
        item.md5 = index.md5(item.path, item.identity, stop)
    except FileChanged as error:
        item.status, item.note = UNREADABLE, f"{error} Plan again."
        return
    except OSError as error:
        item.status, item.note = UNREADABLE, f"Could not read the file ({error.strerror})."
        return
    if item.md5 in remote_md5s:
        item.status, item.note = UPLOADED, "An identical file is already in iBroadcast."
    elif item.md5 in planned:
        item.status = DUPLICATE
        item.note = f"Identical to {planned[item.md5].label}."
    else:
        planned[item.md5] = item


def check_unchanged(item):
    """Before sending: the path must still be the same regular file that was planned."""
    try:
        stat = _regular_stat(item.path)
    except OSError as error:
        raise FileChanged(f"The file is no longer available ({error.strerror}).") from None
    if stat is None:
        raise FileChanged("It is now a link or not a regular file.")
    if file_identity(stat) != item.identity:
        raise FileChanged("The file changed after it was planned.")


def plan_summary(items):
    counts = {}
    for item in items:
        counts[item.status] = counts.get(item.status, 0) + 1
    return {"files": len(items), "counts": counts,
            "bytes_to_send": sum(item.size for item in items if item.status == NEW)}


# -- transfer -------------------------------------------------------------------------------


def _shutdown(sock):
    try:
        # Avoid touching another thread's TLS state. On Windows shutdown cannot
        # wake a read already blocked on a silent peer; see Transfer's limits.
        socket.socket.shutdown(sock, socket.SHUT_RDWR)
    except (OSError, TypeError, ValueError):
        pass


class Transfer:
    """One request's network state, so a stop from another thread can cut it off.

    Its session records the sockets it opens (directly or through an HTTP proxy) and
    shuts them down on ``abort()``. ``body_started`` / ``body_complete`` tell whether
    any or all of the upload left this computer in the latest attempt.

    A socket is recorded once it is connected (after any TLS handshake). A stop cannot
    cut off the DNS lookup, the TCP connect or the handshake; those end on their own
    (the lookup only through the system resolver's limits), after which the stop
    applies before anything is sent. SOCKS proxies are not tracked.
    On Windows, shutdown also cannot wake an already blocked read: stopping then
    waits for the peer or the existing read timeout, without sending later files.
    """

    def __init__(self, stop=None, valid=None):
        self.stop = stop or threading.Event()
        self.valid = valid or (lambda: True)
        self.body_started = self.body_complete = False
        self._lock = threading.Lock()
        self._sockets = []
        self._aborted = False
        self.session = requests.Session()
        adapter = _TrackingAdapter(self)
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

    def begin(self):
        """Before every request, including a client retry after a token refresh."""
        self.body_started = self.body_complete = False
        if self.stop.is_set():
            raise Stopped()
        if not self.valid():
            raise SessionChanged("The iBroadcast session changed.")

    def track(self, sock):
        with self._lock:
            self._sockets.append(sock)
            aborted = self._aborted
        if aborted:
            _shutdown(sock)

    def abort(self):
        with self._lock:
            self._aborted = True
            sockets = list(self._sockets)
        for sock in sockets:
            _shutdown(sock)

    def close(self):
        self.session.close()


def _tracked_pools(transfer):
    class Tracked:
        def connect(self):
            super().connect()
            transfer.track(self.sock)

    http_connection = type("TrackedHTTPConnection", (Tracked, HTTPConnection), {})
    https_connection = type("TrackedHTTPSConnection", (Tracked, HTTPSConnection), {})
    return {"http": type("TrackedHTTPPool", (HTTPConnectionPool,),
                         {"ConnectionCls": http_connection}),
            "https": type("TrackedHTTPSPool", (HTTPSConnectionPool,),
                          {"ConnectionCls": https_connection})}


class _TrackingAdapter(HTTPAdapter):
    def __init__(self, transfer):
        self._pools = _tracked_pools(transfer)
        super().__init__()

    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = self._pools

    def proxy_manager_for(self, proxy, **kwargs):
        manager = super().proxy_manager_for(proxy, **kwargs)
        if not proxy.lower().startswith("socks"):
            manager.pool_classes_by_scheme = self._pools
        return manager


def _form_param(name, value):
    # The same escaping as urllib3 (HTML5 form encoding), which ibroadcast-python relies on.
    value = value.translate({10: "%0A", 13: "%0D", 34: "%22"})
    return f'{name}="{value}"'


class MultipartBody:
    """A streamed ``multipart/form-data`` body with a known length.

    Opens the planned file (no links, same identity) before anything is sent, then
    sends it in CHUNK pieces. A stop, or audio that no longer matches the planned MD5,
    abandons the request before its closing boundary. That keeps the request
    incomplete; how iBroadcast treats incomplete requests is not verified, so the job
    reports such a file as uncertain.
    """

    def __init__(self, fields, item, transfer, *, on_bytes=None):
        boundary = f"TagcastUpload{secrets.token_hex(16)}"
        head = [f"--{boundary}\r\nContent-Disposition: form-data; {_form_param('name', name)}"
                f"\r\n\r\n{value}\r\n" for name, value in fields.items()]
        head.append(f"--{boundary}\r\nContent-Disposition: form-data; {_form_param('name', 'file')}; "
                    f"{_form_param('filename', item.path.name)}\r\n"
                    "Content-Type: application/octet-stream\r\n\r\n")
        self.head = "".join(head).encode("utf-8")
        self.tail = f"\r\n--{boundary}--\r\n".encode()
        self.content_type = f"multipart/form-data; boundary={boundary}"
        self.item, self.transfer, self.on_bytes = item, transfer, on_bytes

    def __len__(self):
        return len(self.head) + self.item.size + len(self.tail)

    def __iter__(self):
        item, transfer = self.item, self.transfer
        digest = hashlib.md5(usedforsecurity=False)
        sent = 0
        try:
            handle = open_checked(item.path, item.identity)
        except OSError as error:  # e.g. replaced by a link after the last check
            raise FileChanged(f"The file could not be opened again ({error.strerror}).") from None
        with handle:
            transfer.body_started = True
            yield self.head
            while sent < item.size:
                if transfer.stop.is_set():
                    raise Stopped()
                chunk = handle.read(min(CHUNK, item.size - sent))
                if not chunk:
                    raise FileChanged("The file became shorter while it was being sent.")
                digest.update(chunk)
                sent += len(chunk)
                yield chunk
                if self.on_bytes:
                    self.on_bytes(sent)
            if handle.read(1):
                raise FileChanged("The file grew while it was being sent.")
        if digest.hexdigest() != item.md5:
            raise FileChanged("The file changed while it was being sent.")
        if transfer.stop.is_set():
            raise Stopped()
        transfer.body_complete = True
        yield self.tail


def _answer(response):
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _redirect_message(status, response):
    target = "elsewhere" if response.headers.get("Location") else "without a destination"
    return f"iBroadcast redirected the request {target} (HTTP {status}); it was not followed."


def _normalize_auth(response):
    # Some iBroadcast services reject a token in JSON with HTTP 200. Report that as 401
    # so the client's shared refresh gate can renew the token once.
    if response.status_code == 200 and _answer(response).get("authenticated") is False:
        response.status_code = 401
    return response


class UploadService:
    """Requests to the upload service through the client's shared OAuth refresh gate.

    ``client`` is a ``StudioClient``; it supplies the client identity and
    ``_with_fresh_token``, which retries once with a renewed token on 401/403. Each
    request runs in a ``Transfer`` so it can be checked before sending and cut off.
    """

    def __init__(self, client, url=None):
        self.client = client
        self.url = url or UPLOAD_URL

    def _headers(self, access_token, content_type):
        return {"Authorization": f"Bearer {access_token}",
                "User-Agent": self.client._user_agent, "Content-Type": content_type}

    def remote_md5s(self, transfer=None):
        """MD5s of every file the account has uploaded. A read, so retried when unclear."""
        if transfer is None:
            transfer = Transfer()
            try:
                return self.remote_md5s(transfer)
            finally:
                transfer.close()

        def send(access_token):
            transfer.begin()
            return _normalize_auth(transfer.session.post(
                self.url, data="", timeout=LIST_TIMEOUT, allow_redirects=False,
                headers=self._headers(access_token, "application/x-www-form-urlencoded")))

        last = len(RETRY_DELAYS)
        for attempt, delay in enumerate((0, *RETRY_DELAYS)):
            if delay and transfer.stop.wait(delay):
                raise Stopped()
            try:
                response = self.client._with_fresh_token(send)
            except requests.RequestException as error:
                if transfer.stop.is_set():
                    raise Stopped() from None
                if attempt == last:
                    raise UploadError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None
                continue
            status = response.status_code
            if 300 <= status < 400:
                raise UploadError(_redirect_message(status, response))
            if (status == 429 or status >= 500) and attempt < last:
                continue
            data = _answer(response)
            if status in (401, 403):
                raise AuthRejected("iBroadcast did not accept the upload permission. Connect again.")
            if not response.ok or data.get("result") is not True or not isinstance(data.get("md5"), list):
                raise UploadError(data.get("message")
                                  or f"iBroadcast did not list uploaded files (HTTP {status}).")
            return frozenset(value.lower() for value in data["md5"] if isinstance(value, str))
        raise UploadError("iBroadcast did not answer.")

    def upload(self, item, transfer, *, on_bytes=None):
        """Send one planned file. Returns the new track ID from the confirmation.

        Raises UncertainUpload whenever the answer does not clearly say yes or no.
        """
        check_unchanged(item)
        client = self.client
        fields = {"client": client._client, "version": client._version,
                  "file_path": item.label, "method": client._client}

        def send(access_token):
            transfer.begin()
            body = MultipartBody(fields, item, transfer, on_bytes=on_bytes)
            # Never follow a redirect: requests would send the file again by itself,
            # outside begin() and its stop/session checks.
            response = _normalize_auth(transfer.session.post(
                self.url, data=body, timeout=SEND_TIMEOUT, allow_redirects=False,
                headers=self._headers(access_token, body.content_type)))
            if response.status_code in (401, 403):
                # An answered token refusal: this attempt was not accepted.
                transfer.body_started = transfer.body_complete = False
            return response

        try:
            response = client._with_fresh_token(send)
        except requests.RequestException as error:
            if transfer.stop.is_set():
                raise Stopped() from None
            if not transfer.body_started:  # no audio left this computer
                raise Unreachable(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None
            raise UncertainUpload(f"The connection ended early ({error.__class__.__name__}).") from None
        status, data = response.status_code, _answer(response)
        if status in (401, 403):
            raise AuthRejected("iBroadcast did not accept the upload permission. Connect again.")
        if 300 <= status < 400:
            if transfer.body_started:
                raise UncertainUpload(_redirect_message(status, response))
            raise Unreachable(_redirect_message(status, response))
        if status == 429 or status >= 500:
            raise UncertainUpload(f"iBroadcast answered HTTP {status}.")
        if not response.ok:
            raise UploadError(data.get("message") or f"iBroadcast refused the file (HTTP {status}).")
        if data.get("result") is False:
            raise UploadError(data.get("message") or "iBroadcast refused the file.")
        match = TRACK_ID.search(str(data.get("message") or "")) if data.get("result") is True else None
        if not match:
            raise UncertainUpload("iBroadcast answered without a recognizable confirmation.")
        return match.group(1)


class _EndJob(Exception):
    def __init__(self, state, message):
        super().__init__(message)
        self.state, self.message = state, message


class UploadJob:
    """Sends the planned new files one at a time.

    Pausing waits between files. Stopping cuts off the current request. ``valid()`` is
    checked before every request, so the caller can end the job when the account or
    session is replaced. Every file ends in a final state; a file that may have reached
    iBroadcast is never reported as not uploaded.
    """

    def __init__(self, service, items, *, valid=None):
        self.service = service
        self.items = list(items)
        self.valid = valid or (lambda: True)
        self.state, self.message, self.current = "ready", "", ""
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._running = threading.Event()
        self._running.set()
        self._thread = None
        self._transfer = None
        self._sendable = [item for item in self.items if item.status == NEW]
        for item in self._sendable:
            item.status = QUEUED

    # controls ------------------------------------------------------------------------------

    def start(self):
        with self._lock:
            if self.state != "ready":
                return False
            self.state = "running"
        self._thread = threading.Thread(target=self._run, name="tagcast-uploads", daemon=True)
        self._thread.start()
        return True

    def run(self):
        """Run in the calling thread (tests, command-line use)."""
        with self._lock:
            if self.state != "ready":
                return
            self.state = "running"
        self._run()

    def pause(self):
        with self._lock:
            if self.state == "running":
                self.state = "paused"
                self._running.clear()

    def resume(self):
        with self._lock:
            if self.state == "paused":
                self.state = "running"
                self._running.set()

    def stop(self):
        self._stop.set()
        self._running.set()
        with self._lock:
            transfer = self._transfer
        if transfer:
            transfer.abort()

    def join(self, timeout=None):
        if self._thread:
            self._thread.join(timeout)

    def view(self):
        with self._lock:
            counts = {}
            for item in self.items:
                counts[item.status] = counts.get(item.status, 0) + 1
            sent = sum(item.size if item.status in (SENT, CONFIRMED) else item.sent
                       for item in self._sendable)
            return {"state": self.state, "message": self.message, "current": self.current,
                    "counts": counts,
                    "bytes": {"total": sum(item.size for item in self._sendable), "sent": sent},
                    "items": [item.view() for item in self.items]}

    # work ----------------------------------------------------------------------------------

    def _finish(self, state, message=""):
        with self._lock:
            for item in self.items:
                if item.status == QUEUED:
                    item.status = NOT_SENT
                elif item.status == SENDING:  # safety net; every path should settle it
                    item.status = UNCERTAIN
                    item.note = item.note or f"The outcome is unknown. {CHECK_AGAIN}"
            self.state, self.message, self.current = state, message, ""
            self._transfer = None

    def _run(self):
        try:
            for item in self.items:
                if item.status != QUEUED:
                    continue
                while not self._running.wait(0.2):
                    pass
                if self._stop.is_set():
                    raise _EndJob("stopped", "Stopped. Files not sent yet can be planned again.")
                if not self.valid():
                    raise _EndJob("stopped", "The iBroadcast session changed.")
                with self._lock:
                    item.status, self.current = SENDING, item.label
                self._send(item)
            self._verify()
            self._finish("done")
        except _EndJob as end:
            self._finish(end.state, end.message)
        except Exception as error:  # never leave the job running blindly
            self._finish("failed", str(error) or error.__class__.__name__)

    def _progress(self, item):
        def update(sent):
            with self._lock:
                item.sent = sent
        return update

    def _new_transfer(self):
        transfer = Transfer(self._stop, self.valid)
        with self._lock:
            self._transfer = transfer
        if self._stop.is_set():
            transfer.abort()
        return transfer

    def _settle(self, item, transfer, status, note, during):
        """A file whose request may have left this computer is uncertain, never failed."""
        if transfer.body_started:
            item.status, item.note = UNCERTAIN, f"{during} iBroadcast may have received it. {CHECK_AGAIN}"
        else:
            item.status, item.note = status, note

    def _send(self, item):
        transfer = self._new_transfer()
        try:
            try:
                item.track_id = self.service.upload(item, transfer, on_bytes=self._progress(item))
            except UncertainUpload as error:
                problem = str(error)
            except Stopped:
                self._settle(item, transfer, STOPPED, "Stopped before sending.",
                             "Stopped during the transfer.")
                raise _EndJob("stopped", "Stopped. Files not sent yet can be planned again.") from None
            except SessionChanged as error:
                self._settle(item, transfer, STOPPED, f"{error} Not sent.",
                             "The session changed during the transfer.")
                raise _EndJob("stopped", str(error)) from None
            except FileChanged as error:
                self._settle(item, transfer, FAILED, f"{error} Plan the upload again.",
                             "The transfer was cut off because the file changed.")
                return
            except (AuthRejected, Unreachable) as error:
                item.status, item.note = FAILED, f"{error} Not uploaded."
                raise _EndJob("failed", f"{error} The remaining files were not sent.") from None
            except UploadError as error:
                item.status, item.note = FAILED, str(error)
                return
            except OSError as error:
                self._settle(item, transfer, FAILED,
                             f"Could not read the file ({error.strerror}).",
                             "The transfer ended with a read error.")
                return
            except Exception as error:  # e.g. the client's NotConnected after a failed refresh
                message = str(error) or error.__class__.__name__
                self._settle(item, transfer, FAILED, message, f"{message}.")
                raise _EndJob("failed", message) from None
            else:
                item.status = SENT
                return
        finally:
            transfer.close()
        self._confirm(item, problem)

    def _confirm(self, item, problem):
        """After an unclear answer: look for the file's MD5, never send it again."""
        item.status, item.note = UNCERTAIN, f"{problem} {CHECK_AGAIN}"
        for delay in RETRY_DELAYS:
            if self._stop.wait(delay):
                raise _EndJob("stopped", "Stopped. Files not sent yet can be planned again.")
            transfer = self._new_transfer()
            try:
                present = item.md5 in self.service.remote_md5s(transfer)
            except Stopped:
                raise _EndJob("stopped", "Stopped. Files not sent yet can be planned again.") from None
            except SessionChanged as error:
                raise _EndJob("stopped", str(error)) from None
            except AuthRejected as error:
                raise _EndJob("failed", str(error)) from None
            except UploadError as error:
                raise _EndJob("failed", f"Could not check an unclear upload ({error}). "
                              "The remaining files were not sent.") from None
            finally:
                transfer.close()
            if present:
                item.status, item.note = CONFIRMED, "Listed by iBroadcast after an unclear answer."
                return

    def _verify(self):
        """Read back: look for every sent or uncertain file in a fresh MD5 list."""
        checked = [item for item in self.items if item.status in (SENT, CONFIRMED, UNCERTAIN)]
        if not checked:
            return
        with self._lock:
            self.current = ""
            self.message = "Checking iBroadcast's list of uploaded files."
        transfer = self._new_transfer()
        try:
            remote = self.service.remote_md5s(transfer)
        except Stopped:
            raise _EndJob("stopped", "Stopped before the uploads were checked.") from None
        except SessionChanged as error:
            raise _EndJob("stopped", str(error)) from None
        except AuthRejected as error:
            raise _EndJob("failed", str(error)) from None
        except UploadError as error:
            for item in checked:
                if item.status == SENT:
                    item.note = f"Not verified: {error}"
            return
        finally:
            transfer.close()
        for item in checked:
            item.verified = item.md5 in remote
            if item.status == UNCERTAIN and item.verified:
                item.status, item.note = CONFIRMED, "Listed by iBroadcast after an unclear answer."
            elif item.status == SENT and not item.verified:
                item.note = "Confirmed by the upload answer, but not listed yet."
