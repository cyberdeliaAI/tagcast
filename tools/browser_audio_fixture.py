"""Real loopback Tagcast and iBroadcast mock for controlled audio failures.

No real credentials, recordings or service requests. Closing stdin disposes hosts
and settings. Only /_audio/control changes this test fixture's stream fault mode.
"""

import io
import json
import math
import os
import socket
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
from urllib.parse import parse_qs, urlparse


def main():
    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / "tests"))
    import mock_ibroadcast as mock

    sample = io.BytesIO()
    with wave.open(sample, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        second = b"".join(struct.pack("<h", int(5000 * math.sin(i * math.tau * 220 / 24000)))
                          for i in range(24000))
        writer.writeframes(second * 120)
    audio = sample.getvalue()
    controls = {"fault": False, "status": 200, "requests": [], "disconnects": 0}

    class Upstream(mock.H):
        def do_GET(self):
            url = urlparse(self.path)
            if not url.path.startswith("/stream/"):
                return super().do_GET()
            query = parse_qs(url.query)
            if query.get("Signature") != [mock.TOKEN] or query.get("user_id") != ["7"]:
                return self.send(403, {})
            controls["requests"].append({"range": self.headers.get("Range"), "original": "/orig/" in url.path})
            if controls["fault"] or controls["status"] != 200:
                return self.send(503 if controls["fault"] else controls["status"], {})
            start, end = 0, len(audio) - 1
            ranged = self.headers.get("Range", "").startswith("bytes=")
            if ranged:
                first, _, last = self.headers["Range"][6:].partition("-")
                start, end = int(first or 0), int(last) if last else end
            self.send_response(206 if ranged else 200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            if ranged:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(audio)}")
            self.end_headers()
            try:
                for offset in range(start, end + 1, 8192):
                    if controls["fault"]:
                        controls["disconnects"] += 1
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    self.wfile.write(audio[offset:min(end + 1, offset + 8192)])
                    self.wfile.flush()
                    time.sleep(.1)
            except OSError:
                pass

    with ExitStack() as stack:
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        stack.callback(upstream.server_close)
        stack.callback(upstream.shutdown)
        os.environ["TAGCAST_IBROADCAST_BASE"] = f"http://127.0.0.1:{upstream.server_port}"
        os.environ["IBROADCAST_CLIENT_ID"] = "test"
        from tagcast import app, client

        mock.STATE["premium"] = True
        mock.STATE["artist_art"] = {}
        for track in mock.STATE["tracks"].values():
            track.update(type="audio/wav", length=120, artwork_id=0)
        home = stack.enter_context(tempfile.TemporaryDirectory(prefix="tagcast-audio-"))
        studio = client.Studio(home)
        studio.config.update(client_id="test", auto_updates=False, auto_lookup=False, record_plays=True)
        studio._write("config.json", studio.config)
        studio._connect(client.oauth.TokenSet(mock.TOKEN, "refresh-1", time.time() + 3600))

        class Frontend(app.Handler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/_audio/control":
                    return self._json(200, {**controls, "plays": len(mock.STATE["play_requests"])})
                return super().do_GET()

            def do_POST(self):
                if self.path == "/_audio/control":
                    data = self._body()
                    for key in ("fault", "status"):
                        if key in data:
                            controls[key] = data[key]
                    return self._json(200, controls)
                return super().do_POST()

        Frontend.studio = studio
        server = app.Server(("127.0.0.1", 0), partial(Frontend, directory=str(app.STATIC)))
        Frontend.port = server.server_port
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.server_close)
        stack.callback(server.shutdown)
        print(json.dumps({"origin": f"http://127.0.0.1:{server.server_port}", "home": home,
                          "upstream": os.environ["TAGCAST_IBROADCAST_BASE"]}), flush=True)
        sys.stdin.read()


if __name__ == "__main__":
    main()
