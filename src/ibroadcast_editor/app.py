"""Local web server for Library Studio. Listens on 127.0.0.1 only."""

import argparse
import json
import logging
import os
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from .client import ApiError, NotConnected, Studio
from .library import ConflictError, LibraryError

STATIC = Path(__file__).parent / "static"
MAX_BODY = 8 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    studio = None
    port = 8912

    def log_message(self, fmt, *args):
        if os.environ.get("LIBRARY_STUDIO_DEBUG"):
            super().log_message(fmt, *args)

    # -- helpers -------------------------------------------------------------

    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError("Request too large.")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError("Invalid JSON.") from None
        if not isinstance(data, dict):
            raise ApiError("Invalid request.")
        return data

    def _redirect_uri(self):
        return f"http://127.0.0.1:{self.port}/callback"

    def _run(self, action):
        try:
            self._json(200, action())
        except ConflictError as error:
            self._json(409, {"error": str(error), "conflict": True})
        except NotConnected as error:
            self._json(401, {"error": str(error), "connected": False})
        except (ApiError, LibraryError) as error:
            self._json(400, {"error": str(error)})
        except Exception:  # never leak a traceback to the page
            logging.exception("Request failed")
            self._json(500, {"error": "Something went wrong in Library Studio. See the terminal."})

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    # -- routes --------------------------------------------------------------

    def do_GET(self):
        if not self._host_ok():
            self.send_error(403, "Open Library Studio via http://127.0.0.1")
            return
        url = urlparse(self.path)
        if url.path == "/api/status":
            self._run(self.studio.status)
        elif url.path == "/api/library":
            refresh = parse_qs(url.query).get("refresh") == ["1"]
            self._run(lambda: self.studio.load_library(refresh))
        elif url.path == "/api/albums":
            ids = [i for i in (parse_qs(url.query).get("ids") or [""])[0].split(",") if i]
            self._run(lambda: {"albums": self.studio.album_details(ids)})
        elif url.path == "/callback":
            self._callback(parse_qs(url.query))
        elif url.path.startswith("/api/"):
            self._json(404, {"error": "Unknown endpoint."})
        else:
            if url.path in ("/", "/index.html"):
                self.path = "/index.html"
            super().do_GET()

    def do_POST(self):
        # The custom header forces a CORS preflight, which this server never approves,
        # so other websites cannot post to it.
        if not self._host_ok() or self.headers.get("X-Library-Studio") != "1":
            self._json(403, {"error": "Forbidden."})
            return
        path = urlparse(self.path).path
        routes = {
            "/api/config": lambda b: (self.studio.set_client_id(b.get("client_id")),
                                      self.studio.status())[1],
            "/api/auth/device": lambda b: {"device": self.studio.start_device()},
            "/api/auth/cancel": lambda b: (self.studio.cancel_device(), {"ok": True})[1],
            "/api/auth/browser": lambda b: {"url": self.studio.browser_url(self._redirect_uri())},
            "/api/auth/logout": lambda b: (self.studio.logout(), {"ok": True})[1],
            "/api/save": lambda b: self.studio.save(b.get("changes")),
        }
        if path not in routes:
            self._json(404, {"error": "Unknown endpoint."})
            return
        self._run(lambda: routes[path](self._body()))

    def _callback(self, query):
        error = (query.get("error_description") or query.get("error") or [""])[0]
        if not error:
            try:
                self.studio.finish_browser((query.get("code") or [""])[0],
                                           (query.get("state") or [""])[0])
            except ApiError as failure:
                error = str(failure)
        target = "/?connected=1" if not error else "/?auth_error=" + quote(error[:300])
        self.send_response(303)
        self.send_header("Location", target)
        self.end_headers()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Library Studio for iBroadcast")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LIBRARY_STUDIO_PORT", 8912)))
    parser.add_argument("--open", action="store_true", help="open the browser after starting")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    handler = type("BoundHandler", (Handler,), {"studio": Studio(), "port": args.port})
    with ThreadingHTTPServer(("127.0.0.1", args.port), partial(handler, directory=str(STATIC))) as server:
        url = f"http://127.0.0.1:{args.port}"
        print(f"Library Studio: {url}", flush=True)
        print(f"Settings and sign-in tokens: {handler.studio.home}", flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
