"""HTTP framing and static-file guards, before any mutation is admitted."""

import copy
import io
import tempfile
import threading
import unittest
from contextlib import closing
from email.message import Message
from functools import partial
from http.client import HTTPConnection, HTTPResponse
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from tagcast import app


class BodyLengthTests(unittest.TestCase):
    def handler(self, values=(), body=b"", transfer=None):
        headers = Message()
        for value in values:
            headers.add_header("Content-Length", value)
        if transfer is not None:
            headers.add_header("Transfer-Encoding", transfer)
        return SimpleNamespace(headers=headers, rfile=io.BytesIO(body), close_connection=False)

    def test_invalid_or_ambiguous_lengths_never_read_a_body(self):
        for values in (("-1",), ("+2",), ("",), ("  ",), ("1.5",), ("0x10",),
                       ("two",), ("2, 2",), ("2", "2"), ("2", "3"), ("²",)):
            with self.subTest(values=values):
                handler = self.handler(values)
                handler.rfile = Mock()
                with self.assertRaises(app.ApiError):
                    app.Handler._body(handler)
                handler.rfile.read.assert_not_called()
                self.assertTrue(handler.close_connection)

    def test_unsupported_transfer_encoding_never_reads_a_body(self):
        for values in ((), ("2",)):
            handler = self.handler(values, transfer="chunked")
            handler.rfile = Mock()
            with self.assertRaises(app.ApiError):
                app.Handler._body(handler)
            handler.rfile.read.assert_not_called()

    def test_oversize_and_extreme_digit_counts_are_bounded_before_reading(self):
        for value in (str(app.MAX_BODY + 1), "9" * 5000):
            handler = self.handler((value,))
            handler.rfile = Mock()
            with self.assertRaises(app.ApiError):
                app.Handler._body(handler)
            handler.rfile.read.assert_not_called()

    def test_empty_and_valid_decimal_lengths_keep_existing_json_behavior(self):
        for values, body in (((), b""), (("0",), b""), (("0000",), b""),
                             (("2",), b"{}"), ((" 0002\t",), b"{}")):
            with self.subTest(values=values):
                handler = self.handler(values, body)
                self.assertEqual(app.Handler._body(handler), {})
                self.assertFalse(handler.close_connection)

    def test_truncated_body_cannot_become_an_empty_accepted_action(self):
        for body in (b"", b"{"):
            with self.assertRaises(app.ApiError):
                app.Handler._body(self.handler(("2",), body))


class HTTPGuardTests(unittest.TestCase):
    def setUp(self):
        self.files = tempfile.TemporaryDirectory()
        self.addCleanup(self.files.cleanup)
        root = Path(self.files.name)
        (root / "index.html").write_text("<script>window.safe=true;</script>")
        (root / "data").mkdir()
        (root / "data/reference.txt").write_text("Synthetic public reference")
        self.settings = tempfile.TemporaryDirectory()
        self.addCleanup(self.settings.cleanup)
        self.studio = app.Studio(self.settings.name)
        self.studio.save_settings = Mock(wraps=self.studio.save_settings)
        self.studio.finish_browser = Mock()
        handler = type("GuardHandler", (app.Handler,), {"studio": self.studio, "port": 0})
        self.server = app.Server(("127.0.0.1", 0), partial(handler, directory=self.files.name))
        handler.port = self.server.server_port
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02})
        self.worker.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.closing.clear()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def request(self, method, path, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_head_enforces_host_and_fetch_metadata_without_running_api_or_oauth(self):
        for path in ("/", "/data/reference.txt", "/api/settings", "/callback?code=synthetic"):
            status, headers, body = self.request("HEAD", path, {"Host": "foreign.invalid"})
            self.assertEqual(status, 403)
            self.assertEqual(body, b"")
            self.assertIn("Content-Security-Policy", headers)
        self.assertEqual(self.request("HEAD", "/api/settings", {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.request("HEAD", "/callback?code=synthetic")
        self.studio.finish_browser.assert_not_called()
        self.studio.save_settings.assert_not_called()

    def test_head_preserves_document_hashes_no_store_and_reference_caching(self):
        status, get_headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        status, head_headers, empty = self.request("HEAD", "/", {"If-None-Match": '"old"', "If-Modified-Since": get_headers["Last-Modified"]})
        self.assertEqual(status, 200)
        self.assertEqual(empty, b"")
        self.assertEqual(head_headers["Content-Length"], str(len(body)))
        self.assertEqual(head_headers["Content-Security-Policy"], get_headers["Content-Security-Policy"])
        self.assertIn("'sha256-", head_headers["Content-Security-Policy"])
        self.assertEqual(head_headers["Cache-Control"], "no-store")
        self.assertNotIn("Cache-Control", self.request("HEAD", "/data/reference.txt")[1])

    def test_directory_listing_is_denied_but_explicit_files_remain_readable(self):
        for method in ("GET", "HEAD"):
            status, headers, body = self.request(method, "/data/")
            self.assertEqual(status, 403)
            self.assertNotIn(b"reference.txt", body)
            self.assertIn("Content-Security-Policy", headers)
        self.assertEqual(self.request("GET", "/data/reference.txt")[0], 200)

    def test_head_obeys_shutdown_admission_without_closing_the_listener(self):
        self.server.closing.set()
        self.assertEqual(self.request("HEAD", "/")[0], 503)
        self.assertEqual(self.request("GET", "/api/app")[0], 200)

    def test_malformed_framing_is_rejected_without_waiting_or_mutating(self):
        before = copy.deepcopy(self.studio.config)
        for framing in ("Content-Length: -1", "Content-Length: nonsense", "Content-Length: 2\r\nContent-Length: 3", "Transfer-Encoding: chunked"):
            with self.subTest(framing=framing), closing(HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)) as connection:
                connection.connect()
                connection.sock.sendall((f"POST /api/settings HTTP/1.0\r\nHost: 127.0.0.1:{self.server.server_port}\r\nX-Tagcast: 1\r\n{framing}\r\n\r\n").encode())
                with HTTPResponse(connection.sock) as response:
                    response.begin()
                    self.assertEqual(response.status, 400)
                    response.read()
        self.studio.save_settings.assert_not_called()
        self.assertEqual(self.studio.config, before)
