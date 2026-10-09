"""Build desktop/CLI packages and check the archive users actually download."""

import argparse
import hashlib
import importlib.metadata as metadata
import io
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
import zipfile
from pathlib import Path

from release_info import release_info

ROOT = Path(__file__).resolve().parent.parent


def system_name():
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    name = {"darwin": "macos", "win32": "windows", "linux": "linux"}.get(sys.platform)
    if name is None or (name, arch) not in {("macos", "arm64"), ("macos", "x64"),
                                           ("windows", "x64"), ("linux", "x64")}:
        raise ValueError(f"Unsupported native target: {sys.platform} {machine}")
    return f"{name}-{arch}"


def prepare_assets():
    import tkinter as tk

    import resvg_py
    from PIL import Image

    assets = ROOT / "build" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    png = resvg_py.svg_to_bytes(svg_path=str(ROOT / "assets/tagcast-icon.svg"), width=1024, height=1024)
    image = Image.open(io.BytesIO(png))
    image.resize((512, 512)).save(assets / "tagcast-icon.png")
    image.save(assets / "tagcast.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)])
    if sys.platform == "darwin":
        image.save(assets / "tagcast.icns")
    licenses = assets / "licenses"
    versions = {"Python": platform.python_version()}
    python_license = next((p for p in (Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
                                      Path(sys.base_prefix) / "LICENSE.txt") if p.is_file()), None)
    if python_license is None:
        raise RuntimeError("The bundled Python license is missing")
    (licenses / "Python").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(python_license, licenses / "Python/LICENSE.txt")
    root = tk.Tk()
    root.withdraw()
    try:
        for name, expression in (("Tcl", "info library"), ("Tk", "set tk_library")):
            library = Path(root.tk.eval(expression))
            notice = next((p for folder in (library, library.parent)
                           for p in folder.glob("license*") if p.is_file()), None)
            if notice is None:
                raise RuntimeError(f"The bundled {name} license is missing")
            (licenses / name).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(notice, licenses / name / notice.name)
        versions["Tcl"] = root.tk.call("info", "patchlevel")
        versions["Tk"] = root.tk.call("package", "present", "Tk")
    finally:
        root.destroy()
    for name in ("ibroadcast", "requests", "certifi", "charset-normalizer", "idna", "urllib3", "PyInstaller"):
        dist = metadata.distribution(name)
        versions[name] = dist.version
        copied = False
        for entry in dist.files or []:
            if not any(part.lower().startswith(("license", "copying")) for part in Path(entry).parts):
                continue
            source = Path(dist.locate_file(entry))
            if source.is_file():
                destination = licenses / name / Path(entry).name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                copied = True
        if not copied:
            expression = dist.metadata.get("License-Expression")
            if not expression:
                raise RuntimeError(f"The bundled {name} license is missing")
            (licenses / name).mkdir(parents=True, exist_ok=True)
            (licenses / name / "NOTICE.txt").write_text(
                f"{name} {dist.version}\nLicense-Expression: {expression}\n"
                + "\n".join(dist.metadata.get_all("Project-URL") or []) + "\n", encoding="utf-8")
    (licenses / "versions.json").write_text(json.dumps(versions, indent=2), encoding="utf-8")


def executables(directory):
    base = directory / "Tagcast.app/Contents/MacOS" if sys.platform == "darwin" else directory / "Tagcast"
    suffix = ".exe" if sys.platform == "win32" else ""
    return base / ("Tagcast" + suffix), base / ("tagcast-cli" + suffix)


def check_bundle(directory, info):
    reports = ROOT / "build" / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    gui, cli = executables(directory)
    for executable in (gui, cli):
        report = reports / (executable.stem + ".json")
        completed = subprocess.run([str(executable), "--bundle-smoke-test", str(report)],
                                   cwd=directory, timeout=90)
        data = json.loads(report.read_text(encoding="utf-8"))
        if completed.returncode or not data.get("ok") or data.get("version") != info["version"]:
            raise RuntimeError(f"Extracted package check failed: {data}")
    for arguments, expected in ((["--help"], "usage: tagcast"), (["--version"], info["version"])):
        checked = subprocess.run([str(cli), *arguments], check=True, capture_output=True,
                                 text=True, timeout=30, cwd=directory)
        if expected not in checked.stdout:
            raise RuntimeError(f"CLI check failed: {arguments}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-tag", default="", help="Require the tag to match the bundled version")
    args = parser.parse_args()
    info = release_info()
    if args.release_tag and args.release_tag != info["tag"]:
        parser.error(f'Release tag must be {info["tag"]}')
    target = system_name()
    prepare_assets()
    subprocess.run([sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm",
                    "--distpath", str(ROOT / "dist/app"), str(ROOT / "tagcast.spec")], check=True, cwd=ROOT)
    packages = ROOT / "dist/packages"
    packages.mkdir(parents=True, exist_ok=True)
    stem = f'tagcast-{info["version"]}-{target}'
    if sys.platform == "darwin":
        archive = packages / (stem + ".zip")
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent",
                        str(ROOT / "dist/app/Tagcast.app"), str(archive)], check=True)
    elif sys.platform == "win32":
        archive = Path(shutil.make_archive(str(packages / stem), "zip", ROOT / "dist/app", "Tagcast"))
    else:
        archive = packages / (stem + ".tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(ROOT / "dist/app/Tagcast", arcname="Tagcast")
    with tempfile.TemporaryDirectory(prefix="tagcast extracted download ") as directory:
        extracted = Path(directory)
        if sys.platform == "darwin":
            subprocess.run(["ditto", "-x", "-k", str(archive), str(extracted)], check=True)
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(extracted / "Tagcast.app")], check=True)
        elif sys.platform == "win32":
            with zipfile.ZipFile(archive) as zipped:
                zipped.extractall(extracted)
        else:
            with tarfile.open(archive) as tar:
                tar.extractall(extracted, filter="data")
        check_bundle(extracted, info)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Verified {archive.name}: {digest}")


if __name__ == "__main__":
    main()
