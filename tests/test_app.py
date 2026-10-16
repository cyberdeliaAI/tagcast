"""Starting Tagcast when its port is taken: by Tagcast itself, or by something else."""

import io
import json
import threading
import unittest
from contextlib import redirect_stdout
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from tagcast import app


def serve(answer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps(answer).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class StartTests(unittest.TestCase):
    def start(self, port):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(app.webbrowser, "open") as browser:
            code = app.main(["--port", str(port), "--open"])
        return code, out.getvalue(), browser

    def test_a_running_tagcast_is_opened_instead_of_starting_twice(self):
        server = serve({"configured": True, "connected": False})
        code, out, browser = self.start(server.server_port)
        server.shutdown()
        self.assertEqual(code, 0)
        self.assertIn("already running", out)
        browser.assert_called_once_with(f"http://127.0.0.1:{server.server_port}")

    def test_another_program_on_the_port_is_reported(self):
        server = serve({"something": "else"})
        code, out, browser = self.start(server.server_port)
        server.shutdown()
        self.assertEqual(code, 1)
        self.assertIn("in use by another program", out)
        browser.assert_not_called()

    def test_scripts_and_styles_are_served_with_their_own_types(self):
        types = app.Handler.extensions_map
        self.assertEqual((types[".js"], types[".css"], types[".svg"]),
                         ("text/javascript", "text/css", "image/svg+xml"))

    def test_favourites_routes_keep_host_header_and_fetch_metadata_protection(self):
        studio = mock.Mock()
        studio.browse.return_value = {"groups": [], "total": 0, "count": 0, "offset": 0}
        studio.favourites.return_value = {"tracks": [], "total": 0, "count": 0, "offset": 0}
        studio.favourite.return_value = {"status": "saved", "rating": 5}
        studio.collections.playlists.return_value = {"playlists": []}
        studio.collections.save_playlist.return_value = {"job": "check"}
        studio.collections.rate_album.return_value = {"job": "check"}
        studio.collections.queue_tracks.return_value = {"tracks": []}
        studio.queue_sync.view.return_value = {"status": "disconnected"}
        studio.queue_sync.action.return_value = {"status": "disconnected"}
        studio.record_play.return_value = {"status": "sent"}
        studio.recently_played.return_value = {"enabled": True, "available": True, "tracks": []}
        studio.check_updates.return_value = {"state": "current", "current": "0.10.1"}
        studio.cleanup.labels.return_value = {"labels": [], "total": 0}
        studio.cleanup.prepare.return_value = {"state": "preview"}
        studio.duplicate_cleanup.view.return_value = {"state": "empty"}
        studio.duplicate_cleanup.prepare.return_value = {"state": "preview"}
        studio.duplicate_cleanup.start.return_value = {"state": "running"}
        studio.duplicate_cleanup.cancel.return_value = {"state": "stopped"}
        studio.trash_albums.return_value = {"results": [], "job": "check"}
        studio.album_guide.view.return_value = {"enabled": True, "state": "empty"}
        studio.album_guide.analyse.return_value = {"enabled": True, "state": "ready"}
        studio.album_guide.link.return_value = {"enabled": True, "state": "ready"}
        studio.status.return_value = {"configured": True, "using_default_client": True}
        handler = type("TestHandler", (app.Handler,), {"studio": studio, "port": 0})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        handler.port = server.server_port
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def request(method, path, headers=None, body=None):
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                if isinstance(body, dict):
                    body = json.dumps(body)
                connection.request(method, path, body=(body or '{"track_id":"1","before":0,"rating":5}') if method == "POST" else None,
                                   headers=headers or {})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()

        try:
            for path, action in [("/api/playlist", studio.collections.save_playlist),
                                 ("/api/album-rating", studio.collections.rate_album),
                                 ("/api/queue-tracks", studio.collections.queue_tracks),
                                 ("/api/config/default", studio.use_default_client),
                                 ("/api/album-guide/analyse", studio.album_guide.analyse),
                                 ("/api/album-guide/link", studio.album_guide.link),
                                 ("/api/queue-sync", studio.queue_sync.action)]:
                self.assertEqual(request("POST", path), 403)
                self.assertEqual(request("POST", path, {"X-Tagcast": "1", "Host": "elsewhere.test"}), 403)
                action.assert_not_called()
                self.assertEqual(request("POST", path, {"X-Tagcast": "1"}), 200)
                action.assert_called_once()
            for path in ("/api/playlists", "/api/queue-sync", "/api/album-guide"):
                self.assertEqual(request("GET", path, {"Sec-Fetch-Site": "cross-site"}), 403)
                self.assertEqual(request("GET", path, {"Host": "elsewhere.test"}), 403)
                self.assertEqual(request("GET", path), 200)
            self.assertEqual(request("POST", "/api/play"), 403)
            self.assertEqual(request("POST", "/api/play", {"X-Tagcast": "1", "Host": "elsewhere.test"}), 403)
            studio.record_play.assert_not_called()
            self.assertEqual(request("POST", "/api/play", {"X-Tagcast": "1"}), 200)
            studio.record_play.assert_called_once()
            self.assertEqual(request("GET", "/api/updates", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/updates", {"Host": "elsewhere.test"}), 403)
            self.assertEqual(request("POST", "/api/updates/check"), 403)
            self.assertEqual(request("POST", "/api/updates/check", {"X-Tagcast": "1", "Host": "elsewhere.test"}), 403)
            studio.check_updates.assert_not_called()
            self.assertEqual(request("GET", "/api/updates"), 200)
            self.assertEqual(request("POST", "/api/updates/check", {"X-Tagcast": "1"}), 200)
            self.assertEqual(studio.check_updates.call_args_list, [mock.call(), mock.call(manual=True)])
            self.assertEqual(request("POST", "/api/favourite"), 403)
            self.assertEqual(request("POST", "/api/favourite", {"X-Tagcast": "1", "Host": "elsewhere.test"}), 403)
            self.assertEqual(request("GET", "/api/favourites", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/recently-played", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/recently-played", {"Host": "elsewhere.test"}), 403)
            studio.recently_played.assert_not_called()
            self.assertEqual(request("GET", "/api/recently-played?q=wish&offset=50&limit=100&refresh=1"), 200)
            studio.recently_played.assert_called_once_with("wish", "50", "100", True)
            self.assertEqual(request("GET", "/api/browse", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/browse", {"Host": "elsewhere.test"}), 403)
            studio.browse.assert_not_called()
            self.assertEqual(request("GET", "/api/browse?kind=genres&key=rock&offset=24&limit=24&sort=za"), 200)
            studio.browse.assert_called_once_with("genres", "rock", None, "24", "24", "za")
            self.assertEqual(request("GET", "/api/cleanup/labels", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/cleanup/labels", {"Host": "elsewhere.test"}), 403)
            studio.cleanup.labels.assert_not_called()
            self.assertEqual(request("GET", "/api/cleanup/labels?q=Films%2FGames&offset=50&limit=50"), 200)
            studio.cleanup.labels.assert_called_once_with("Films/Games", "50", "50")
            removal = '{"category":"genre-labels","label":"P","replacements":[],"remove":true}'
            self.assertEqual(request("POST", "/api/cleanup/preview", body=removal), 403)
            studio.cleanup.prepare.assert_not_called()
            self.assertEqual(request("POST", "/api/cleanup/preview", {"X-Tagcast": "1"}, removal), 200)
            studio.cleanup.prepare.assert_called_once_with("genre-labels", "P", [], True)
            self.assertEqual(request("GET", "/api/duplicate-cleanup", {"Sec-Fetch-Site": "cross-site"}), 403)
            studio.duplicate_cleanup.view.assert_not_called()
            self.assertEqual(request("GET", "/api/duplicate-cleanup?offset=10&limit=10"), 200)
            studio.duplicate_cleanup.view.assert_called_once_with("10", "10")
            self.assertEqual(request("GET", "/api/duplicate-cleanup/report"), 200)
            studio.duplicate_cleanup.view.assert_called_with(report=True)
            self.assertEqual(request("POST", "/api/duplicate-cleanup/preview", body={}), 403)
            studio.duplicate_cleanup.prepare.assert_not_called()
            self.assertEqual(request("POST", "/api/duplicate-cleanup/preview", {"X-Tagcast": "1"}, {}), 200)
            studio.duplicate_cleanup.prepare.assert_called_once_with()
            self.assertEqual(request("POST", "/api/duplicate-cleanup/start", {"X-Tagcast": "1"}, {"id": "draft", "excluded": ["1"], "approved": True}), 200)
            studio.duplicate_cleanup.start.assert_called_once_with("draft", ["1"], True)
            self.assertEqual(request("POST", "/api/duplicate-cleanup/stop", {"X-Tagcast": "1"}, {"id": "draft"}), 200)
            studio.duplicate_cleanup.cancel.assert_called_once_with("draft")
            self.assertEqual(request("POST", "/api/trash/albums", body={"albums": []}), 403)
            studio.trash_albums.assert_not_called()
            self.assertEqual(request("POST", "/api/trash/albums", {"X-Tagcast": "1"}, {"approved": True, "albums": []}), 200)
            studio.trash_albums.assert_called_once_with({"approved": True, "albums": []})
            studio.favourite.assert_not_called()
            studio.favourites.assert_not_called()
            self.assertEqual(request("GET", "/api/favourites?q=test&offset=50&limit=100"), 200)
            studio.favourites.assert_called_once_with("test", "50", "100")
            self.assertEqual(request("POST", "/api/favourite", {"X-Tagcast": "1"}), 200)
            studio.favourite.assert_called_once_with({"track_id": "1", "before": 0, "rating": 5})
        finally:
            server.shutdown()
            server.server_close()


class ResponseTests(unittest.TestCase):
    def handler(self, write):
        handler = app.Handler.__new__(app.Handler)
        handler.request_version = "HTTP/1.1"
        handler.command = "GET"
        handler.close_connection = False
        handler.log_request = mock.Mock()
        handler.wfile = mock.Mock()
        handler.wfile.write.side_effect = write
        handler.send_response = mock.Mock(wraps=handler.send_response)
        return handler

    def test_disconnected_json_responses_are_not_retried_or_reported_as_request_failures(self):
        for disconnect in (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            for write_number in (1, 2):  # headers or body
                for error, status in ((None, 200), (app.ConflictError("Changed"), 409),
                                      (app.NotConnected("Sign in"), 401),
                                      (app.ApiError("Rejected"), 400),
                                      (RuntimeError("Unexpected failure"), 500)):
                    with self.subTest(disconnect=disconnect, write=write_number, status=status):
                        handler = self.handler([None] * (write_number - 1) + [disconnect()])
                        action = mock.Mock(return_value={"ok": True}, side_effect=error)
                        with mock.patch.object(app.logging, "exception") as log:
                            handler._run(action)
                        action.assert_called_once_with()
                        handler.send_response.assert_called_once_with(status)
                        self.assertEqual(handler.wfile.write.call_count, write_number)
                        self.assertTrue(handler.close_connection)
                        self.assertEqual(log.call_count, int(status == 500))

    def test_a_connection_error_in_the_action_still_reports_an_application_failure(self):
        handler = self.handler(None)
        action = mock.Mock(side_effect=BrokenPipeError("Upstream disconnected"))
        with mock.patch.object(app.logging, "exception") as log:
            handler._run(action)
        log.assert_called_once_with("Request failed")
        handler.send_response.assert_called_once_with(500)
        self.assertFalse(handler.close_connection)


if __name__ == "__main__":
    unittest.main()
