"""Native matrices cannot pass with missing coverage, leaked credentials or a leftover server."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import check_workspace  # noqa: E402


class WorkspaceCheckTests(unittest.TestCase):
    def exercise(self, transform=lambda data: data, *, timeout=False, alive=False):
        calls = []

        def launch(arguments, **kwargs):
            env = kwargs["env"]
            self.assertFalse(any(key.startswith(("CSC_", "APPLE_")) for key in env))
            self.assertNotIn("IBROADCAST_CLIENT_ID", env)
            self.assertNotIn("TAGCAST_IBROADCAST_BASE", env)
            self.assertNotIn("TAGCAST_ELECTRON_SMOKE_REPORT", env)
            self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
            self.assertEqual(env["TAGCAST_PORT"], "0")
            self.assertEqual(json.loads((Path(env["TAGCAST_HOME"]) / "config.json").read_text()),
                             {"auto_updates": False, "auto_lookup": False})
            calls.append(env)
            data = {"ok": True, "kind": env["TAGCAST_WORKSPACE_SMOKE_CASE"], "version": "1.8.0",
                    "origin": "http://127.0.0.1:1234", "samples": [
                        {"width": width, "appearance": theme, "pointer": True, "keyboard": True,
                         "sameAudio": True, "skipWithoutWrites": True}
                        for width in (420, 760, 768, 1280) for theme in ("light", "dark")]}
            if data["kind"] == "workspace":
                data["samples"].append({"restored": [
                    {"width": width, "appearance": theme, "restoredWithoutAlbumVisit": True,
                     "duplicatePositions": True, "noAutoplay": True, "staleMetadataRetired": True}
                    for width in (420, 760, 768, 1280) for theme in ("light", "dark")]})
            Path(env["TAGCAST_WORKSPACE_SMOKE_REPORT"]).write_text(json.dumps(transform(data)))
            process = Mock()
            process.wait.side_effect = [subprocess.TimeoutExpired("app", 90), 0] if timeout else [0]
            return process

        inherited = {"PATH": "path", "TAGCAST_HOME": "real settings", "TAGCAST_IBROADCAST_BASE": "remote",
                     "TAGCAST_ELECTRON_SMOKE_REPORT": "other report", "CSC_LINK": "private",
                     "APPLE_ID": "private", "IBROADCAST_CLIENT_ID": "real", "ELECTRON_RUN_AS_NODE": "1"}
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            with (patch.object(check_workspace.subprocess, "Popen", side_effect=launch),
                  patch.object(check_workspace, "urlopen", side_effect=None if alive else OSError)):
                check_workspace.check_workspace(Path("Tagcast"), inherited, reports, "1.8.0")
            self.assertEqual({p.name for p in reports.iterdir()},
                             {"electron-workspace.json", "electron-setup.json"})
        return calls

    def test_both_complete_matrices_require_separate_profiles_and_owned_server_shutdown(self):
        calls = self.exercise()
        self.assertEqual([call["TAGCAST_WORKSPACE_SMOKE_CASE"] for call in calls], ["workspace", "setup"])
        self.assertNotEqual(calls[0]["TAGCAST_HOME"], calls[1]["TAGCAST_HOME"])
        self.assertNotEqual(calls[0]["TAGCAST_ELECTRON_PROFILE"], calls[1]["TAGCAST_ELECTRON_PROFILE"])

    def test_incomplete_failed_or_wrong_version_results_block_distribution(self):
        cases = {
            "missing viewport": lambda data: {**data, "samples": data["samples"][1:]},
            "duplicate viewport": lambda data: {**data, "samples": data["samples"][:1] * 8},
            "no pointer": lambda data: {**data, "samples": [
                {**sample, "pointer": False} for sample in data["samples"]]},
            "failed assertion": lambda data: {**data, "ok": False},
            "wrong version": lambda data: {**data, "version": "1.7.0"},
            "missing restore cases": lambda data: {**data, "samples": data["samples"][:-1]},
        }
        for name, transform in cases.items():
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "matrix failed"):
                self.exercise(transform)

    def test_stuck_process_or_leftover_backend_blocks_distribution(self):
        with self.assertRaisesRegex(RuntimeError, "did not finish"):
            self.exercise(timeout=True)
        with self.assertRaisesRegex(RuntimeError, "owned server running"):
            self.exercise(alive=True)
