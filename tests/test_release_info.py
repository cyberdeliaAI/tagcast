"""A release must not carry a different page, package or lockfile version."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from release_info import main, release_info  # noqa: E402


class ReleaseInfoTests(unittest.TestCase):
    def fixture(self, version="0.10.1", display="0.10.1"):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "src/tagcast/static").mkdir(parents=True)
        (root / "pyproject.toml").write_text(f'[project]\nversion = "{version}"\n')
        (root / "src/tagcast/__init__.py").write_text(f'__version__ = "{version}"\n')
        (root / "src/tagcast/static/index.html").write_text(f'<span class="pill">{display}</span>')
        (root / "uv.lock").write_text(f'[[package]]\nname = "tagcast"\nversion = "{version}"\n')
        return root

    def test_stable_and_existing_beta_conventions(self):
        stable = release_info(self.fixture())
        self.assertEqual((stable["tag"], stable["prerelease"]), ("v0.10.1", False))
        beta = release_info(self.fixture("0.9.0b2", "0.9.0 beta 2"))
        self.assertEqual((beta["tag"], beta["notes"], beta["prerelease"]),
                         ("v0.9.0-beta.2", ".github/release-notes/0.9.0-beta.2.md", True))

    def test_mismatched_versions_block_release_preparation(self):
        for name in ("src/tagcast/__init__.py", "src/tagcast/static/index.html", "uv.lock"):
            with self.subTest(name=name):
                root = self.fixture()
                path = root / name
                path.write_text(path.read_text().replace("0.10.1", "0.10.0"))
                with self.assertRaises(ValueError):
                    release_info(root)

    def test_publication_rejects_wrong_branch_or_commit_without_calling_github(self):
        info = release_info(self.fixture())
        for branch, message in (("refs/heads/other", "Publish Tagcast 0.10.1"),
                                ("refs/heads/main", "Publish Tagcast 0.10.0")):
            with self.subTest(branch=branch, message=message), patch("release_info.release_info", return_value=info), patch.object(sys, "argv", ["release_info.py", "--publish"]), patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": branch, "GITHUB_SHA": "abc"}), patch("release_info.subprocess.check_output", return_value=message), patch("release_info.subprocess.run") as github:
                with self.assertRaises(ValueError):
                    main()
                github.assert_not_called()
