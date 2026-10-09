"""License packaging must work when the Python installer omits Tcl/Tk notices."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from build_binary import copy_tk_license  # noqa: E402


class BuildLicenseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.library = self.root / "tcl8.6"
        self.library.mkdir()
        self.destination = self.root / "notices"

    def test_installed_notice_is_used_without_network(self):
        notice = b"Installed license notice"
        (self.library / "license.terms").write_bytes(notice)
        with patch("build_binary.requests.get") as request:
            copy_tk_license("Tcl", self.library, "8.6.13", self.destination)
        request.assert_not_called()
        self.assertEqual((self.destination / "license.terms").read_bytes(), notice)

    def test_missing_notice_uses_exact_upstream_release_and_records_origin(self):
        notice = b"This software is copyrighted by its authors.\n"
        response = MagicMock()
        response.__enter__.return_value.raw.read.return_value = notice
        with patch("build_binary.requests.get", return_value=response) as request:
            copy_tk_license("Tk", self.library, "8.6.12", self.destination)
        url = "https://raw.githubusercontent.com/tcltk/tk/core-8-6-12/license.terms"
        request.assert_called_once_with(url, timeout=45, stream=True)
        response.__enter__.return_value.raise_for_status.assert_called_once()
        self.assertEqual((self.destination / "license.terms").read_bytes(), notice)
        self.assertEqual((self.destination / "SOURCE.txt").read_text().strip(), url)

    def test_invalid_upstream_response_stops_the_build(self):
        response = MagicMock()
        response.__enter__.return_value.raw.read.return_value = b"<html>error</html>"
        with patch("build_binary.requests.get", return_value=response):
            with self.assertRaises(RuntimeError):
                copy_tk_license("Tcl", self.library, "8.6.13", self.destination)
        self.assertFalse((self.destination / "license.terms").exists())
