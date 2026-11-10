"""Exercise native close/relaunch against a disposable loopback-only iBroadcast fixture."""

import copy
import importlib.util
import io
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from ibroadcast.oauth import TokenSet

ROOT = Path(__file__).resolve().parent.parent
CASES = ("idle", "idle-tcp", "stream", "stalled-read", "reopen", "write",
         "readback", "uncertain", "cleanup", "download", "upload", "folder", "backend-exit")


def fixture_module():
    spec = importlib.util.spec_from_file_location("shutdown_ibroadcast", ROOT / "tests/mock_ibroadcast.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(mock, case):
    class Handler(mock.H):
        mode = None

        def gate(self):
            self.server.reached.set()
            self.server.release.wait()

        def send(self, code, data):
            if self.mode == "status" and isinstance(data, dict):
                data["supported"] = [{"extension": "flac"}]
            if self.mode in ("update_album", "update_track") and case in ("write", "uncertain", "cleanup"):
                self.gate()  # The mock already applied the mutation, but no answer has left.
                if case == "uncertain":
                    self.close_connection = True
                    return
            try:
                super().send(code, data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A stopped synthetic stream/upload is expected to disconnect.

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/_shutdown/state":
                return self.send(200, {"reached": self.server.reached.is_set(),
                                       "writes": len(mock.STATE["writes"]), "uploads": self.server.uploads})
            if path == "/_shutdown/arm":
                self.server.armed.set()
                return self.send(200, {})
            if path == "/_shutdown/release":
                self.server.release.set()
                return self.send(200, {})
            if path.startswith("/stream/") and case in ("stream", "download"):
                audio = self.server.audio
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio[:131072])
                self.wfile.flush()
                self.gate()
                return
            return super().do_GET()

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if self.path == "/upload":
                if not raw:
                    return self.send(200, {"result": True, "md5": []})
                self.server.uploads += 1
                self.gate()  # Entire synthetic body accepted; final answer is deliberately stalled.
                return self.send(200, {"result": True, "track_id": 999})
            body = json.loads(raw or b"{}")
            self.mode = body.get("mode")
            if self.server.armed.is_set():
                if case in ("stalled-read", "reopen") and self.mode == "status":
                    self.gate()
                if case == "readback" and self.path == "/library" and mock.STATE["writes"]:
                    self.gate()
            self.rfile = io.BytesIO(raw)
            return super().do_POST()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.armed, server.reached, server.release = (threading.Event() for _ in range(3))
    server.uploads = 0
    # Reuse the independent synthetic MP3 fixture: a partial WAV can make
    # Chromium seek for its footer before playback, obscuring the shutdown test.
    server.audio = (ROOT / "tests/fixtures/gapless/tone.mp3").read_bytes() * 128
    return server


def check_shutdown(executable, inherited, cases=CASES):
    mock = fixture_module()
    original = copy.deepcopy(mock.STATE)
    reports = []
    destination = ROOT / "build/reports/electron-shutdown.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    for case in cases:
        mock.STATE.clear()
        mock.STATE.update(copy.deepcopy(original))
        provider = fixture(mock, case)
        worker = threading.Thread(target=provider.serve_forever, kwargs={"poll_interval": .05})
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix="tagcast shutdown check ") as directory:
                root = Path(directory)
                settings, profile, report = root / "settings", root / "profile", root / "report.json"
                settings.mkdir()
                profile.mkdir()
                (root / "synthetic.flac").write_bytes(b"synthetic-upload-only" * 4096)
                (settings / "config.json").write_text(json.dumps({"client_id": "test", "auto_updates": False,
                    "auto_lookup": False, "record_plays": False, "music_uploads": case == "upload"}))
                tokens = TokenSet(mock.TOKEN, "synthetic-refresh", time.time() + 3600,
                                  scope=["user.library:read", "user.library:write", "user.upload"])
                (settings / "tokens.json").write_text(json.dumps({"client_id": "test", "token_set": tokens.to_dict()}))
                env = {key: value for key, value in inherited.items() if not key.startswith("TAGCAST_")}
                env.pop("IBROADCAST_CLIENT_ID", None)
                env.pop("ELECTRON_RUN_AS_NODE", None)
                env.update(TAGCAST_HOME=str(settings), TAGCAST_ELECTRON_PROFILE=str(profile), TAGCAST_PORT="0",
                    TAGCAST_IBROADCAST_BASE=f"http://127.0.0.1:{provider.server_port}",
                    TAGCAST_SHUTDOWN_SMOKE_REPORT=str(report), TAGCAST_SHUTDOWN_SMOKE_CASE=case)
                with socket.socket() as port:
                    port.bind(("127.0.0.1", 0))
                    env["TAGCAST_PORT"] = str(port.getsockname()[1])
                phases = (case, "history-restart") if case == "write" else (case, "backend-restart") if case == "backend-exit" else (case,)
                initial_origin = None
                for phase in phases:
                    env["TAGCAST_SHUTDOWN_SMOKE_CASE"] = phase
                    report.unlink(missing_ok=True)
                    process = subprocess.Popen([str(executable)], cwd=root, env=env,
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        result = process.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        provider.release.set()  # Release our fixture, never kill an accepted write.
                        process.terminate()
                        process.wait(timeout=15)
                        raise RuntimeError(f"Native shutdown fixture timed out: {phase}") from None
                    finally:
                        data = json.loads(report.read_text()) if report.exists() else {"ok": False, "case": phase, "error": "No report"}
                        reports.append(data)
                        destination.write_text(json.dumps(reports, indent=2) + "\n")
                    if result or not data.get("ok"):
                        raise RuntimeError(f"Native shutdown check failed: {data}")
                    if initial_origin is not None and data["origin"] != initial_origin:
                        raise RuntimeError("Native restart changed the profile's storage origin")
                    initial_origin = data["origin"]
                    if case in ("write", "readback", "uncertain", "cleanup") and len(mock.STATE["writes"]) != 1:
                        raise RuntimeError(f"A synthetic mutation was missing or repeated: {phase}")
                    try:
                        urlopen(data["origin"] + "/api/app", timeout=1)
                    except OSError:
                        pass
                    else:
                        raise RuntimeError(f"Native close left the backend alive: {phase}")
                    print(f"Checked native shutdown: {phase}")
        finally:
            provider.release.set()
            provider.shutdown()
            provider.server_close()
            worker.join(timeout=5)
    return reports


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--case", action="append", choices=CASES)
    args = parser.parse_args()
    check_shutdown(args.executable.resolve(), os.environ, args.case or CASES)
