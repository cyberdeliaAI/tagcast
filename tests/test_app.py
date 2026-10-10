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
        studio.check_updates.return_value = {"state": "current", "current": "0.10.1"}
        handler = type("TestHandler", (app.Handler,), {"studio": studio, "port": 0})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        handler.port = server.server_port
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def request(method, path, headers=None):
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                connection.request(method, path, body='{"track_id":"1","before":0,"rating":5}' if method == "POST" else None,
                                   headers=headers or {})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()

        try:
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
            self.assertEqual(request("GET", "/api/browse", {"Sec-Fetch-Site": "cross-site"}), 403)
            self.assertEqual(request("GET", "/api/browse", {"Host": "elsewhere.test"}), 403)
            studio.browse.assert_not_called()
            self.assertEqual(request("GET", "/api/browse?kind=genres&key=rock&offset=24&limit=24&sort=za"), 200)
            studio.browse.assert_called_once_with("genres", "rock", None, "24", "24", "za")
            studio.favourite.assert_not_called()
            studio.favourites.assert_not_called()
            self.assertEqual(request("GET", "/api/favourites?q=test&offset=50&limit=100"), 200)
            studio.favourites.assert_called_once_with("test", "50", "100")
            self.assertEqual(request("POST", "/api/favourite", {"X-Tagcast": "1"}), 200)
            studio.favourite.assert_called_once_with({"track_id": "1", "before": 0, "rating": 5})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
