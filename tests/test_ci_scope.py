"""Documentation shortcuts must not skip code, releases or failed CI dependencies."""

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from ci_scope import (  # noqa: E402
    changed_paths,
    check_documentation,
    choose_scope,
    documentation_path,
)

ROOT = Path(__file__).resolve().parent.parent


class CIScopeTests(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Path(directory.name)

    def test_only_known_documentation_paths_are_lightweight(self):
        for name in ("README.md", "PRIVACY.md", "LICENSE", "docs/help.md",
                     "docs/screenshots/one.png", "docs/themes/amber.json",
                     ".github/release-notes/1.2.0.md"):
            with self.subTest(name=name):
                self.assertTrue(documentation_path(name))
        for name in ("AGENTS.md", "src/tagcast/static/help.js", "src/tagcast/static/help.svg",
                     "assets/icon.png", "electron/main.cjs", "pyproject.toml", "uv.lock",
                     "tests/test_ci_scope.py", "tools/ci_scope.py", ".github/workflows/tests.yml",
                     "docs/example.py", "docs/example.patch", "docs/data.json",
                     "docs/../src/app.md", "/docs/readme.md", "new-file.txt"):
            with self.subTest(name=name):
                self.assertFalse(documentation_path(name))

    def test_empty_mixed_unknown_and_unreadable_diffs_require_full_ci(self):
        for paths in ([], None, ["README.md", "src/tagcast/app.py"], ["new-file.txt"]):
            with self.subTest(paths=paths), patch("ci_scope.changed_paths", return_value=paths):
                self.assertTrue(choose_scope("pull_request", {}))
        with patch("ci_scope.changed_paths", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertTrue(choose_scope("pull_request", {}))

    def test_entire_pr_uses_merge_base_and_both_rename_paths(self):
        event = {"pull_request": {"base": {"sha": "a" * 40}, "head": {"sha": "b" * 40}}}
        with patch("ci_scope.git", side_effect=[b"ancestor\n", b"docs/help.md\0src/old.py\0"]) as git:
            self.assertEqual(changed_paths("pull_request", event), ["docs/help.md", "src/old.py"])
        self.assertEqual(git.call_args_list[0].args, ("merge-base", "a" * 40, "b" * 40))
        self.assertEqual(git.call_args_list[1].args,
                         ("diff", "--name-only", "--no-renames", "-z", "ancestor", "b" * 40))

    def test_full_push_compared_not_just_last_commit(self):
        event = {"before": "a" * 40, "after": "b" * 40}
        with patch("ci_scope.git", return_value=b"README.md\0src/earlier-change.py\0") as git:
            self.assertTrue(choose_scope("push", event))
        self.assertEqual(git.call_args.args[-2:], ("a" * 40, "b" * 40))

    def test_release_manual_missing_history_and_publish_commits_always_full(self):
        for event_name, event in (("release", {}), ("workflow_dispatch", {}),
                                  ("workflow_run", {}), ("pull_request", {}),
                                  ("push", {"before": "0" * 40, "after": "b" * 40}),
                                  ("push", {"head_commit": {"message": "Publish Tagcast 1.2.1"}})):
            with self.subTest(event=event_name), patch("ci_scope.git") as git:
                self.assertTrue(choose_scope(event_name, event))
                git.assert_not_called()

    def test_docs_only_validate_local_images_and_theme_json_without_network(self):
        root = self.fixture()
        (root / "docs/themes").mkdir(parents=True)
        (root / "docs/a space.png").write_bytes(b"image fixture")
        (root / "docs/themes/amber.json").write_text('{"name":"Amber"}')
        (root / "README.md").write_text("![local](docs/a%20space.png)\n![remote](https://example.com/x.png)")
        with patch("ci_scope.changed_paths", return_value=["README.md", "docs/themes/amber.json"]):
            self.assertFalse(choose_scope("pull_request", {}, root))
        (root / "docs/themes/amber.json").write_text("{")
        with self.assertRaises(json.JSONDecodeError):
            check_documentation(["docs/themes/amber.json"], root)

    def test_broken_image_and_deleted_asset_used_by_unchanged_readme_fail(self):
        root = self.fixture()
        (root / "README.md").write_text("![Missing](docs/missing.png)")
        for paths in (["README.md"], ["docs/missing.png"]):
            with self.subTest(paths=paths), self.assertRaisesRegex(ValueError, "Missing local image"):
                check_documentation(paths, root)

    def test_empty_files_and_symlinks_fail(self):
        root = self.fixture()
        (root / "README.md").write_text("")
        with self.assertRaisesRegex(ValueError, "nonempty"):
            check_documentation(["README.md"], root)
        if os.name != "nt":
            (root / "link.md").symlink_to("missing")
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                check_documentation(["link.md"], root)

    def test_existing_required_checks_report_scope_and_guard_all_expensive_steps(self):
        jobs = (("tests.yml", "tests"), ("tests.yml", "start-scripts"),
                ("tests.yml", "gapless-measured-media"), ("builds.yml", "build"))
        for workflow, job in jobs:
            source = (ROOT / ".github/workflows" / workflow).read_text()
            block = re.search(r"^  " + job + r":\n(.*?)(?=^  [a-z][a-z-]*:|\Z)",
                              source, re.M | re.S)[1]
            header, steps = block.split("    steps:\n", 1)
            self.assertIn("needs: scope", header)
            self.assertNotRegex(header, r"(?m)^    if:")
            if job != "gapless-measured-media":
                self.assertIn("&& matrix.os || 'ubuntu-latest'", header)
            entries = re.split(r"(?m)^      - ", steps)[1:]
            self.assertTrue(entries[0].startswith("name: Select verification for this target\n"))
            self.assertIn("CI_FULL: ${{ needs.scope.outputs.full }}", entries[0])
            script = textwrap.dedent(entries[0].split("        run: |\n", 1)[1])
            for value in ("true", "false", "", "unknown", "failure", "cancelled"):
                with patch.dict(os.environ, {"CI_FULL": value}), contextlib.redirect_stdout(io.StringIO()):
                    if value in {"true", "false"}:
                        exec(compile(script, workflow, "exec"), {})
                    else:
                        with self.assertRaises(SystemExit):
                            exec(compile(script, workflow, "exec"), {})
            for entry in entries[1:]:
                # No checkout, installation, tests, native build or artifact upload on docs.
                self.assertRegex(entry, r"(?m)^        if: (always\(\) && )?needs\.scope\.outputs\.full == 'true'")

    def test_final_gates_reject_failed_missing_and_skipped_dependencies(self):
        for filename, expected in (("tests.yml", ["scope", "tests", "start-scripts", "gapless-measured-media"]),
                                   ("builds.yml", ["scope", "build"])):
            source = (ROOT / ".github/workflows" / filename).read_text()
            gate = source.split("\n  verified:\n", 1)[1]
            self.assertIn("if: ${{ !cancelled() }}", gate)
            script = textwrap.dedent(gate.split("        run: |\n", 1)[1])
            good = {name: {"result": "success"} for name in expected}
            good["scope"]["outputs"] = {"full": "true"}
            variants = [good, {**good, "scope": {"result": "success", "outputs": {"full": "false"}}}]
            for jobs in variants:
                with patch.dict(os.environ, {"CI_NEEDS": json.dumps(jobs)}):
                    exec(compile(script, filename, "exec"), {})
            bad = [{}, {key: value for key, value in good.items() if key != expected[-1]},
                   {**good, "scope": {"result": "success", "outputs": {"full": ""}}}]
            for state in ("failure", "cancelled", "skipped"):
                for name in expected:
                    bad.append({**good, name: {**good[name], "result": state}})
            for jobs in bad:
                with self.subTest(workflow=filename, jobs=jobs), patch.dict(os.environ, {"CI_NEEDS": json.dumps(jobs)}):
                    with self.assertRaises(SystemExit):
                        exec(compile(script, filename, "exec"), {})
            release = re.search(r"^  release:\n(.*?)(?=^  [a-z][a-z-]*:|\Z)", source.split("jobs:\n", 1)[1], re.M | re.S)[1]
            self.assertIn("verified", release)

    def test_tagged_rebuild_requires_signing_and_cannot_clobber_assets(self):
        source = (ROOT / ".github/workflows/builds.yml").read_text()
        setting = next(line for line in source.splitlines() if "SIGN_MACOS: " in line)
        self.assertIn("inputs.sign_macos || inputs.tag != ''", setting)
        self.assertNotIn("--clobber", source)
        self.assertIn("hashFiles('tools/electron_signed.cjs')", source)


if __name__ == "__main__":
    unittest.main()
