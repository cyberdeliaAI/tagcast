"""Admission and request draining for the shared local server.

Only complete, admitted actions can mutate. Idle sockets and playback are safe to
interrupt; accepted actions and their read-backs are drained without killing them.
"""

import socket
import threading
from contextlib import contextmanager

from .errors import CodedError


class ServerClosing(CodedError):
    def __init__(self, message):
        super().__init__(message, code="app.closing")


def close_socket(connection):
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def interrupt_response(response):
    """Wake a blocked audio read before close() can wait on its buffered-reader lock."""
    raw = getattr(response, "raw", None)
    connection = getattr(raw, "_connection", None)
    sock = getattr(connection, "sock", None)
    if sock is None:
        fp = getattr(getattr(raw, "_fp", None), "fp", None)
        sock = getattr(getattr(fp, "raw", None), "_sock", None)
    if isinstance(sock, socket.socket):
        close_socket(sock)
    # Even a third-party close implementation must not block the shutdown coordinator.
    threading.Thread(target=response.close, daemon=True, name="tagcast-stream-close").start()


class RequestDrain:
    """Mixin: register accepted sockets before spawning handlers; keep listener until drained."""

    def __init__(self, *args, **kwargs):
        self.closing = threading.Event()
        self.serving = threading.Event()
        self.shutdown_drained = False
        self.request_lock = threading.Lock()
        self.requests = {}
        self.shutdown_uncertain = False
        self.services_stopped = threading.Event()
        self.services_stopped.set()
        self.services_failed = False
        super().__init__(*args, **kwargs)

    def serve_forever(self, *args, **kwargs):
        self.serving.set()
        try:
            return super().serve_forever(*args, **kwargs)
        finally:
            self.serving.clear()

    def process_request(self, request, address):
        with self.request_lock:
            self.requests[request] = {"phase": "receiving", "upstream": None}
        try:
            super().process_request(request, address)
        except BaseException:
            with self.request_lock:
                self.requests.pop(request, None)
            raise

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        finally:
            with self.request_lock:
                self.requests.pop(request, None)

    @contextmanager
    def request_work(self, connection, phase):
        with self.request_lock:
            if self.closing.is_set() and phase not in ("poll", "identity"):
                raise ServerClosing("Tagcast is closing. This request was not started.")
            entry = self.requests.get(connection)
            if entry is not None:
                entry["phase"] = phase
        try:
            yield
        finally:
            with self.request_lock:
                # Accepted writes include delivery of their result/job ID. Keep
                # them protected until shutdown_request removes the handler.
                if entry is not None and phase != "write":
                    entry["phase"] = "responding"

    @contextmanager
    def stream_reader(self, connection, upstream):
        with self.request_lock:
            entry = self.requests.get(connection)
            if entry is not None:
                entry.update(phase="stream", upstream=upstream)
            closing = self.closing.is_set()
        if closing:
            interrupt_response(upstream)
            close_socket(connection)
        try:
            yield
        finally:
            with self.request_lock:
                if entry is not None:
                    entry.update(phase="responding", upstream=None)

    def note_outcome(self, value):
        if not isinstance(value, dict):
            return
        unknown = value.get("status") in ("unverified", "unconfirmed", "uncertain") or value.get("outcome") == "unknown"
        with self.request_lock:
            if self.closing.is_set() and unknown:
                self.shutdown_uncertain = True

    def interrupt_connections(self, final=False):
        with self.request_lock:
            entries = [(connection, entry["phase"], entry["upstream"])
                       for connection, entry in self.requests.items()]
            for entry in self.requests.values():
                if entry["phase"] == "stream":
                    entry["upstream"] = None  # Interrupt each reader once, including a stuck close().
        for connection, phase, upstream in entries:
            if phase == "stream" and upstream is not None:
                interrupt_response(upstream)
            if final or phase == "stream":
                close_socket(connection)

    def stop_services(self, studio):
        if not self.services_stopped.is_set():
            return
        self.services_stopped.clear()
        self.services_failed = False
        def run():
            import logging
            workers = []
            def stop(action):
                try:
                    if action() is True:
                        self.shutdown_uncertain = True
                except Exception:
                    self.services_failed = True
                    logging.exception("A local service could not stop")
            for action in (studio.queue_sync.disconnect, studio.audio_downloads.shutdown,
                           studio.music_uploads.shutdown, lambda: studio.metadata_export.close(permanent=False)):
                worker = threading.Thread(target=stop, args=(action,), daemon=True)
                workers.append(worker)
                worker.start()
            for worker in workers:
                worker.join()
            self.services_stopped.set()
        threading.Thread(target=run, daemon=True, name="tagcast-stop-services").start()

    def pending_requests(self):
        # Partial headers/bodies cannot mutate past the admission gate. Leave
        # them usable for job polling until finish acknowledgment, then close
        # every remaining socket before joining HTTP handlers.
        with self.request_lock:
            phases = [entry["phase"] for entry in self.requests.values()]
        return {"writes": phases.count("write"),
                "reads": sum(phase in ("read", "stream") for phase in phases)}


