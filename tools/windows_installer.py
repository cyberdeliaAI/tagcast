"""Build and validate NSIS only in an explicitly disposable Windows environment."""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from check_electron import check_app

ROOT = Path(__file__).resolve().parent.parent


def installer_command(installer, installed):
    """NSIS requires its final /D= path unquoted, even when it contains spaces."""
    if any(char in str(installed) for char in ('"', '\r', '\n')):
        raise ValueError("Invalid disposable installer path.")
    # CreateProcess receives this directly, without cmd.exe or another shell.
    return subprocess.list2cmdline([str(installer), "/S"]) + f" /D={installed}"


def verify_signature(package, publishers, env):
    """An enabled Windows update chain requires a valid pinned Authenticode signer."""
    if not publishers:
        return False
    script = ("$s=Get-AuthenticodeSignature -LiteralPath $env:TAGCAST_INSTALLER_PATH;$publisher='';"
              "if($s.SignerCertificate){$publisher="
              "$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)};"
              "@{status=[string]$s.Status;publisher=$publisher}|ConvertTo-Json -Compress")
    result = json.loads(subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env={**env, "TAGCAST_INSTALLER_PATH": str(package)}, text=True, timeout=30))
    if result.get("status") != "Valid" or result.get("publisher") not in publishers:
        raise ValueError("NSIS signature does not match a trusted update publisher.")
    return True


def build_installer(directory, info, node, env):
    if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("TAGCAST_TEST_WINDOWS_INSTALLER") != "1":
        raise ValueError("NSIS validation needs disposable Windows: set TAGCAST_TEST_WINDOWS_INSTALLER=1 explicitly.")
    subprocess.run([node, "node_modules/electron-builder/cli.js", "--prepackaged", str(directory),
                    "--win", "nsis", "--x64", "--publish", "never", "--config",
                    str(ROOT / "tools/electron_nsis.cjs")], cwd=ROOT / "electron", env=env, check=True)
    filename = f'tagcast-{info["version"]}-windows-x64-setup.exe'
    installer = ROOT / "dist/packages" / filename
    built_name = f'tagcast-{info["tag"][1:]}-windows-x64-setup.exe'
    shutil.move(ROOT / "electron/out-nsis" / built_name, installer)
    publishers = json.loads((ROOT / "electron/update-config.json").read_text())["publisherName"]
    signed = verify_signature(installer, publishers, env)
    with tempfile.TemporaryDirectory(prefix="Tagcast installer ") as name:
        installed = Path(name) / "Installed Tagcast"
        subprocess.run(installer_command(installer, installed), env=env, shell=False,
                       check=True, timeout=180)
        if not (installed / "Uninstall Tagcast.exe").is_file():
            raise ValueError("Installed NSIS application is missing its uninstaller.")
        check_app(installed / "Tagcast.exe", info["version"], restart=True)
        subprocess.run([str(installed / "Uninstall Tagcast.exe"), "/S"], env=env,
                       check=True, timeout=180)
        # NSIS can detach its uninstaller; wait for the tested application to be removed.
        deadline = time.monotonic() + 30
        while (installed / "Tagcast.exe").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        if (installed / "Tagcast.exe").exists():
            raise ValueError("NSIS did not remove the installed application.")
    with installer.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    installer.with_name(filename + ".sha256").write_text(f"{digest}  {filename}\n", encoding="ascii")
    report = ROOT / "build/reports/windows-installer.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"package": filename, "version": info["version"], "sha256": digest,
                                  "installed_startup": True, "restart": True, "removed": True,
                                  "authenticode": signed}) + "\n")
