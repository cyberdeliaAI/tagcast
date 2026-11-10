"""Disposable real HTTP host for check_browser_csp.cjs; no real account or service.

All iBroadcast traffic goes to tests/mock_ibroadcast.py. Audio is a bundled
synthetic sine wave. The parent closes stdin to stop both hosts and remove settings.
"""

import io
import json
import math
import os
import struct
import sys
import tempfile
import threading
import time
import wave
from contextlib import ExitStack
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse


def main():
    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / "tests"))
    import mock_ibroadcast as mock

    class Upstream(mock.H):
        def do_GET(self):
            url = urlparse(self.path)
            if url.path.startswith("/stream/"):
                query = parse_qs(url.query)
                if query.get("Signature") != [mock.TOKEN] or query.get("user_id") != ["7"]:
                    return self.send(403, {})
                original = "/orig/" in url.path
                data = (root / "tests/fixtures/gapless" / ("tone.flac" if original else "tone.mp3")).read_bytes()
                start, end = 0, len(data) - 1
                ranged = self.headers.get("Range", "").startswith("bytes=")
                if ranged:
                    first, _, last = self.headers["Range"][6:].partition("-")
                    start, end = int(first or 0), int(last) if last else end
                total, data = len(data), data[start:end + 1]
                self.send_response(206 if ranged else 200)
                self.send_header("Content-Type", "audio/flac" if original else "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Accept-Ranges", "bytes")
                if ranged:
                    self.send_header("Content-Range", f"bytes {start}-{start + len(data) - 1}/{total}")
                self.end_headers()
                self.wfile.write(data)
                return
            return super().do_GET()

    with ExitStack() as stack:
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        stack.callback(upstream.server_close)
        stack.callback(upstream.shutdown)
        os.environ["TAGCAST_IBROADCAST_BASE"] = f"http://127.0.0.1:{upstream.server_port}"
        os.environ["IBROADCAST_CLIENT_ID"] = "test"
        # Import only after redirecting every iBroadcast endpoint to the mock.
        from tagcast import app, client

        original_library = mock.library

        def library():
            data = original_library()
            data["settings"]["artwork_server"] = "https://artwork.example.test"
            return data

        stack.enter_context(patch.object(mock, "library", library))
        mock.STATE["premium"] = True
        for track in mock.STATE["tracks"].values():
            track.update(type="audio/flac", length=2)
        sample = io.BytesIO()
        with wave.open(sample, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * math.tau * 220 / 24000)))
                                      for i in range(24000 * 20)))

        origins = {}
        for mode in ("disconnected", "live"):
            home = stack.enter_context(tempfile.TemporaryDirectory(prefix="tagcast-csp-"))
            studio = client.Studio(home)
            studio.config.update(auto_updates=False, auto_lookup=False, record_plays=False)
            if mode == "live":
                studio._connect(client.oauth.TokenSet(mock.TOKEN, "refresh-1", time.time() + 3600), save=False)

            class Frontend(app.Handler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    if self.path == "/_csp/probes.js":
                        data = (root / "tests/fixtures/content-security/probes.js").read_bytes()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/javascript")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    if self.path == "/_csp/tone.wav":
                        data = sample.getvalue()
                        self.send_response(200)
                        self.send_header("Content-Type", "audio/wav")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    return super().do_GET()

            Frontend.studio = studio
            server = app.Server(("127.0.0.1", 0), partial(Frontend, directory=str(app.STATIC)))
            Frontend.port = server.server_port
            threading.Thread(target=server.serve_forever, daemon=True).start()
            stack.callback(server.server_close)
            stack.callback(server.shutdown)
            origins[mode] = f"http://127.0.0.1:{server.server_port}"
        print(json.dumps(origins), flush=True)
        sys.stdin.read()


if __name__ == "__main__":
    main()
