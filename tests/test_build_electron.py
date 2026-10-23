"""PR builds retain ad-hoc macOS integrity signing without enabling certificate signing."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_electron  # noqa: E402


class ElectronBuildTests(unittest.TestCase):
    def test_pr_signing_override_is_limited_to_adhoc_macos_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "electron").mkdir()
            for platform, identity in (("darwin", "-"), ("darwin", "Developer ID"),
                                       ("linux", "-"), ("win32", "-")):
                with self.subTest(platform=platform, identity=identity):
                    (root / "electron/package.json").write_text(json.dumps({
                        "version": "0.80.0", "build": {"mac": {"identity": identity}}
                    }), encoding="utf-8")
                    with (patch.object(build_electron, "ROOT", root),
                          patch.object(build_electron.sys, "platform", platform),
                          patch.object(sys, "argv", ["build_electron.py", "--dir", "--skip-install"]),
                          patch.dict(os.environ, {"CSC_FOR_PULL_REQUEST": "false"}),
                          patch.object(build_electron, "release_info", return_value={
                              "version": "0.80.0", "tag": "v0.80.0"}),
                          patch.object(build_electron, "prepare_assets"),
                          patch.object(build_electron.shutil, "which", side_effect=lambda name: name),
                          patch.object(build_electron.subprocess, "run") as run,
                          patch.object(build_electron, "unpacked_app", return_value=root / "app"),
                          patch.object(build_electron, "check_app")):
                        build_electron.main()
                    pack = next(call for call in run.call_args_list
                                if call.args[0][1:] == ["run", "pack"])
                    env = pack.kwargs["env"]
                    self.assertEqual(env["CSC_IDENTITY_AUTO_DISCOVERY"], "false")
                    self.assertEqual(env["CSC_FOR_PULL_REQUEST"],
                                     "true" if platform == "darwin" and identity == "-" else "false")
