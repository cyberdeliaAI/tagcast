"""Ordinary builds stay ad-hoc; explicit macOS signing fails closed and isolates credentials."""

import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_electron  # noqa: E402
import check_electron  # noqa: E402


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

    def test_ordinary_builds_strip_all_signing_credentials(self):
        credentials = dict.fromkeys(build_electron.MAC_SIGNING_SECRETS, "sensitive-test-value")
        credentials.update(CSC_NAME="wrong identity", APPLE_API_KEY="private.p8",
                           WIN_CSC_LINK="windows-key", PATH="retained")
        with patch.dict(os.environ, credentials, clear=True):
            plain, packed = build_electron.build_environments(False)
        self.assertEqual(plain, packed)
        self.assertEqual(plain, {"PATH": "retained", "CSC_IDENTITY_AUTO_DISCOVERY": "false",
                                 "CSC_FOR_PULL_REQUEST": "false"})

    def test_explicit_signing_keeps_credentials_only_in_pack_environment(self):
        credentials = dict.fromkeys(build_electron.MAC_SIGNING_SECRETS, "sensitive-test-value")
        credentials.update(APPLE_TEAM_ID="ABCDEFGHIJ", GITHUB_EVENT_NAME="workflow_dispatch",
                           CSC_FOR_PULL_REQUEST="true", APPLE_API_KEY="unselected-key.p8")
        with (patch.dict(os.environ, credentials, clear=True),
              patch.object(build_electron.sys, "platform", "darwin")):
            plain, signed = build_electron.build_environments(True)
        for key in build_electron.MAC_SIGNING_SECRETS:
            self.assertNotIn(key, plain)
            self.assertEqual(signed[key], credentials[key])
        self.assertNotIn("APPLE_API_KEY", signed)
        self.assertEqual(signed["CSC_FOR_PULL_REQUEST"], "false")
        self.assertEqual(signed["CSC_IDENTITY_AUTO_DISCOVERY"], "true")

    def test_smoke_app_and_cli_never_inherit_signing_credentials(self):
        credentials = dict.fromkeys(build_electron.MAC_SIGNING_SECRETS, "sensitive-test-value")
        with (patch.dict(os.environ, credentials),
              patch.object(check_electron.subprocess, "run",
                           return_value=Mock(stdout="usage: tagcast\nTagcast 1.1.0\n")) as cli,
              patch.object(check_electron.subprocess, "Popen",
                           side_effect=RuntimeError("test stops before launch")) as app):
            with self.assertRaisesRegex(RuntimeError, "test stops before launch"):
                check_electron.check_app(Path("Test.app/Contents/MacOS/Tagcast"), "1.1.0")
        for call in [*cli.call_args_list, *app.call_args_list]:
            env = call.kwargs["env"]
            for key in build_electron.MAC_SIGNING_SECRETS:
                self.assertNotIn(key, env)
            self.assertEqual(env["TAGCAST_PORT"], "0")

    def test_failed_smoke_preserves_diagnostic_report(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                diagnostic = {"ok": False, "pending": True,
                              "diagnostics": {"phase": "mini-player", "loaded": True}}

                def launch(_arguments, **kwargs):
                    Path(kwargs["env"]["TAGCAST_ELECTRON_SMOKE_REPORT"]).write_text(
                        json.dumps(diagnostic))
                    process = Mock()
                    process.wait.side_effect = ([subprocess.TimeoutExpired("app", 90), 0]
                                                if timeout else [1])
                    return process

                with (patch.object(check_electron, "__file__", str(root / "tools/check_electron.py")),
                      patch.object(check_electron.subprocess, "run", return_value=Mock(
                          stdout="usage: tagcast\nTagcast 1.1.0\n")),
                      patch.object(check_electron.subprocess, "Popen", side_effect=launch)):
                    with self.assertRaisesRegex(RuntimeError, "did not finish" if timeout
                                                else "Electron check failed"):
                        check_electron.check_app(Path("Test.app/Contents/MacOS/Tagcast"), "1.1.0")
                saved = json.loads((root / "build/reports/electron.json").read_text())
                self.assertEqual(saved, diagnostic)

    def test_signing_rejects_missing_credentials_and_untrusted_events_before_build(self):
        credentials = dict.fromkeys(build_electron.MAC_SIGNING_SECRETS, "sensitive-test-value")
        credentials["APPLE_TEAM_ID"] = "ABCDEFGHIJ"
        cases = [("linux", credentials), ("win32", credentials),
                 ("darwin", {}),
                 ("darwin", {**credentials, "APPLE_TEAM_ID": "bad-private-value"})]
        cases += [("darwin", {**credentials, "GITHUB_EVENT_NAME": event})
                  for event in ("pull_request", "pull_request_target", "push", "merge_group")]
        for platform, env in cases:
            with self.subTest(platform=platform, event=env.get("GITHUB_EVENT_NAME")):
                with (patch.dict(os.environ, env, clear=True),
                      patch.object(build_electron.sys, "platform", platform),
                      patch.object(sys, "argv", ["build_electron.py", "--sign-macos"]),
                      patch.object(build_electron, "prepare_assets") as prepare,
                      patch.object(build_electron.subprocess, "run") as run,
                      patch("sys.stderr")):
                    with self.assertRaises(SystemExit):
                        build_electron.main()
                    prepare.assert_not_called()
                    run.assert_not_called()

    def test_missing_secret_errors_do_not_include_values(self):
        with (patch.dict(os.environ, {"CSC_LINK": "private-certificate-value"}, clear=True),
              patch.object(build_electron.sys, "platform", "darwin")):
            with self.assertRaises(ValueError) as result:
                build_electron.build_environments(True)
        self.assertNotIn("private-certificate-value", str(result.exception))
        self.assertIn("CSC_KEY_PASSWORD", str(result.exception))

    def test_signing_verification_rejects_wrong_certificate_or_backend(self):
        good = ("CodeDirectory v=20500 size=100 flags=0x10000(runtime)\n"
                "Authority=Developer ID Application: Test\nTeamIdentifier=ABCDEFGHIJ\n")
        bad = (good.replace("ABCDEFGHIJ", "WRONGTEAM1"),
               good.replace("Developer ID Application:", "Apple Development:"),
               good.replace("0x10000(runtime)", "0x2(adhoc)"))
        for signature in bad:
            for target in range(3):
                with self.subTest(signature=signature, target=target):
                    count = 0

                    def run(command, **kwargs):
                        nonlocal count
                        if command[:2] == ["codesign", "--display"]:
                            value = signature if count == target else good
                            count += 1
                            return Mock(stdout="", stderr=value)
                        return Mock()

                    with patch.object(build_electron.subprocess, "run", side_effect=run) as process:
                        with self.assertRaises(RuntimeError):
                            build_electron.verify_macos_app(Path("Test.app"), "ABCDEFGHIJ")
                    self.assertFalse(any(call.args[0][0] == "spctl"
                                         for call in process.call_args_list))

    def test_verified_report_requires_stapling_and_gatekeeper(self):
        good = Mock(stdout="", stderr=("CodeDirectory v=20500 flags=0x10000(runtime)\n"
                                       "Authority=Developer ID Application: Test\n"
                                       "TeamIdentifier=ABCDEFGHIJ\n"))
        for failure in ("stapler", "spctl", None):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)

                def run(command, **kwargs):
                    if failure and failure in command:
                        raise subprocess.CalledProcessError(1, command)
                    return good

                with (patch.object(build_electron, "ROOT", root),
                      patch.object(build_electron.subprocess, "run", side_effect=run)):
                    if failure:
                        with self.assertRaises(subprocess.CalledProcessError):
                            build_electron.verify_macos_app(root / "Test.app", "ABCDEFGHIJ")
                        self.assertFalse((root / "build/reports/macos-signing.json").exists())
                    else:
                        build_electron.verify_macos_app(root / "Test.app", "ABCDEFGHIJ")
                        report = json.loads((root / "build/reports/macos-signing.json").read_text())
                        self.assertEqual(report, {"developer_id": True, "hardened_runtime": True,
                                                  "notarization_ticket": True, "gatekeeper": True})

    def test_signed_config_preserves_package_and_minimal_entitlements(self):
        root = Path(__file__).resolve().parent.parent
        config = subprocess.run(["node", "-e", "console.log(JSON.stringify(require('./tools/electron_signed.cjs')))"],
                                cwd=root, check=True, capture_output=True, text=True)
        signed = json.loads(config.stdout)
        original = json.loads((root / "electron/package.json").read_text())["build"]
        self.assertEqual(original["mac"]["identity"], "-")
        self.assertNotIn("identity", signed["mac"])
        self.assertTrue(signed["forceCodeSigning"])
        self.assertTrue(signed["mac"]["notarize"])
        self.assertTrue(signed["mac"]["hardenedRuntime"])
        self.assertEqual(signed["mac"]["type"], "distribution")
        for key in ("appId", "files", "extraResources", "afterPack", "win", "linux"):
            self.assertEqual(signed[key], original[key])
        with Path(signed["mac"]["entitlements"]).open("rb") as source:
            self.assertEqual(plistlib.load(source), {"com.apple.security.cs.allow-jit": True})
        self.assertEqual(signed["mac"]["entitlements"], signed["mac"]["entitlementsInherit"])
