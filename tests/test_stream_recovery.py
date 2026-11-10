"""Recovery classifies existing, bounded stream observations without upstream probes."""

import json
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

from tagcast import app, client


class StreamRecoveryTests(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.studio = client.Studio(home.name)
        self.transport = self.studio.client = Mock()
        self.studio.library = Mock(expires=1999999999)
        self.studio.library.stream_info.return_value = ("/128/test/1", "audio/mpeg")
        self.studio.library_user = "7"
        self.studio.playback_session = self.session = "stream-test-session"
        self.request = "stream-request-123456"

    def stream(self):
        return self.studio.stream("1", "bytes=1-10", "128", request_id=self.request,
                                  playback_session=self.session)

    def state(self):
        return self.studio.stream_status(self.request, self.session)["state"]

    def test_header_outcomes_classify_failures_without_a_second_upstream_request(self):
        for status, expected in ((200, "available"), (206, "available"), (401, "auth"),
                                 (403, "auth"), (404, "unavailable"), (416, "unavailable"),
                                 (408, "network"), (429, "unavailable"), (500, "network"),
                                 (502, "network"), (503, "network"), (504, "network")):
            with self.subTest(status=status):
                self.studio.stream_results.clear()
                self.transport.reset_mock()
                self.transport.open_stream.return_value = Mock(status_code=status, ok=200 <= status < 400)
                if status >= 400 and status != 416:
                    with self.assertRaises(client.ApiError):
                        self.stream()
                else:
                    self.stream()
                for _ in range(3):
                    self.assertEqual(self.state(), expected)
                self.transport.open_stream.assert_called_once_with("/128/test/1", 1, "7", 1999999999, "bytes=1-10")
                self.transport._jsonrequest.assert_not_called()
                self.transport.fetch_library.assert_not_called()

    def test_transport_tls_and_missing_tracks_are_distinct(self):
        for error, expected in ((client.ConnectionUnavailable("offline"), "network"),
                                (client.ConnectionSecurityError("TLS"), "security"),
                                (client.NotConnected("token rejected"), "auth")):
            with self.subTest(state=expected):
                self.studio.stream_results.clear()
                self.transport.open_stream.side_effect = error
                with self.assertRaises(client.ApiError):
                    self.stream()
                self.assertEqual(self.state(), expected)

    def test_session_replacement_rejects_late_results_and_never_opens_a_foreign_stream(self):
        self.studio.record_stream_result(self.request, self.session, "network")
        self.studio.playback_session = "replacement-session"
        self.studio.record_stream_result(self.request, self.session, "auth")
        with self.assertRaises(client.NotConnected):
            self.studio.stream_status(self.request, self.session)
        self.assertEqual(self.studio.stream_status(self.request, "replacement-session"), {"state": "unknown"})
        with self.assertRaises(client.NotConnected):
            self.stream()
        self.transport.open_stream.assert_not_called()
        self.studio.client = None
        with self.assertRaises(client.NotConnected):
            self.studio.stream_status(self.request, "replacement-session")

    def test_connect_and_disconnect_release_all_previous_stream_observations(self):
        self.studio.record_stream_result(self.request, self.session, "network")
        self.studio._connect(client.oauth.TokenSet("synthetic-access", "synthetic-refresh", 1999999999), save=False)
        self.assertFalse(self.studio.stream_results)
        self.studio.record_stream_result(self.request, self.studio.playback_session, "available")
        self.studio._disconnect()
        self.assertFalse(self.studio.stream_results)

    def test_cache_is_bounded_expires_and_does_not_hide_a_terminal_range_rejection(self):
        with patch.object(client.time, "monotonic", return_value=0):
            self.studio.record_stream_result(self.request, self.session, "auth")
            for result in ("network", "available"):
                self.studio.record_stream_result(self.request, self.session, result)
            self.assertEqual(self.state(), "auth")
            for i in range(100):
                self.studio.record_stream_result(f"request-{i:016d}", self.session, "available")
            self.assertEqual(len(self.studio.stream_results), 64)
            self.assertEqual(self.state(), "unknown")
        with patch.object(client.time, "monotonic", return_value=121):
            self.assertEqual(self.studio.stream_status("request-0000000000000099", self.session), {"state": "unknown"})
        for invalid in (None, "", "../private", "x" * 101):
            with self.assertRaises(client.ApiError):
                self.studio.stream_status(invalid, self.session)

    def test_proxy_body_failures_are_observed_but_client_cancellation_is_not_a_network_diagnosis(self):
        class Response:
            status_code, ok, headers = 200, True, {"Content-Type": "audio/wav"}

            def __init__(self, error):
                self.error = error

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def iter_content(self, _size):
                yield b"synthetic"
                raise self.error

        for error, expected in ((requests.exceptions.ChunkedEncodingError("lost"), "network"),
                                (requests.exceptions.SSLError("TLS"), "security")):
            with self.subTest(state=expected):
                self.studio.stream_results.clear()
                self.transport.open_stream.return_value = Response(error)
                handler = Mock(studio=self.studio, headers={}, server=SimpleNamespace())
                app.Handler._stream(handler, "1", "128", self.request, self.session)
                self.assertEqual(self.state(), expected)
        self.studio.stream_results.clear()
        self.transport.open_stream.return_value = Response(AssertionError("reader must stop"))
        handler.wfile.write.side_effect = BrokenPipeError()
        app.Handler._stream(handler, "1", "128", self.request, self.session)
        self.assertEqual(self.state(), "available")

    def test_http_status_route_keeps_security_and_session_guards_without_upstream_io(self):
        self.studio.record_stream_result(self.request, self.session, "network")
        handler = type("StreamHandler", (app.Handler,), {"studio": self.studio, "port": 0})
        server = app.Server(("127.0.0.1", 0), partial(handler, directory=str(app.STATIC)))
        handler.port = server.server_port
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            path = f"/api/playback/stream-status?request={self.request}&session={self.session}"
            for headers, expected in (({}, 200), ({"Host": "foreign.invalid"}, 403),
                                      ({"Sec-Fetch-Site": "cross-site"}, 403)):
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                body = response.read()
                if expected == 200:
                    self.assertEqual(json.loads(body), {"state": "network"})
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
                connection.close()
            self.transport.open_stream.assert_not_called()
            self.transport._jsonrequest.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
