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

from tagcast import app, client, mp3_playback


class StreamResponse:
    ok = True

    def __init__(self, chunks, status=200, headers=None):
        self.chunks = chunks
        self.status_code = status
        self.headers = headers if headers is not None else {
            "Content-Type": "audio/mpeg", "Accept-Ranges": "none", "Transfer-Encoding": "chunked",
        }

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def iter_content(self, _size):
        yield from self.chunks


class StreamRecoveryTests(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.studio = client.Studio(home.name)
        self.transport = self.studio.client = Mock()
        self.studio.library = Mock(expires=1999999999)
        self.studio.library.stream_info.return_value = ("/128/test/1", "audio/mpeg")
        self.studio.library.tracks = {1: {"file": "/test/1"}, 2: {"file": "/test/2"}}
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

    def test_opt_in_mp3_diagnostic_keeps_only_the_first_response_and_safe_headers(self):
        first = Mock(status_code=200, ok=True, headers={
            "Content-Type": "audio/mpeg; token=not-for-report",
            "Transfer-Encoding": "chunked",
            "Set-Cookie": "not-for-report",
        })
        seek = Mock(status_code=206, ok=True, headers={
            "Content-Length": "16", "Content-Range": "bytes 100-115/10000", "Accept-Ranges": "bytes",
        })
        self.transport.open_stream.side_effect = (first, first, seek)
        self.stream()
        self.assertEqual(self.studio.stream_status(self.request, self.session), {"state": "available"})

        request = "diagnostic-request-1234"
        for byte_range in ("bytes=0-", "bytes=100-115"):
            self.studio.stream("1", byte_range, "128", request_id=request,
                               playback_session=self.session, diagnostic=True)
        self.studio.record_stream_result(request, self.session, "network")
        self.assertEqual(self.studio.stream_status(request, self.session), {
            "state": "network",
            "first_response": {
                "status": 200, "request_range": "bytes=0-", "content_type": "audio/mpeg",
                "content_length": None, "content_range": None, "accept_ranges": None,
                "transfer_encoding": "chunked",
            },
        })
        self.assertEqual(self.transport.open_stream.call_count, 3)

    def test_original_is_excluded_and_non_header_data_is_not_returned(self):
        self.studio.premium = True
        self.transport.open_stream.return_value = Mock(status_code=206, ok=True, headers={
            "Content-Range": "https://example.test/private",
            "Content-Length": "not-a-number",
        })
        self.studio.stream("1", "bytes=0-", "orig", request_id=self.request,
                           playback_session=self.session, diagnostic=True)
        self.assertEqual(self.studio.stream_status(self.request, self.session), {"state": "available"})
        request = "diagnostic-request-1234"
        self.studio.stream("1", "secret=not-for-report", "192", request_id=request,
                           playback_session=self.session, diagnostic=True)
        diagnostic = self.studio.stream_status(request, self.session)["first_response"]
        for name in ("content_range", "content_length", "request_range"):
            self.assertEqual(diagnostic[name], "unrecognized")

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
        self.studio.buffered_mp3((self.session, self.request, "1", "128"), b"old")
        self.studio._connect(client.oauth.TokenSet("synthetic-access", "synthetic-refresh", 1999999999), save=False)
        self.assertFalse(self.studio.stream_results)
        self.assertFalse(self.studio.mp3_buffers)
        self.studio.library = Mock(tracks={1: {"file": "/test/1"}})
        self.studio.record_stream_result(self.request, self.studio.playback_session, "available")
        self.studio.buffered_mp3((self.studio.playback_session, self.request, "1", "128"), b"new")
        self.studio._disconnect()
        self.assertFalse(self.studio.stream_results)
        self.assertFalse(self.studio.mp3_buffers)

    def serve(self, *, quality="128", track="1", byte_range="bytes=0-", request=None, session=None):
        handler = Mock(studio=self.studio, headers={"Range": byte_range}, server=SimpleNamespace())
        handler._serve_buffered_mp3.side_effect = lambda *args: app.Handler._serve_buffered_mp3(handler, *args)
        app.Handler._stream(handler, track, quality, request or self.request, session or self.session, diagnostic=True)
        body = b"".join(call.args[0] for call in handler.wfile.write.call_args_list)
        headers = dict(call.args for call in handler.send_header.call_args_list)
        status = handler.send_response.call_args.args[0] if handler.send_response.called else handler._json.call_args.args[0]
        return status, headers, body

    def test_complete_chunked_mp3_serves_finite_length_and_later_ranges_from_the_same_bytes(self):
        self.studio.premium = True
        self.transport.open_stream.return_value = StreamResponse([b"abcd", b"efghi"])
        for byte_range, expected_status, expected_range, expected_data in (
            ("bytes=0-", 206, "bytes 0-8/9", b"abcdefghi"),
            ("bytes=5-6", 206, "bytes 5-6/9", b"fg"),
            ("bytes=1-2", 206, "bytes 1-2/9", b"bc"),
            ("bytes=-3", 206, "bytes 6-8/9", b"ghi"),
            ("bytes=9-", 416, "bytes */9", b""),
            (None, 200, None, b"abcdefghi"),
        ):
            with self.subTest(byte_range=byte_range):
                status, headers, body = self.serve(quality="320", byte_range=byte_range)
                self.assertEqual((status, headers.get("Content-Range"), body), (expected_status, expected_range, expected_data))
                self.assertEqual(headers["Content-Length"], str(len(expected_data)))
                self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.transport.open_stream.assert_called_once()
        self.assertEqual(self.studio.stream_status(self.request, self.session)["first_response"]["status"], 200)

    def test_buffer_is_scoped_to_the_request_track_quality_and_session(self):
        self.studio.premium = True
        self.transport.open_stream.return_value = StreamResponse([b"abcd"])
        self.assertEqual(self.serve()[0], 206)
        for options in ({"quality": "96"}, {"track": "2"}, {"request": "other-stream-123456"}):
            with self.subTest(options=options):
                self.assertEqual(self.serve(byte_range="bytes=1-", **options)[0], 200)
        self.assertEqual(self.serve(session="other-session")[0], 401)
        self.studio.library.tracks[1]["trashed"] = True
        self.studio.library.stream_info.side_effect = client.LibraryError("Removed")
        self.assertEqual(self.serve(byte_range="bytes=1-")[0], 404)
        self.assertEqual(self.transport.open_stream.call_count, 4)

    def test_size_and_time_limit_keep_the_entire_original_response_playable(self):
        for limits in (patch.object(mp3_playback, "MAX_MP3_BYTES", 2),
                       patch.object(mp3_playback, "monotonic", side_effect=(0, 10))):
            with limits:
                self.transport.open_stream.return_value = StreamResponse([b"abcd", b"efghi"])
                status, headers, body = self.serve()
                self.assertEqual((status, headers["Accept-Ranges"], body), (200, "none", b"abcdefghi"))
                self.assertNotIn("Content-Length", headers)
                self.assertFalse(self.studio.mp3_buffers)

    def test_ordinary_seekable_and_original_responses_keep_the_upstream_headers(self):
        self.studio.premium = True
        self.transport.open_stream.return_value = StreamResponse([b"abcd"], 206, {
            "Content-Length": "4", "Content-Range": "bytes 0-3/9", "Accept-Ranges": "bytes",
        })
        self.assertEqual(self.serve()[1]["Content-Range"], "bytes 0-3/9")
        self.transport.open_stream.return_value = StreamResponse([b"original"])
        self.assertEqual(self.serve(quality="orig")[0], 200)
        self.assertFalse(self.studio.mp3_buffers)

    def test_interrupted_chunked_body_never_creates_a_seekable_copy(self):
        def interrupted():
            yield b"partial"
            raise requests.exceptions.ChunkedEncodingError("lost")

        self.transport.open_stream.return_value = StreamResponse(interrupted())
        self.assertEqual(self.serve()[0], 502)
        self.assertEqual(self.state(), "network")
        self.assertFalse(self.studio.mp3_buffers)

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
