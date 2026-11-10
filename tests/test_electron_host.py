"""Electron's child process owns only its own server and preserves API guards."""

import json
import os
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tagcast import __version__, app, electron_host


class ElectronHostTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)

    def start(self, port=0):
        env = dict(os.environ, TAGCAST_HOME=self.home.name, PYTHONDONTWRITEBYTECODE="1",
                   PYTHONPATH=str(Path(app.__file__).parent.parent))
        process = subprocess.Popen([sys.executable, "-m", "tagcast.electron_host", "--port", str(port)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=env)

        def close():
            if process.poll() is None:
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        self.addCleanup(close)
        lines = queue.Queue()
        self.lines = getattr(self, "lines", {})
        self.lines[process.pid] = lines
        def read():
            for line in process.stdout:
                lines.put(line)
        threading.Thread(target=read, daemon=True).start()
        return process, json.loads(lines.get(timeout=30))

    def stop(self, process):
        process.stdin.write("stop\n")
        process.stdin.flush()
        self.assertEqual(process.wait(timeout=10), 0, process.stderr.read())

    def test_owned_server_serves_shared_assets_and_rejects_foreign_api_requests(self):
        process, ready = self.start()
        self.assertTrue(ready["owned"])
        self.assertEqual(ready["version"], __version__)
        self.assertEqual(ready["protocol"], 1)
        url = ready["url"]
        with urlopen(url + "/api/app", timeout=3) as response:
            self.assertEqual(json.load(response), {"application": "Tagcast", "version": __version__,
                                                   "desktop_protocol": 1})
        with urlopen(url + "/api/status", timeout=3) as response:
            self.assertFalse(json.load(response)["connected"])
        with urlopen(url + "/album.js", timeout=3) as response:
            self.assertEqual(response.headers.get_content_type(), "text/javascript")
            self.assertEqual(response.read(), (app.STATIC / "album.js").read_bytes())
        for headers in ({"Host": "foreign.test"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(url + "/api/app", headers=headers), timeout=3)
            self.assertEqual(error.exception.code, 403)
        self.stop(process)
        with self.assertRaises(OSError):
            urlopen(url + "/api/app", timeout=1)

    def test_parent_pipe_eof_stops_owned_server(self):
        process, ready = self.start()
        process.stdin.close()
        self.assertEqual(process.wait(timeout=10), 0)
        with self.assertRaises(OSError):
            urlopen(ready["url"] + "/api/app", timeout=1)

    @unittest.skipIf(os.name == "nt", "Windows process termination is not a catchable POSIX signal")
    def test_posix_termination_uses_graceful_owned_server_shutdown(self):
        process, ready = self.start()
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        with self.assertRaises(OSError):
            urlopen(ready["url"] + "/api/app", timeout=1)

    def test_reused_server_is_not_stopped(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                body = json.dumps({"application": "Tagcast", "version": __version__,
                                   "desktop_protocol": 1}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        process, ready = self.start(server.server_port)
        self.assertFalse(ready["owned"])
        self.stop(process)
        with urlopen(ready["url"] + "/api/app", timeout=3) as response:
            self.assertEqual(response.status, 200)

    def test_foreign_or_old_server_is_rejected_without_replacing_it(self):
        for identity in ({"application": "Other"}, {"application": "Tagcast", "version": "0.42.0", "desktop_protocol": 1},
                         {"application": "Tagcast", "version": __version__, "desktop_protocol": 1, "closing": True}):
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    body = json.dumps(identity).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                process, ready = self.start(server.server_port)
                self.assertEqual(ready["event"], "error")
                self.assertEqual(process.wait(timeout=5), 1)
                self.assertNotEqual(server.fileno(), -1)
                self.assertNotIn("owned", ready)
            finally:
                server.shutdown()
                server.server_close()

    def test_shutdown_stops_batches_and_waits_for_writes_and_readback(self):
        with patch.dict(os.environ, TAGCAST_HOME=self.home.name), patch.object(app, "_log_to_file"):
            server = app.open_server(0)
        studio = server.RequestHandlerClass.func.studio
        studio.jobs["job"] = {"state": "checking"}
        serving = threading.Thread(target=server.serve_forever)
        serving.start()
        studio.save_lock.acquire()
        worker = threading.Thread(target=electron_host.finish_server, args=(server,))
        worker.start()
        self.assertTrue(studio.cleanup.stop.wait(timeout=2))
        self.assertTrue(studio.duplicate_cleanup.stop.is_set())
        self.assertTrue(worker.is_alive())
        studio.save_lock.release()
        time.sleep(.15)
        self.assertTrue(worker.is_alive(), "Read-back must finish before exit")
        with studio.lock:
            studio.jobs["job"]["state"] = "done"
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        serving.join(timeout=2)
        self.assertFalse(serving.is_alive())
        self.assertEqual(server.fileno(), -1)

    def test_idle_tcp_and_incomplete_post_do_not_hold_backend_alive(self):
        for payload in (b"", b"POST /api/save HTTP/1.1\r\nHost: 127.0.0.1:PORT\r\nX-Tagcast: 1\r\nContent-Length: 100\r\n\r\n{"):
            process, ready = self.start()
            from urllib.parse import urlparse
            port = urlparse(ready["url"]).port
            with socket.create_connection(("127.0.0.1", port), timeout=3) as idle:
                if payload:
                    idle.sendall(payload.replace(b"PORT", str(port).encode()))
                self.stop(process)  # The client stays open throughout shutdown.

    def test_controlled_drain_holds_port_rejects_reuse_and_can_resume(self):
        process, ready = self.start()
        self.assertEqual(ready["shutdown_control"], 1)
        process.stdin.write("drain\n")
        process.stdin.flush()
        while json.loads(self.lines[process.pid].get(timeout=5))["phase"] != "ready":
            pass
        self.assertIsNone(process.poll(), "The renderer has not acknowledged shutdown")
        with urlopen(ready["url"] + "/api/app", timeout=3) as response:
            self.assertTrue(json.load(response)["closing"])
        with self.assertRaises(HTTPError) as error:
            urlopen(ready["url"] + "/api/status", timeout=3)
        self.assertEqual(error.exception.code, 503)
        from urllib.parse import urlparse
        second, rejected = self.start(urlparse(ready["url"]).port)
        self.assertEqual(rejected["event"], "error")
        self.assertEqual(second.wait(timeout=5), 1)
        process.stdin.write("resume\n")
        process.stdin.flush()
        self.assertEqual(json.loads(self.lines[process.pid].get(timeout=5))["event"], "resumed")
        with urlopen(ready["url"] + "/api/status", timeout=3) as response:
            self.assertEqual(response.status, 200)
        self.stop(process)
