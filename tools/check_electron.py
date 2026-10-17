"""Check an actual Electron app and its bundled server with disposable settings."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen


def check_app(executable, version):
    with tempfile.TemporaryDirectory(prefix="tagcast electron check ") as directory:
        root = Path(directory)
        settings, profile = root / "settings", root / "profile"
        settings.mkdir()
        profile.mkdir()
        (settings / "config.json").write_text('{"auto_updates":false,"auto_lookup":false}')
        report = root / "report.json"
        env = dict(os.environ, TAGCAST_HOME=str(settings), TAGCAST_ELECTRON_PROFILE=str(profile),
                   TAGCAST_ELECTRON_SMOKE_REPORT=str(report), TAGCAST_PORT="0")
        for key in ("IBROADCAST_CLIENT_ID", "TAGCAST_IBROADCAST_BASE", "ELECTRON_RUN_AS_NODE"):
            env.pop(key, None)
        resources = (executable.parent.parent / "Resources" if sys.platform == "darwin"
                     else executable.parent / "resources")
        cli = resources / "backend" / ("tagcast-cli.exe" if sys.platform == "win32" else "tagcast-cli")
        for arguments, expected in ((["--help"], "usage: tagcast"),
                                    (["--version"], f"Tagcast {version}")):
            checked = subprocess.run([str(cli), *arguments], check=True, capture_output=True,
                                     text=True, timeout=30, cwd=root, env=env)
            if expected not in checked.stdout:
                raise RuntimeError(f"Bundled CLI check failed: {arguments}")
        process = subprocess.Popen([str(executable)], env=env, cwd=root,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            result = process.wait(timeout=90)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=15)
            raise RuntimeError("The isolated Electron app did not finish its check") from None
        data = json.loads(report.read_text()) if report.exists() else {"ok": False, "error": "No smoke report"}
        if result or not data.get("ok") or data.get("version") != version:
            raise RuntimeError(f"Electron check failed: {data}")
        try:
            urlopen(data["origin"] + "/api/app", timeout=1)
        except OSError:
            pass
        else:
            raise RuntimeError("The Electron app left its owned server running")
        reports = Path(__file__).resolve().parent.parent / "build/reports"
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "electron.json").write_text(json.dumps(data, indent=2) + "\n")
        print(f'Checked Electron {data["electron"]}, Tagcast {data["version"]}, CLI, sandbox and server shutdown')


if __name__ == "__main__":
    check_app(Path(sys.argv[1]).resolve(), sys.argv[2])
