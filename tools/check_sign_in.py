"""Check the native sign-in lifecycle using disposable profiles and a loopback provider.

--live-page loads only the public iBroadcast sign-in form and closes it without signing in.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, help="Packaged Electron executable; otherwise source Electron")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--live-page", action="store_true")
    args = parser.parse_args()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / "tests"))
    import mock_ibroadcast

    state = {"number": 0, "outcome": "pending", "polls": 0}

    class Provider(mock_ibroadcast.H):
        def do_GET(self):
            if urlparse(self.path).path == "/oauth/device/code":
                state["number"] += 1
                state["outcome"] = "pending"
                return self.send(200, {"device_code": f"mock-{state['number']}",
                    "user_code": "TEST-CODE", "interval": 1, "expires_in": 600,
                    "verification_uri": "https://oauth.ibroadcast.com/device",
                    "verification_uri_complete": "https://oauth.ibroadcast.com/device?user_code=TEST-CODE"})
            if self.path == "/_signin/check":
                return self.send(200, {"starts": state["number"], "polls": state["polls"],
                                       "writes": len(mock_ibroadcast.STATE["writes"])})
            return super().do_GET()

        def do_POST(self):
            if self.path == "/_signin/outcome":
                state["outcome"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                return self.send(200, {"ok": True})
            if self.path == "/oauth/token":
                body = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
                if body.get("grant_type") == ["device_code"]:
                    state["polls"] += 1
                    if state["outcome"] != "approve":
                        return self.send(400, {"error": "access_denied" if state["outcome"] == "deny"
                                               else "authorization_pending"})
                return self.send(200, {"access_token": mock_ibroadcast.TOKEN,
                                      "refresh_token": "refresh-1", "expires_in": 3600})
            return super().do_POST()

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="tagcast sign-in check ") as directory:
            root = Path(directory)
            home, profile = root / "settings", root / "profile"
            home.mkdir()
            profile.mkdir()
            (home / "config.json").write_text(json.dumps({"auto_updates": False, "auto_lookup": False}))
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = str(probe.getsockname()[1])
            env = dict(os.environ, TAGCAST_HOME=str(home), TAGCAST_ELECTRON_PROFILE=str(profile),
                       TAGCAST_PORT=port, TAGCAST_SIGN_IN_SMOKE_REPORT=str(args.report.resolve()),
                       TAGCAST_PYTHON=sys.executable)
            for key in ("ELECTRON_RUN_AS_NODE", "TAGCAST_ELECTRON_SMOKE_REPORT",
                        "TAGCAST_SIGN_IN_LIVE_PAGE", "IBROADCAST_CLIENT_ID", "TAGCAST_IBROADCAST_BASE"):
                env.pop(key, None)
            if args.live_page:
                env["TAGCAST_SIGN_IN_LIVE_PAGE"] = "1"
            else:
                env["IBROADCAST_CLIENT_ID"] = "test"
                env["TAGCAST_IBROADCAST_BASE"] = f"http://127.0.0.1:{provider.server_port}"
            if args.screenshots:
                env["TAGCAST_SIGN_IN_SCREENSHOTS"] = str(args.screenshots.resolve())
            command = ([str(args.app.resolve())] if args.app else
                       [str(ROOT / "electron/node_modules/.bin/electron"), str(ROOT / "electron")])
            phases = []
            for phase in (["initial"] if args.live_page else ["initial", "restart"]):
                env["TAGCAST_SIGN_IN_PHASE"] = phase
                args.report.unlink(missing_ok=True)
                process = subprocess.Popen(command, cwd=root, env=env,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    code = process.wait(timeout=110)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=15)
                    raise RuntimeError("Native sign-in check did not finish") from None
                result = json.loads(args.report.read_text()) if args.report.exists() else {"ok": False}
                if code or not result.get("ok"):
                    raise RuntimeError(f"Sign-in check failed: {result}")
                phases.append(result)
            args.report.write_text(json.dumps({"ok": True, "phases": phases}, indent=2) + "\n")
            print(f"Checked sign-in: {'public page without approval' if args.live_page else 'mock approval, cancellation and size restoration'}")
    finally:
        provider.shutdown()
        provider.server_close()


if __name__ == "__main__":
    main()
