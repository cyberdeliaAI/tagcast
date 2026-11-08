"""Debian packaging shares the production app and requires installed sandbox checks."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import linux_deb  # noqa: E402


class DebianPackageTests(unittest.TestCase):
    def test_identity_version_and_architecture_are_checked(self):
        for fields in ("tagcast\n1.6.5\namd64\n", "other\n1.6.5\namd64\n",
                       "tagcast\n1.6.0\namd64\n", "tagcast\n1.6.5\narm64\n"):
            with self.subTest(fields=fields), patch.object(
                    linux_deb.subprocess, "check_output", return_value=fields):
                if fields == "tagcast\n1.6.5\namd64\n":
                    linux_deb.package_metadata(Path("test.deb"), "1.6.5")
                else:
                    with self.assertRaises(ValueError):
                        linux_deb.package_metadata(Path("test.deb"), "1.6.5")

    def test_config_reuses_hardened_app_and_default_sandbox_installation_hooks(self):
        root = Path(__file__).resolve().parent.parent
        config = json.loads(subprocess.check_output([
            "node", "-e", "console.log(JSON.stringify(require('./tools/electron_deb.cjs')))"],
            cwd=root, text=True))
        original = json.loads((root / "electron/package.json").read_text())["build"]
        for key in ("appId", "executableName", "asar", "files", "extraResources", "afterPack"):
            self.assertEqual(config[key], original[key])
        self.assertEqual(config["linux"]["target"], ["deb"])
        self.assertEqual(config["deb"]["packageName"], "tagcast")
        self.assertNotIn("afterInstall", config["deb"])
        self.assertNotIn("afterRemove", config["deb"])
        self.assertEqual(config["deb"]["fpm"], [str(root / "tools/tagcast-cli") + "=/usr/bin/tagcast-cli"])
        wrapper = root / "tools/tagcast-cli"
        if sys.platform != "win32":
            self.assertTrue(wrapper.stat().st_mode & 0o111)
        self.assertIn('exec /opt/Tagcast/resources/backend/tagcast-cli "$@"', wrapper.read_text())

    def test_repackages_checked_app_and_excludes_builder_metadata_from_release_assets(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            output = root / "electron/out-deb"
            output.mkdir(parents=True)
            filename = "tagcast-1.6.5-linux-amd64.deb"
            data = b"synthetic package"
            (output / filename).write_bytes(data)
            (output / "builder-effective-config.yaml").write_text("not an asset")
            with (patch.object(linux_deb, "ROOT", root),
                  patch.object(linux_deb.subprocess, "run") as run,
                  patch.object(linux_deb, "package_metadata") as metadata,
                  patch.object(linux_deb, "check_app") as check):
                linux_deb.build_deb(root / "checked-app", {"version": "1.6.5"}, "node", {})
            package = root / "dist/packages" / filename
            self.assertEqual(package.read_bytes(), data)
            self.assertEqual(set(p.name for p in package.parent.iterdir()), {filename, filename + ".sha256"})
            self.assertEqual(package.with_name(filename + ".sha256").read_text(),
                             f"{hashlib.sha256(data).hexdigest()}  {filename}\n")
            metadata.assert_called_once_with(package, "1.6.5")
            self.assertIn("--prepackaged", run.call_args_list[0].args[0])
            self.assertIn(str(root / "checked-app"), run.call_args_list[0].args[0])
            self.assertEqual(check.call_count, 1)
            self.assertEqual(check.call_args.args[0].parts[-3:], ("opt", "Tagcast", "Tagcast"))

    def test_failed_extracted_app_never_gets_a_checksum(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            package = root / "electron/out-deb/tagcast-1.6.5-linux-amd64.deb"
            package.parent.mkdir(parents=True)
            package.write_bytes(b"synthetic package")
            with (patch.object(linux_deb, "ROOT", root),
                  patch.object(linux_deb.subprocess, "run"),
                  patch.object(linux_deb, "package_metadata"),
                  patch.object(linux_deb, "check_app", side_effect=RuntimeError("sandbox failed"))):
                with self.assertRaisesRegex(RuntimeError, "sandbox failed"):
                    linux_deb.build_deb(root / "checked-app", {"version": "1.6.5"}, "node", {})
            self.assertEqual(list((root / "dist/packages").glob("*.sha256")), [])

    def test_installed_package_checks_launchers_and_requires_sandbox_before_report(self):
        for sandbox in (True, False):
            with self.subTest(sandbox=sandbox), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                package = root / "test.deb"
                package.write_bytes(b"test package")
                exe = root / "opt/Tagcast/Tagcast"
                exe.parent.mkdir(parents=True)
                exe.write_bytes(b"test executable")
                desktop = root / "usr/share/applications/Tagcast.desktop"
                desktop.parent.mkdir(parents=True)
                desktop.write_text("[Desktop Entry]\nExec=/opt/Tagcast/Tagcast %U\n")
                link = root / "usr/bin/Tagcast"
                link.parent.mkdir(parents=True)
                # Use a hard link so this test does not require Windows symlink privileges.
                link.hardlink_to(exe)
                reports = root / "build/reports"
                reports.mkdir(parents=True)
                (reports / "electron.json").write_text(json.dumps({
                    "sandbox": sandbox, "ok": True, "certificates": {"certifi": "test"}}))

                def installed_path(value):
                    path = Path(value)
                    return root / str(value).lstrip("/") if str(value).startswith(("/opt/", "/usr/")) else path

                with (patch.object(linux_deb, "ROOT", root),
                      patch.object(linux_deb, "Path", side_effect=installed_path),
                      patch.object(linux_deb, "package_metadata"),
                      patch.object(linux_deb.subprocess, "check_output", return_value="Tagcast 1.6.5\n"),
                      patch.object(linux_deb, "check_app") as check):
                    if sandbox:
                        linux_deb.check_installed(package, "1.6.5", "ubuntu-24.04")
                        result = json.loads((reports / "linux-deb.json").read_text())
                        self.assertTrue(result["installed_startup"])
                        self.assertEqual(result["sha256"], linux_deb.digest(package))
                        self.assertEqual(result["distribution"], "ubuntu-24.04")
                        check.assert_called_once_with(exe, "1.6.5")
                    else:
                        with self.assertRaisesRegex(ValueError, "sandboxed startup"):
                            linux_deb.check_installed(package, "1.6.5", "ubuntu-24.04")
                        self.assertFalse((reports / "linux-deb.json").exists())
