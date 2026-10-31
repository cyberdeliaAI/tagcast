"""Build an optional Electron shell around the same frozen Python server and page."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

from build_binary import prepare_assets, system_name
from check_electron import check_app
from release_info import release_info

ROOT = Path(__file__).resolve().parent.parent
MAC_SIGNING_SECRETS = (
    "CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
)


def build_environments(sign_macos):
    """Keep signing credentials out of installation, freezing and ordinary/PR builds."""
    plain = {key: value for key, value in os.environ.items()
             if not key.startswith(("CSC_", "WIN_CSC_", "APPLE_"))}
    plain["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    plain["CSC_FOR_PULL_REQUEST"] = "false"
    if not sign_macos:
        return plain, dict(plain)
    if sys.platform != "darwin":
        raise ValueError("--sign-macos requires macOS")
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event and event not in {"workflow_dispatch", "release", "workflow_run"}:
        raise ValueError("Developer ID signing is restricted to explicit builds and release jobs")
    missing = [key for key in MAC_SIGNING_SECRETS if not os.environ.get(key)]
    if missing:
        raise ValueError("Missing macOS signing secrets: " + ", ".join(missing))
    if not re.fullmatch(r"[A-Z0-9]{10}", os.environ["APPLE_TEAM_ID"]):
        raise ValueError("APPLE_TEAM_ID must be a ten-character Apple team identifier")
    signed = dict(plain, **{key: os.environ[key] for key in MAC_SIGNING_SECRETS})
    signed["CSC_IDENTITY_AUTO_DISCOVERY"] = "true"
    # Never enable the signing override used by ad-hoc PR checks for a real certificate.
    signed["CSC_FOR_PULL_REQUEST"] = "false"
    return plain, signed


def verify_macos_app(directory, team_id=None):
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(directory)], check=True)
    if team_id is None:
        return
    for signed in (directory, directory / "Contents/Resources/backend/tagcast-server",
                   directory / "Contents/Resources/backend/tagcast-cli"):
        if signed != directory:
            subprocess.run(["codesign", "--verify", "--strict", str(signed)], check=True)
        details = subprocess.run(["codesign", "--display", "--verbose=4", str(signed)],
                                 check=True, capture_output=True, text=True)
        signature = details.stdout + details.stderr
        if ("Authority=Developer ID Application:" not in signature
                or f"TeamIdentifier={team_id}\n" not in signature
                or not re.search(r"^CodeDirectory .*flags=.*\bruntime\b", signature, re.MULTILINE)):
            raise RuntimeError("App and backend require hardened Developer ID signatures from APPLE_TEAM_ID")
    subprocess.run(["xcrun", "stapler", "validate", str(directory)], check=True)
    subprocess.run(["spctl", "--assess", "--type", "execute", "--verbose=2", str(directory)],
                   check=True)
    reports = ROOT / "build/reports"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "macos-signing.json").write_text(json.dumps({
        "developer_id": True, "hardened_runtime": True,
        "notarization_ticket": True, "gatekeeper": True,
    }, indent=2) + "\n", encoding="utf-8")


def unpacked_app():
    output = ROOT / "electron/out"
    if sys.platform == "darwin":
        package = json.loads((ROOT / "electron/package.json").read_text())
        app = next(output.glob("mac*/" + package["build"].get("executableName", package["productName"]) + ".app"))
        named = app.with_name(package["productName"] + ".app")
        if app != named:
            app.rename(named)
        return named
    return output / ("win-unpacked" if sys.platform == "win32" else "linux-unpacked")


def executable(directory):
    if sys.platform == "darwin":
        return directory / "Contents/MacOS/Tagcast"
    return directory / ("Tagcast.exe" if sys.platform == "win32" else "Tagcast")


def archive_app(directory, info, team_id=None):
    packages = ROOT / "dist/packages"
    packages.mkdir(parents=True, exist_ok=True)
    stem = f'tagcast-{info["version"]}-{system_name()}'
    if sys.platform == "darwin":
        archive = packages / (stem + ".zip")
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(directory), str(archive)], check=True)
    elif sys.platform == "win32":
        archive = Path(shutil.make_archive(str(packages / stem), "zip", directory))
    else:
        archive = packages / (stem + ".tar.gz")
        with tarfile.open(archive, "w:gz") as packed:
            packed.add(directory, arcname="Tagcast")
    with tempfile.TemporaryDirectory(prefix="tagcast electron extracted ") as name:
        extracted = Path(name)
        if sys.platform == "darwin":
            subprocess.run(["ditto", "-x", "-k", str(archive), str(extracted)], check=True)
            directory = extracted / directory.name
            verify_macos_app(directory, team_id)
        elif sys.platform == "win32":
            with zipfile.ZipFile(archive) as packed:
                packed.extractall(extracted)
            directory = extracted
        else:
            with tarfile.open(archive) as packed:
                packed.extractall(extracted, filter="data")
            directory = extracted / "Tagcast"
        check_app(executable(directory), info["version"])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Verified {archive.name}: {digest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", action="store_true", help="Build an unpacked app for local testing")
    parser.add_argument("--skip-install", action="store_true", help="Use an existing npm ci installation")
    parser.add_argument("--sign-macos", action="store_true",
                        help="Require Developer ID signing and Apple notarization (macOS only)")
    args = parser.parse_args()
    try:
        plain_env, pack_env = build_environments(args.sign_macos)
    except ValueError as error:
        parser.error(str(error))
    info = release_info()
    npm_version = info["tag"][1:]
    package = json.loads((ROOT / "electron/package.json").read_text())
    if package["version"] != npm_version:
        parser.error("Electron and Python versions must match")
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    if not npm:
        parser.error("Install Node.js 24 LTS with npm to build Electron")
    prepare_assets(include_tk=False)
    subprocess.run([sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
                    "--distpath", str(ROOT / "build/electron/backend"),
                    "--workpath", str(ROOT / "build/electron/pyinstaller"),
                    str(ROOT / "electron/backend.spec")], check=True, cwd=ROOT, env=plain_env)
    if not args.skip_install:
        subprocess.run([npm, "ci"], check=True, cwd=ROOT / "electron", env=plain_env)
    # Recent Electron releases expose installation as an explicit CLI, rather than postinstall.
    node = shutil.which("node")
    subprocess.run([node, "node_modules/electron/install.js"], check=True, cwd=ROOT / "electron",
                   env=plain_env)
    if not args.sign_macos and sys.platform == "darwin" and package["build"]["mac"].get("identity") == "-":
        # Ad-hoc signing uses no certificate and must also seal PR builds after hardening.
        pack_env["CSC_FOR_PULL_REQUEST"] = "true"
    command = [npm, "run", "pack"]
    if args.sign_macos:
        command += ["--", "--config", str(ROOT / "tools/electron_signed.cjs")]
    subprocess.run(command, check=True, cwd=ROOT / "electron", env=pack_env)
    directory = unpacked_app()
    team_id = pack_env["APPLE_TEAM_ID"] if args.sign_macos else None
    if args.dir:
        if sys.platform == "darwin":
            verify_macos_app(directory, team_id)
        check_app(executable(directory), info["version"])
        print(f"Verified app: {directory}")
    else:
        archive_app(directory, info, team_id)


if __name__ == "__main__":
    main()
