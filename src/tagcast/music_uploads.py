"""Opt-in, reviewed local music uploads through Tagcast's existing OAuth session.

Preparation reads only explicitly chosen paths. Plans/jobs are memory-only, tied
to the captured account and session. Only the local hash index persists. This is
not folder synchronisation: it never watches folders or removes library tracks.
"""

import re
import secrets
import threading
import time
from pathlib import Path

from . import uploads as engine
from .library import ConflictError, LibraryError

MAX_ROOTS = 100
MAX_FILES = 1000
PAGE_SIZE = 50
REVIEW_LIFETIME = 15 * 60
ACTIVE = {"ready", "running", "paused"}
PREPARATION_ERRORS = {
    "types": "iBroadcast's supported file types could not be read. Check your connection and upload permission, then prepare again.",
    "missing_types": "iBroadcast returned no usable supported file types. No files were uploaded. Try preparing again later.",
    "duplicates": "iBroadcast's list of uploaded files could not be read. No files were uploaded. Try preparing again later.",
    "scan": "The selected files or folders could not be scanned. Check file access and choose at most 1,000 audio files.",
    "hash": "The selected files could not be checked. Check file access and available space in Tagcast's settings folder.",
}


def upload_authorized(client):
    scopes = getattr(getattr(client, "token_set", None), "scope", None)
    return isinstance(scopes, (list, tuple, set, frozenset)) and engine.UPLOAD_SCOPE in scopes


