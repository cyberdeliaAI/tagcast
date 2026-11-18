"""Run unchanged workspace/setup viewport matrices in separate bounded native processes."""

import json
import subprocess
import tempfile
from pathlib import Path
from urllib.request import urlopen


def check_workspace(executable, inherited, reports, version):
    for kind in ("workspace", "setup"):
        with tempfile.TemporaryDirectory(prefix=f"tagcast {kind} check ") as directory:
            root = Path(directory)
            settings, profile, report = root / "settings", root / "profile", root / "report.json"
            settings.mkdir()
            profile.mkdir()
            (settings / "config.json").write_text('{"auto_updates":false,"auto_lookup":false}')
            env = {key: value for key, value in inherited.items()
                   if not key.startswith(("TAGCAST_", "CSC_", "WIN_CSC_", "APPLE_"))}
            for key in ("IBROADCAST_CLIENT_ID", "ELECTRON_RUN_AS_NODE"):
                env.pop(key, None)
            env.update(TAGCAST_HOME=str(settings), TAGCAST_ELECTRON_PROFILE=str(profile),
                       TAGCAST_PORT="0", TAGCAST_WORKSPACE_SMOKE_REPORT=str(report),
                       TAGCAST_WORKSPACE_SMOKE_CASE=kind)
            process = subprocess.Popen([str(executable)], env=env, cwd=root,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                result = process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=15)
                raise RuntimeError(f"The isolated {kind} process did not finish") from None
            finally:
                data = json.loads(report.read_text()) if report.exists() else {"ok": False}
                (reports / f"electron-{kind}.json").write_text(json.dumps(data, indent=2) + "\n")
            expected = {(width, theme) for width in (420, 760, 768, 1280)
                        for theme in ("light", "dark")}
            samples = data.get("samples", [])
            matrix = [item for item in samples if "restored" not in item]
            actual = {(item.get("width"), item.get("appearance")) for item in matrix}
            restored = [item["restored"] for item in samples if "restored" in item]
            restored_ok = (not restored if kind == "setup" else
                           len(restored) == 1 and len(restored[0]) == 8
                           and {(item.get("width"), item.get("appearance"))
                                for item in restored[0]} == expected
                           and all(item.get(key) is True for item in restored[0] for key in
                                   ("restoredWithoutAlbumVisit", "duplicatePositions", "noAutoplay",
                                    "staleMetadataRetired")))
            flags = ("pointer", "keyboard", "sameAudio" if kind == "workspace" else "skipWithoutWrites")
            if (result or not data.get("ok") or data.get("version") != version
                    or data.get("kind") != kind or len(matrix) != 8 or actual != expected
                    or not restored_ok
                    or any(item.get(key) is not True for item in matrix for key in flags)):
                raise RuntimeError(f"Native {kind} matrix failed: {data}")
            try:
                urlopen(data["origin"] + "/api/app", timeout=1)
            except OSError:
                pass
            else:
                raise RuntimeError(f"The {kind} process left its owned server running")
            print(f"Checked native {kind}: eight unchanged pointer/keyboard viewport cases")
