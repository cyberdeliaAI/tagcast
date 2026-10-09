"""Build a stand-alone Tagcast program with PyInstaller, for people without Python or uv.

Run:  uv run --with pyinstaller python tools/build_binary.py

The result is dist/tagcast-<version>-<system>.zip with one program that starts Tagcast and
opens the browser, like the start scripts. PyInstaller only builds for the system it runs
on, so .github/workflows/builds.yml runs this on macOS, Windows and Linux.
"""

import os
import platform
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

FIRST_START = """Tagcast {version}

Double-click {program}. A window opens with Tagcast's messages, and your browser opens
Tagcast. Close the window to stop Tagcast.

This program is not signed, so your computer asks once whether to trust it:
- macOS: if macOS refuses to open it, open System Settings > Privacy & Security,
  scroll down and choose Open Anyway.
- Windows: if "Windows protected your PC" appears, choose More info, then Run anyway.

Settings and sign-in are kept in ~/.tagcast, the same as with the start scripts.
More: https://github.com/cyberdeliaAI/tagcast
"""


def system_name():
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    name = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
    return f"{name}-{arch}"


def main():
    import PyInstaller.__main__

    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    work = ROOT / "build" / "pyinstaller"
    PyInstaller.__main__.run([
        "--noconfirm", "--clean", "--onefile", "--name", "tagcast",
        "--distpath", str(DIST), "--workpath", str(work), "--specpath", str(work),
        "--paths", str(ROOT / "src"),
        # app.py serves the page from the static folder next to it
        "--add-data", f"{ROOT / 'src' / 'tagcast' / 'static'}{os.pathsep}tagcast/static",
        # ibroadcast reads its own version from its package metadata when it is imported
        "--copy-metadata", "ibroadcast",
        str(ROOT / "tools" / "pyinstaller_entry.py"),
    ])
    program = DIST / ("tagcast.exe" if sys.platform == "win32" else "tagcast")

    # --help imports everything Tagcast needs and stops before it serves anything.
    check = subprocess.run([str(program), "--help"], capture_output=True, text=True, timeout=300)
    if "usage: tagcast" not in check.stdout:
        sys.exit(f"The built program does not start:\n{check.stdout}{check.stderr}")

    archive = DIST / f"tagcast-{version}-{system_name()}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
        zipped.write(program, program.name)  # keeps the execute permission for macOS and Linux
        note = zipfile.ZipInfo("READ ME FIRST.txt")
        note.external_attr = 0o644 << 16
        zipped.writestr(note, FIRST_START.format(version=version, program=program.name), zipfile.ZIP_DEFLATED)
    print(archive)


if __name__ == "__main__":
    main()
