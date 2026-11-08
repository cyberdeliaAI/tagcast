"""Build the Debian package from the checked Linux app and verify a real installation."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from check_electron import check_app

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def package_metadata(package, version):
    fields = subprocess.check_output(
        ["dpkg-deb", "--show", "--showformat=${Package}\\n${Version}\\n${Architecture}\\n", str(package)],
        text=True).splitlines()
    if fields != ["tagcast", version, "amd64"]:
        raise ValueError("Debian package identity/version/architecture does not match the release.")


def build_deb(directory, info, node, env):
    subprocess.run([node, "node_modules/electron-builder/cli.js", "--prepackaged", str(directory),
                    "--linux", "deb", "--x64", "--publish", "never", "--config",
                    str(ROOT / "tools/electron_deb.cjs")],
                   cwd=ROOT / "electron", env=env, check=True)
    filename = f'tagcast-{info["version"]}-linux-amd64.deb'
    package = ROOT / "dist/packages" / filename
    package.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(ROOT / "electron/out-deb" / filename, package)
    package_metadata(package, info["version"])
    with tempfile.TemporaryDirectory(prefix="tagcast deb extracted ") as name:
        extracted = Path(name)
        subprocess.run(["dpkg-deb", "--extract", str(package), str(extracted)], check=True)
        check_app(extracted / "opt/Tagcast/Tagcast", info["version"])
    checksum = digest(package)
    package.with_name(package.name + ".sha256").write_text(
        f"{checksum}  {package.name}\n", encoding="ascii")
    print(f"Verified Debian package {package.name}: {checksum}")


def check_installed(package, version, distribution):
    """Run after apt installation as the normal CI user, never root or without sandbox."""
    package_metadata(package, version)
    executable = Path("/opt/Tagcast/Tagcast")
    desktop = Path("/usr/share/applications/Tagcast.desktop")
    if (not executable.is_file() or not desktop.is_file()
            or "Exec=/opt/Tagcast/Tagcast" not in desktop.read_text()
            or not Path("/usr/bin/Tagcast").samefile(executable)):
        raise ValueError("Installed desktop launcher is missing or targets the wrong application.")
    cli = subprocess.check_output(["tagcast-cli", "--version"], text=True, timeout=30)
    if cli.strip() != f"Tagcast {version}":
        raise ValueError("Installed terminal command does not match the release.")
    check_app(executable, version)
    smoke = json.loads((ROOT / "build/reports/electron.json").read_text())
    if smoke.get("sandbox") is not True or smoke.get("ok") is not True:
        raise ValueError("Installed Debian application did not pass its sandboxed startup check.")
    report = {"package": package.name, "sha256": digest(package), "version": version,
              "distribution": distribution, "installed_startup": True, "sandbox": True,
              "desktop_launcher": True, "cli": True, "certificates": smoke["certificates"]}
    destination = ROOT / "build/reports/linux-deb.json"
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("version")
    parser.add_argument("distribution", choices=["ubuntu-22.04", "ubuntu-24.04"])
    args = parser.parse_args()
    check_installed(args.package.resolve(), args.version, args.distribution)