def drain_server(server, progress=lambda _state: None, commands=None):
    """Drain accepted work, or resume serving on an explicit parent request.

    A slow native read keeps its existing network timeout. Reopening is the safe
    recovery path for a blocked operation; it never kills or replays that operation.
    """
    import queue
    import time

    handler = getattr(server.RequestHandlerClass, "func", server.RequestHandlerClass)
    studio = handler.studio
    if studio is None:
        return True
    started = time.monotonic()
    server.closing.set()
    old_finished = set()
    tracked_checks = {}
    if studio.lock.acquire(timeout=.02):
        try:
            old_finished = {key for key, job in studio.jobs.items() if job.get("state") != "checking"}
            tracked_checks.update(studio.readbacks)
        finally:
            studio.lock.release()
    server.shutdown_uncertain = False
    studio._device_stop.set()
    services_started = False
    last = None
    acknowledged = commands is None
    while True:
        if commands is not None:
            try:
                while True:
                    command = commands.get_nowait()
                    if command == "resume":
                        server.closing.clear()
                        active_client = studio.client
                        if active_client is not None:
                            active_client.quiesce_refresh(False)
                        return False
                    if command in ("finish", "eof"):
                        acknowledged = True
            except queue.Empty:
                pass
        # An already-admitted start can clear a batch stop flag. Reassert between
        # iterations, without interrupting its accepted request or native read-back.
        studio.audio_downloads.picker_stop.set()
        studio.cleanup.stop.set()
        studio.duplicate_cleanup.stop.set()
        server.interrupt_connections()
        pending = server.pending_requests()
        # An admitted start may still create a worker. Stop/join services after
        # those actions return, so no late worker can escape the stop pass.
        if not services_started and not pending["writes"]:
            server.stop_services(studio)
            services_started = True
        if studio.lock.acquire(timeout=.02):
            try:
                tracked_checks.update(studio.readbacks)
                tracked_checks.update({key: job for key, job in studio.jobs.items() if key not in old_finished})
                jobs = list(tracked_checks.values())
                checks = sum(job.get("state") == "checking" for job in jobs)
                uncertain = server.shutdown_uncertain or any(job.get("state") == "error" or any(
                    row.get("status") in ("unverified", "unconfirmed", "uncertain")
                    for row in job.get("results", [])) for job in jobs)
            finally:
                studio.lock.release()
            locked = False
        else:
            locked, checks, uncertain = True, 0, server.shutdown_uncertain
        writing, caching = studio.save_lock.locked(), studio.cache_lock.locked()
        services = not services_started or not server.services_stopped.is_set() or server.services_failed
        ready = not (pending["writes"] or pending["reads"] or writing or checks or caching or locked or services)
        active_client = studio.client
        credentials = active_client is not None and not active_client.refresh_idle.is_set()
        if ready and active_client is not None:
            ready = active_client.quiesce_refresh()
            credentials = not ready
        if credentials:
            ready = False
            pending["writes"] += 1
        phase = "ready" if ready else "writes" if pending["writes"] or writing or locked else "checking" if checks else "reads" if pending["reads"] else "services" if services else "cache"
        state = {"phase": phase, **pending, "checks": checks, "uncertain": bool(uncertain),
                 "elapsed": int(time.monotonic() - started)}
        if state != last:
            progress(state)
            last = state
        if ready and acknowledged:
            # Close the listener only now. A second process cannot bind/reuse this
            # port while an accepted mutation is still being completed.
            server.shutdown_drained = True
            if server.serving.is_set():
                server.shutdown()
            server.interrupt_connections(final=True)
            return True
        time.sleep(.05)
