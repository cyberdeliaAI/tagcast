"""Build an optional Electron shell around the same frozen Python server and page."""

import argparse
import hashlib
import json
import os
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


def unpacked_app():
    output = ROOT / "electron/out"
    if sys.platform == "darwin":
        return next(output.glob("mac*/Tagcast.app"))
    return output / ("win-unpacked" if sys.platform == "win32" else "linux-unpacked")


def executable(directory):
    if sys.platform == "darwin":
        return directory / "Contents/MacOS/Tagcast"
    return directory / ("Tagcast.exe" if sys.platform == "win32" else "Tagcast")


def archive_app(directory, info):
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
            directory = extracted / "Tagcast.app"
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(directory)], check=True)
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
    args = parser.parse_args()
    info = release_info()
    npm_version = info["tag"][1:]
    if json.loads((ROOT / "electron/package.json").read_text())["version"] != npm_version:
        parser.error("Electron and Python versions must match")
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    if not npm:
        parser.error("Install Node.js 24 LTS with npm to build Electron")
    prepare_assets(include_tk=False)
    subprocess.run([sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
                    "--distpath", str(ROOT / "build/electron/backend"),
                    "--workpath", str(ROOT / "build/electron/pyinstaller"),
                    str(ROOT / "electron/backend.spec")], check=True, cwd=ROOT)
    if not args.skip_install:
        subprocess.run([npm, "ci"], check=True, cwd=ROOT / "electron")
    # Recent Electron releases expose installation as an explicit CLI, rather than postinstall.
    node = shutil.which("node")
    subprocess.run([node, "node_modules/electron/install.js"], check=True, cwd=ROOT / "electron")
    env = dict(os.environ, CSC_IDENTITY_AUTO_DISCOVERY="false")
    subprocess.run([npm, "run", "pack"], check=True,
                   cwd=ROOT / "electron", env=env)
    directory = unpacked_app()
    if args.dir:
        check_app(executable(directory), info["version"])
        print(f"Verified app: {directory}")
    else:
        archive_app(directory, info)


if __name__ == "__main__":
    main()
