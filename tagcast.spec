"""Desktop launcher and CLI with one bundled Python runtime."""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import copy_metadata

root = Path(SPECPATH)
sys.path.insert(0, str(root / "src"))
from tagcast import __version__

assets = root / "build" / "assets"
data = [(str(root / "src" / "tagcast" / "static"), "tagcast/static"),
        (str(assets / "tagcast-icon.png"), "tagcast/static"),
        (str(assets / "licenses"), "licenses"),
        (str(root / "LICENSE"), "."), (str(root / "README.md"), "."),
        (str(root / "docs" / "native-builds.md"), "docs")]
data += copy_metadata("ibroadcast")
analysis = Analysis([str(root / "tools" / "pyinstaller_entry.py")],
                    pathex=[str(root / "src"), str(root / "tools")], datas=data)
pyz = PYZ(analysis.pure)
icon = str(assets / ("tagcast.icns" if sys.platform == "darwin" else "tagcast.ico"))
gui = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="Tagcast",
          console=False, icon=icon, upx=False)
cli = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="tagcast-cli",
          console=True, icon=icon, upx=False)
collection = COLLECT(gui, [(Path(cli.name).name, cli.name, "EXECUTABLE")],
                     analysis.binaries, analysis.datas, name="Tagcast", upx=False)
if sys.platform == "darwin":
    bundle = BUNDLE(collection, name="Tagcast.app", icon=icon,
                    bundle_identifier="nl.cyberdelia.tagcast", version=__version__,
                    info_plist={"CFBundleShortVersionString": __version__,
                                "NSHighResolutionCapable": True})
