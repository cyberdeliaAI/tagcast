"""Export the public media kit using the existing native-build image dependencies."""

import io
import shutil
import zipfile
from pathlib import Path

import resvg_py
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"


def render(source, destination, width, height):
    png = resvg_py.svg_to_bytes(svg_path=str(source), width=width, height=height)
    with Image.open(io.BytesIO(png)) as image:
        image.save(destination, optimize=True)


def main():
    logos = MEDIA / "logos"
    social = MEDIA / "social"
    logos.mkdir(parents=True, exist_ok=True)
    social.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "assets/tagcast-icon.svg", logos / "tagcast-icon.svg")
    for size in (128, 512, 1024):
        destination = logos / f"tagcast-icon-{size}.png"
        render(logos / "tagcast-icon.svg", destination, size, size)
        if size in (128, 512):
            shutil.copyfile(destination, ROOT / f"assets/tagcast-icon-{size}.png")
    for appearance in ("dark", "light"):
        stem = logos / f"tagcast-lockup-{appearance}"
        render(stem.with_suffix(".svg"), stem.with_suffix(".png"), 1600, 448)
    mono = logos / "tagcast-icon-monochrome"
    render(mono.with_suffix(".svg"), mono.with_suffix(".png"), 1024, 1024)
    shutil.copyfile(ROOT / "assets/tagcast-social-preview.svg", social / "tagcast-social-preview.svg")
    render(social / "tagcast-social-preview.svg", social / "tagcast-social-preview.png", 1280, 640)
    shutil.copyfile(social / "tagcast-social-preview.png", ROOT / "assets/tagcast-social-preview.png")
    shutil.copyfile(ROOT / "LICENSE", MEDIA / "LICENSE")
    archive = MEDIA / "tagcast-media-kit.zip"
    # Fixed entry timestamps and ordering make repeated exports byte-for-byte identical.
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(MEDIA.rglob("*")):
            if not path.is_file() or path == archive:
                continue
            entry = zipfile.ZipInfo("tagcast-media-kit/" + path.relative_to(MEDIA).as_posix(),
                                    date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            output.writestr(entry, path.read_bytes())
    print(f"Exported {archive.relative_to(ROOT)} ({archive.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
