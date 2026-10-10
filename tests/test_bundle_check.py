"""Native asset checks must follow the page without hiding missing scripts."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from bundle_check import page_scripts  # noqa: E402


class BundleScriptTests(unittest.TestCase):
    def test_current_page_and_assets_match_in_load_order(self):
        static = Path(__file__).resolve().parent.parent / "src/tagcast/static"
        scripts = page_scripts((static / "index.html").read_text(encoding="utf-8"), static)
        self.assertEqual(scripts[-1], "navigation.js")
        self.assertIn("browse.js", scripts)
        self.assertIn("favourites.js", scripts)
        self.assertIn("updates.js", scripts)

    def test_missing_unused_and_duplicate_scripts_reject_the_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            static = Path(directory)
            (static / "app.js").touch()
            for page in ['', '<script src="missing.js"></script>',
                         '<script src="app.js"></script><script src="missing.js"></script>',
                         '<script src="app.js"></script><script src="app.js"></script>']:
                with self.subTest(page=page), self.assertRaises(RuntimeError):
                    page_scripts(page, static)
            (static / "unused.js").touch()
            with self.assertRaises(RuntimeError):
                page_scripts('<script src="app.js"></script>', static)
