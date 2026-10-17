"""Electron's child process owns only its own server and preserves API guards."""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock
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
        threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
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
        for identity in ({"application": "Other"}, {"application": "Tagcast", "version": "0.42.0", "desktop_protocol": 1}):
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
        studio = types.SimpleNamespace(cleanup=types.SimpleNamespace(stop=threading.Event()),
                                       duplicate_cleanup=types.SimpleNamespace(stop=threading.Event()),
                                       save_lock=threading.Lock(), cache_lock=threading.Lock(),
                                       lock=threading.Lock(), jobs={"job": {"state": "checking"}})
        server = MagicMock()
        server.RequestHandlerClass.func.studio = studio
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
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()