class MusicUploads:
    def __init__(self, studio):
        self.studio = studio
        # State uses Studio's reentrant lock; no inverse feature/Studio lock order.
        self.lock = studio.lock
        self.index_lock = threading.Lock()
        self.generation = 0
        self.owner = None
        self.library = None
        self.stop = threading.Event()
        self.transfer = self.job = self.worker = None
        self.items = []
        self.review = None
        self.preparing = False
        self.phase = self.error = ""
        self.checked = self.total = self.ignored = 0

    def _context(self, session):
        s = self.studio
        if not s.client or not s.library or not s.library_user or session != s.playback_session:
            raise ConflictError("Connect iBroadcast and load your library before uploading.")
        if s.config.get("music_uploads") is not True:
            raise LibraryError("Enable Music uploads in Settings → Data & exports first.")
        if not upload_authorized(s.client):
            raise LibraryError("Reconnect iBroadcast to approve the optional upload permission.")
        return s.client, s.library_user, s.playback_session

    def _valid(self, owner, generation):
        with self.lock:
            s = self.studio
            return generation == self.generation and owner == self.owner \
                and s.client is owner[0] and s.library_user == owner[1] \
                and s.playback_session == owner[2] and s.config.get("music_uploads") is True \
                and upload_authorized(owner[0])

    def _busy(self):
        return self.preparing or (self.job is not None and self.job.state in ACTIVE)

    def _bind(self, owner):
        if owner != self.owner:
            self.close()
            self.owner = owner

    def _view(self, page=0):
        if self.review and (self.library is not self.studio.library
                            or time.monotonic() > self.review[1]):
            self.review = None
            self.library = None
            self.phase = "The review expired or the library changed. Prepare again."
        job = dict(self.job.view()) if self.job else None
        rows = job.pop("items") if job else [item.view() for item in self.items]
        # Never relay credentials or complete URLs from provider error messages.
        tokens = getattr(self.owner[0], "token_set", None) if self.owner else None
        def safe(message):
            message = str(message or "")
            for key in ("access_token", "refresh_token"):
                secret = getattr(tokens, key, None)
                if isinstance(secret, str) and secret:
                    message = message.replace(secret, "[redacted]")
            return re.sub(r"https?://[^\s]+", "[service URL]", message)[:1000]
        if job:
            job["message"] = safe(job["message"])
        for row in rows:
            row["note"] = safe(row["note"])
        page = max(0, min(page, max(0, (len(rows) - 1) // PAGE_SIZE)))
        return {"preparing": self.preparing, "phase": self.phase, "error": self.error,
                "checked": self.checked, "total": self.total, "ignored": self.ignored,
                "review": self.review[0] if self.review else None,
                "summary": engine.plan_summary(self.items), "job": job,
                "page": page, "pages": max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE),
                "items": rows[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]}

    def view(self, session, page=0):
        try:
            page = int(page)
        except (TypeError, ValueError):
            raise LibraryError("Choose a valid uploads page.") from None
        with self.lock:
            self._bind(self._context(session))
            return self._view(page)

    def prepare(self, body):
        roots = body.get("paths")
        if not isinstance(roots, list) or not 1 <= len(roots) <= MAX_ROOTS \
                or any(not isinstance(p, str) or not p.strip() or len(p) > 4096
                       or "\0" in p or "\n" in p or "\r" in p for p in roots):
            raise LibraryError("Choose between 1 and 100 complete file or folder paths.")
        paths = [Path(p).expanduser() for p in roots]
        if any(not p.is_absolute() for p in paths):
            raise LibraryError("Choose complete local file or folder paths.")
        with self.lock:
            owner = self._context(body.get("session"))
            self._bind(owner)
            if self._busy():
                raise ConflictError("Stop the current upload task before preparing another.")
            self.generation += 1
            generation = self.generation
            self.stop = stop = threading.Event()
            self.items, self.job, self.review, self.error = [], None, None, ""
            self.library = self.studio.library
            self.preparing, self.phase = True, "Checking upload permission and supported file types…"
            self.checked = self.total = self.ignored = 0
            self.worker = threading.Thread(target=self._prepare, args=(owner, generation, paths, stop),
                                           name="tagcast-upload-plan", daemon=True)
            self.worker.start()
            return self._view()

    def _prepare(self, owner, generation, paths, stop):
        def valid():
            return not stop.is_set() and self._valid(owner, generation)
        transfer = engine.Transfer(stop, valid)
        stage = "types"
        try:
            with self.lock:
                if not valid():
                    return
                self.transfer = transfer
            # Existing JSON transport supplies its shared OAuth refresh gate.
            # This status read is read-only; reject its result if the captured
            # session changed while the request was in flight.
            transfer.begin()
            status = owner[0]._jsonrequest("status", supported_types=True)
            if not valid():
                return
            extensions = engine.supported_extensions(status)
            if not extensions:
                stage = "missing_types"
                raise engine.UploadError("iBroadcast did not provide its supported audio file types.")
            stage = "duplicates"
            with self.lock:
                if not valid():
                    return
                self.phase = "Checking files already uploaded to iBroadcast…"
            service = engine.UploadService(owner[0])
            remote = service.remote_md5s(transfer)
            stage = "scan"
            with self.lock:
                if not valid():
                    return
                self.phase = "Scanning the selected files and folders…"
            files, ignored = engine.scan(paths, extensions, stop=stop, limit=MAX_FILES)
            stage = "hash"
            with self.lock:
                if not valid():
                    return
                self.total, self.ignored = len(files), ignored
                self.phase = "Reading selected files and checking for identical uploads…"

            def progress(done, total):
                with self.lock:
                    if valid():
                        self.checked, self.total = done, total

            # Cancelled planners may still be unwinding; serialize index writes.
            with self.index_lock:
                if not valid():
                    return
                index = engine.HashIndex(self._read_index, self.studio._write)
                items = engine.plan_uploads(files, extensions, remote, index,
                                            stop=stop, progress=progress)
            with self.lock:
                if valid():
                    self.items = items
                    self.review = (secrets.token_urlsafe(24), time.monotonic() + REVIEW_LIFETIME)
                    self.phase = "Review ready. No music has been uploaded."
        except engine.Stopped:
            pass
        except Exception as error:
            with self.lock:
                if valid():
                    # Provider exceptions can include tokens, paths or full URLs.
                    self.error = PREPARATION_ERRORS[stage]
                    if isinstance(error, engine.AuthRejected):
                        self.error = "iBroadcast did not accept the upload permission. Reconnect iBroadcast, then prepare again."
                    self.phase = "Preparation stopped. No files were uploaded."
        finally:
            transfer.close()
            with self.lock:
                if generation == self.generation:
                    self.preparing, self.transfer = False, None
                    if stop.is_set():
                        self.phase = "Preparation stopped. No files were uploaded."
                    if not self.review:
                        self.library = None

    def _read_index(self, name):
        value = self.studio._read(name)
        return value if isinstance(value, dict) and isinstance(value.get("files", {}), dict) else None

    def start(self, body):
        with self.lock:
            owner = self._context(body.get("session"))
            if owner != self.owner or self._busy() or not self.review \
                    or not secrets.compare_digest(str(body.get("review", "")), self.review[0]) \
                    or time.monotonic() > self.review[1] or self.library is not self.studio.library:
                raise ConflictError("This upload review is no longer current. Prepare again.")
            if not any(item.status == engine.NEW for item in self.items):
                raise LibraryError("There are no new files to upload in this selection.")
            self.review, self.library = None, None  # consume before any audio can leave
            generation = self.generation
            stop = self.stop
            self.job = engine.UploadJob(engine.UploadService(owner[0]), self.items,
                                        valid=lambda: not stop.is_set() and self._valid(owner, generation))
            self.phase = "Uploading reviewed files…"
            self.job.start()
            return self._view()

    def control(self, action, body):
        with self.lock:
            owner = self._context(body.get("session"))
            if owner != self.owner:
                raise ConflictError("The upload session changed.")
            if action == "pause" and self.job:
                self.job.pause()
            elif action == "resume" and self.job:
                self.job.resume()
            elif action == "stop":
                self._stop()
                self.review, self.library = None, None
                self.phase = "Stopping. A file already sent may still arrive in iBroadcast."
            elif action == "clear":
                if self._busy():
                    raise ConflictError("Stop the current upload task first.")
                self.items, self.job, self.review, self.library = [], None, None, None
                self.error = self.phase = ""
            else:
                raise LibraryError("Choose an available upload action.")
            return self._view()

    def _stop(self):
        self.stop.set()
        transfer, job = self.transfer, self.job
        if not transfer and not job:
            return
        # Socket shutdown is deliberately off both the request thread and Studio.lock.
        def abort():
            if transfer:
                transfer.abort()
            if job:
                job.stop()
        threading.Thread(target=abort, name="tagcast-upload-stop", daemon=True).start()

    def close(self):
        with self.lock:
            self._stop()
            self.generation += 1
            self.owner = self.library = self.review = self.job = self.transfer = None
            self.items = []
            self.preparing = False
            self.error = self.phase = ""
