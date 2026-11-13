"""Installer checks must never touch a normal Windows installation implicitly."""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import windows_installer as installer  # noqa: E402


class WindowsInstallerTests(unittest.TestCase):
    def test_silent_install_path_follows_nsis_unquoted_final_argument_contract(self):
        command = installer.installer_command(r"C:\CI folder\setup.exe", r"C:\CI folder\Installed Tagcast")
        self.assertTrue(command.startswith('"C:\\CI folder\\setup.exe" /S '))
        self.assertTrue(command.endswith('/D=C:\\CI folder\\Installed Tagcast'))
        self.assertNotIn('"', command.split('/D=', 1)[1])
        for path in ('bad"path', 'bad\npath', 'bad\rpath'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                installer.installer_command('setup.exe', path)

    def test_installation_requires_explicitly_disposable_environment(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(installer.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'disposable Windows'):
                installer.build_installer(Path('app'), {'version': '1.8.0'}, 'node', {})
            run.assert_not_called()

    def test_trusted_publisher_is_checked_before_any_installer_can_run(self):
        self.assertFalse(installer.verify_signature(Path('setup.exe'), [], {}))
        for result in ('{"status":"NotSigned","publisher":"Trusted"}',
                       '{"status":"Valid","publisher":"Someone else"}'):
            with self.subTest(result=result), patch.object(installer.subprocess, 'check_output', return_value=result):
                with self.assertRaises(ValueError):
                    installer.verify_signature(Path('setup.exe'), ['Trusted'], {})
        with patch.object(installer.subprocess, 'check_output', return_value='{"status":"Valid","publisher":"Trusted"}'):
            self.assertTrue(installer.verify_signature(Path('setup.exe'), ['Trusted'], {}))
