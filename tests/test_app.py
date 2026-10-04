"""Starting Tagcast when its port is taken: by Tagcast itself, or by something else."""

import io
import json
import threading
import unittest
from contextlib import redirect_stdout
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


if __name__ == "__main__":
    unittest.main()
