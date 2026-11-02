"""Check an actual Electron app and its bundled server with disposable settings."""

import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from urllib.request import urlopen

import certifi


def check_certificates(resources):
    """Validate the extracted bundle, not the build machine's OS trust store."""
    internal = resources / "backend/_internal"
    versions = json.loads((internal / "licenses/versions.json").read_text(encoding="utf-8"))
    installed = version("certifi")
    if (versions.get("certifi") != installed
            or tuple(map(int, installed.split("."))) < (2026, 10, 19)):
        raise RuntimeError("Bundled certifi must match the patched build dependency.")
    ca = internal / "certifi/cacert.pem"
    contents = ca.read_bytes()
    if contents != Path(certifi.where()).read_bytes():
        raise RuntimeError("Bundled HTTPS certificates differ from the checked build dependency.")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(ca))
    roots = {hashlib.sha256(root).hexdigest() for root in context.get_ca_certs(binary_form=True)}
    # emSign ECC Root CA - G3, removed for GHSA-6q48-6c7w-9gw2.
    if not roots or "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b" in roots:
        raise RuntimeError("Bundled HTTPS trust roots are missing or unsafe.")
    return {"certifi": installed, "ca_sha256": hashlib.sha256(contents).hexdigest(),
            "root_count": len(roots), "compromised_root_present": False}


def check_app(executable, version, restart=False):
    with tempfile.TemporaryDirectory(prefix="tagcast electron check ") as directory:
        root = Path(directory)
        settings, profile = root / "settings", root / "profile"
        settings.mkdir()
        profile.mkdir()
        (settings / "config.json").write_text('{"auto_updates":false,"auto_lookup":false}')
        report = root / "report.json"
        # Build credentials must never reach the launched application or bundled CLI.
        inherited = {key: value for key, value in os.environ.items()
                     if not key.startswith(("CSC_", "WIN_CSC_", "APPLE_"))}
        env = dict(inherited, TAGCAST_HOME=str(settings), TAGCAST_ELECTRON_PROFILE=str(profile),
                   TAGCAST_ELECTRON_SMOKE_REPORT=str(report), TAGCAST_PORT="0")
        for key in ("IBROADCAST_CLIENT_ID", "TAGCAST_IBROADCAST_BASE", "ELECTRON_RUN_AS_NODE"):
            env.pop(key, None)
        resources = (executable.parent.parent / "Resources" if sys.platform == "darwin"
                     else executable.parent / "resources")
        certificates = check_certificates(resources)
        cli = resources / "backend" / ("tagcast-cli.exe" if sys.platform == "win32" else "tagcast-cli")
        for arguments, expected in ((["--help"], "usage: tagcast"),
                                    (["--version"], f"Tagcast {version}")):
            checked = subprocess.run([str(cli), *arguments], check=True, capture_output=True,
                                     text=True, timeout=30, cwd=root, env=env)
            if expected not in checked.stdout:
                raise RuntimeError(f"Bundled CLI check failed: {arguments}")
        phases = []
        if restart:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                env["TAGCAST_PORT"] = str(probe.getsockname()[1])
        for phase in (["initial", "restart"] if restart else ["initial"]):
            env["TAGCAST_ELECTRON_SMOKE_PHASE"] = phase
            report.unlink(missing_ok=True)
            process = subprocess.Popen([str(executable)], env=env, cwd=root,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                result = process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=15)
                raise RuntimeError("The isolated Electron app did not finish its check") from None
            finally:
                data = json.loads(report.read_text()) if report.exists() else {"ok": False, "error": "No smoke report"}
                reports = Path(__file__).resolve().parent.parent / "build/reports"
                reports.mkdir(parents=True, exist_ok=True)
                # Preserve the last bounded test phase even if the app exits or times out.
                (reports / "electron.json").write_text(json.dumps(data, indent=2) + "\n")
            if result or not data.get("ok") or data.get("version") != version:
                raise RuntimeError(f"Electron check failed: {data}")
            try:
                urlopen(data["origin"] + "/api/app", timeout=1)
            except OSError:
                pass
            else:
                raise RuntimeError("The Electron app left its owned server running")
            if phases and phases[0]["origin"] != data["origin"]:
                raise RuntimeError("The production restart changed the local origin")
            phases.append(data)
            env["TAGCAST_ELECTRON_RESTART_EXPECTED"] = json.dumps(data["persistence"]["after"])
        data["restart_checks"] = phases[:-1]
        data["certificates"] = certificates
        reports = Path(__file__).resolve().parent.parent / "build/reports"
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "electron.json").write_text(json.dumps(data, indent=2) + "\n")
        print(f'Checked Electron {data["electron"]}, Tagcast {data["version"]}, CLI, sandbox and server shutdown')


if __name__ == "__main__":
    check_app(Path(sys.argv[1]).resolve(), sys.argv[2], restart="--restart" in sys.argv[3:])
