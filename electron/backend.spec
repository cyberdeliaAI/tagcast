"""Bundle the shared Python server for Electron without the Tk launcher."""
from pathlib import Path

from PyInstaller.utils.hooks import copy_metadata

root = Path(SPECPATH).parent
data = [(str(root / "src/tagcast/static"), "tagcast/static"),
        (str(root / "build/assets/tagcast-icon.png"), "tagcast/static"),
        (str(root / "build/assets/licenses"), "licenses"),
        (str(root / "LICENSE"), ".")]
data += copy_metadata("ibroadcast")
analysis = Analysis([str(root / "tools/electron_backend_entry.py")],
                    pathex=[str(root / "src")], datas=data, excludes=["tkinter"])
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True,
          name="tagcast-server", console=True, upx=False)
cli = EXE(pyz, analysis.scripts, [], exclude_binaries=True,
          name="tagcast-cli", console=True, upx=False)
collection = COLLECT(exe, [(Path(cli.name).name, cli.name, "EXECUTABLE")],
                     analysis.binaries, analysis.datas, name="tagcast-server", upx=False)
