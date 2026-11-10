"""Shutdown races over real loopback HTTP; synthetic operations, no real account."""

import json
import queue
import socket
import tempfile
import threading
import time
import unittest
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import requests

from tagcast import app, client, electron_host


class DrainTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.studio = client.Studio(self.home.name)
        handler = type("TestHandler", (app.Handler,), {"studio": self.studio, "port": 0})
        self.server = app.Server(("127.0.0.1", 0), partial(handler, directory=str(app.STATIC)))
        handler.port = self.server.server_port
        self.url = f"http://127.0.0.1:{handler.port}"
        self.serving = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02})
        self.serving.start()
        self.commands, self.states = queue.Queue(), queue.Queue()
        self.releases, self.workers = [], []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for event in self.releases:
            event.set()
        self.commands.put("finish")
        for worker in self.workers:
            worker.join(timeout=5)
        if not self.server.shutdown_drained:
            electron_host.finish_server(self.server)
        self.serving.join(timeout=5)
        self.home.cleanup()

    def gate(self):
        event = threading.Event()
        self.releases.append(event)
        return event

    def launch(self, action):
        worker = threading.Thread(target=action)
        self.workers.append(worker)
        worker.start()
        return worker

    def drain(self):
        return self.launch(lambda: electron_host.finish_server(self.server, self.states.put, self.commands))

    def state(self, phase):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = self.states.get(timeout=5)
            if state["phase"] == phase:
                return state
        self.fail(f"No {phase} shutdown phase")

    def post(self, path="/api/save", body=None):
        request = Request(self.url + path, data=json.dumps(body or {}).encode(), headers={"X-Tagcast": "1"})
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def test_accepted_write_then_readback_retains_listener_and_never_resends(self):
        entered, sent, check = self.gate(), self.gate(), self.gate()
        calls, replies = [], []
        def save(_changes):
            with self.studio.save_lock:
                calls.append("send")
                entered.set()
                sent.wait()
                with self.studio.lock:
                    self.studio.jobs["test"] = {"state": "checking"}
                def verify():
                    check.wait()
                    calls.append("readback")
                    with self.studio.lock:
                        self.studio.jobs["test"] = {"state": "done", "results": [{"status": "saved"}]}
                self.launch(verify)
                return {"job": "test"}
        with patch.object(self.studio, "save", save):
            request = self.launch(lambda: replies.append(self.post()))
            self.assertTrue(entered.wait(3))
            closing = self.drain()
            self.state("writes")
            with self.assertRaises(OSError), socket.socket() as probe:
                probe.bind(("127.0.0.1", self.server.server_port))
            with self.assertRaises(HTTPError) as error:
                self.post()
            self.assertEqual(error.exception.code, 503)
            self.assertTrue(closing.is_alive())
            sent.set()
            request.join(timeout=3)
            self.state("checking")
            self.assertEqual(replies, [{"job": "test"}])
            with urlopen(self.url + "/api/jobs/test", timeout=3) as response:
                self.assertEqual(json.load(response)["state"], "checking")
            check.set()
            self.assertFalse(self.state("ready")["uncertain"])
            self.assertTrue(closing.is_alive(), "The renderer still owns the finish acknowledgment")
            self.commands.put("finish")
            closing.join(timeout=3)
            self.assertFalse(closing.is_alive())
            self.assertEqual(calls, ["send", "readback"])

    def test_failed_readback_is_explicit_and_resume_keeps_same_session(self):
        with self.studio.lock:
            self.studio.jobs["test"] = {"state": "checking"}
        session = self.studio.playback_session
        closing = self.drain()
        self.state("checking")
        with self.studio.lock:
            self.studio.jobs["test"] = {"state": "error", "error": "Synthetic outage"}
        self.assertTrue(self.state("ready")["uncertain"])
        self.commands.put("resume")
        closing.join(timeout=3)
        self.assertFalse(self.server.closing.is_set())
        self.assertEqual(self.studio.playback_session, session)
        self.assertEqual(self.studio.jobs["test"]["state"], "error")
        with urlopen(self.url + "/api/status", timeout=3) as response:
            self.assertEqual(response.status, 200)

    def test_slow_read_can_resume_without_killing_it(self):
        entered, release = self.gate(), self.gate()
        def status():
            entered.set()
            release.wait()
            return {"connected": False}
        with patch.object(self.studio, "status", status):
            request = self.launch(lambda: urlopen(self.url + "/api/status", timeout=10).close())
            self.assertTrue(entered.wait(3))
            closing = self.drain()
            self.state("reads")
            self.commands.put("resume")
            closing.join(timeout=3)
            self.assertFalse(closing.is_alive())
            self.assertTrue(request.is_alive())
            release.set()
            request.join(timeout=3)
            self.assertFalse(request.is_alive())

    def test_closing_retains_host_fetch_metadata_and_post_header_guards(self):
        self.drain()
        self.state("ready")
        for path in ("/api/app", "/api/status", "/api/jobs/test"):
            for headers in ({"Host": "foreign.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(self.url + path, headers=headers), timeout=3)
                self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + "/api/save", data=b"{}"), timeout=3)
        self.assertEqual(error.exception.code, 403)

    def test_cleanup_stop_is_reasserted_after_admitted_start(self):
        entered, release = self.gate(), self.gate()
        def start(_id, _excluded):
            entered.set()
            release.wait()
            self.studio.cleanup.stop.clear()
            self.studio.save_lock.acquire()
            def batch():
                self.studio.cleanup.stop.wait()
                self.studio.save_lock.release()
            self.launch(batch)
            return {"state": "running"}
        with patch.object(self.studio.cleanup, "start", start):
            self.launch(lambda: self.post("/api/cleanup/start"))
            self.assertTrue(entered.wait(3))
            self.drain()
            self.state("writes")
            release.set()
            self.state("ready")
            self.assertTrue(self.studio.cleanup.stop.is_set())
            self.assertFalse(self.studio.save_lock.locked())

    def test_native_storage_lock_is_drained_and_resume_does_not_wait_on_it(self):
        self.studio.cache_lock.acquire()
        closing = self.drain()
        try:
            self.state("cache")
            self.commands.put("resume")
            closing.join(timeout=3)
            self.assertFalse(closing.is_alive())
        finally:
            self.studio.cache_lock.release()

    def test_token_persistence_is_drained_after_shared_refresh_gate_releases(self):
        entered, release = self.gate(), self.gate()
        persisted = []
        def store(tokens):
            entered.set()
            release.wait()
            persisted.append(tokens.refresh_token)
        active = client.StudioClient(access_token="synthetic", refresh_token="old", client_id="test",
                                     token_refreshed_callback=store)
        self.studio.client = active
        tokens = client.oauth.TokenSet("new", "rotated", time.time() + 3600)
        with patch.object(client.auth, "refresh_access_token", return_value=tokens) as refresh:
            self.launch(active._refresh)
            self.assertTrue(entered.wait(3))
            self.assertIsNone(active._refreshing, "Waiters must wake before persistence")
            closing = self.drain()
            self.state("writes")
            self.assertTrue(closing.is_alive())
            release.set()
            self.state("ready")
            self.assertEqual(persisted, ["rotated"])
            with self.assertRaises(client.ConnectionUnavailable):
                active._refresh()
            self.assertEqual(refresh.call_count, 1)
            self.commands.put("resume")
            closing.join(timeout=3)
            active._refresh()
            self.assertEqual(refresh.call_count, 2)

    def test_active_stalled_audio_read_is_interrupted(self):
        started, release = self.gate(), self.gate()
        class Audio(BaseHTTPRequestHandler):
            def do_GET(_self):
                _self.send_response(200)
                _self.send_header("Content-Type", "audio/mpeg")
                _self.end_headers()
                _self.wfile.write(b"synthetic")
                _self.wfile.flush()
                started.set()
                release.wait()
            def log_message(_self, *_args):
                pass
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Audio)
        worker = threading.Thread(target=upstream.serve_forever)
        worker.start()
        response = requests.get(f"http://127.0.0.1:{upstream.server_port}", stream=True, timeout=30)
        self.assertTrue(started.wait(3))
        try:
            with patch.object(self.studio, "stream", return_value=(response, "audio/mpeg")):
                connection = requests.get(self.url + "/api/stream/1", stream=True, timeout=3)
                try:
                    closing = self.drain()
                    self.state("ready")
                    self.commands.put("finish")
                    closing.join(timeout=3)
                    self.assertFalse(closing.is_alive(), "The upstream never sent EOF")
                    self.assertFalse(release.is_set())
                finally:
                    connection.close()
        finally:
            release.set()
            upstream.shutdown()
            upstream.server_close()
            worker.join(timeout=3)

    def test_late_transfer_start_is_stopped_and_joined_before_ready(self):
        entered, create, finish = self.gate(), self.gate(), self.gate()
        def start(_body):
            entered.set()
            create.wait()
            self.studio.audio_downloads.thread = self.launch(lambda: finish.wait())
            return {"state": "running"}
        with patch.object(self.studio.audio_downloads, "start", start):
            self.launch(lambda: self.post("/api/downloads/start"))
            self.assertTrue(entered.wait(3))
            closing = self.drain()
            self.state("writes")
            create.set()
            self.state("services")
            self.assertTrue(closing.is_alive())
            self.assertTrue(self.studio.audio_downloads.stop.wait(3))
            finish.set()
            self.state("ready")

    def test_session_replacement_while_checking_keeps_existing_ownership_guards(self):
        entered, release = self.gate(), self.gate()
        def current(*_args, **_kwargs):
            entered.set()
            release.wait()
            raise client.NotConnected("Synthetic replaced account")
        with patch.object(self.studio, "_current", current):
            job = self.studio._check_later(None, 0, lambda _: [], include_albums=False)
            self.assertTrue(entered.wait(3))
            closing = self.drain()
            self.state("checking")
            self.studio.logout()
            self.assertNotIn(job, self.studio.jobs)
            self.assertTrue(closing.is_alive())
            release.set()
            self.assertTrue(self.state("ready")["uncertain"])
            self.assertEqual(self.studio.readbacks, {})
            self.assertNotIn(job, self.studio.jobs)
            self.assertIsNone(self.studio.client)

    def test_replaced_download_worker_is_joined_before_shutdown_finishes(self):
        release = self.gate()
        old = self.launch(lambda: release.wait())
        self.studio.audio_downloads._workers.append((old, None))
        self.studio.logout()
        closing = self.drain()
        self.state("services")
        self.assertTrue(closing.is_alive())
        release.set()
        self.state("ready")
        self.assertFalse(old.is_alive())
