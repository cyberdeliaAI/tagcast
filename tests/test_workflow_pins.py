"""Remote workflow actions stay immutable and receive reviewable update proposals."""

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def action_references(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "uses":
                yield child
            else:
                yield from action_references(child)
    elif isinstance(value, list):
        for child in value:
            yield from action_references(child)


class WorkflowPinTests(unittest.TestCase):
    def test_all_remote_actions_and_reusable_workflows_use_full_commit_ids(self):
        references = []
        for path in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for reference in action_references(yaml.safe_load(path.read_text())):
                references.append(reference)
                with self.subTest(workflow=path.name, reference=reference):
                    if reference.startswith("./"):
                        self.assertNotIn("@", reference)
                        self.assertTrue((ROOT / reference).exists())
                    else:
                        self.assertRegex(reference, r"^[^\s@]+@[0-9a-f]{40}$")
        self.assertTrue(references)
        self.assertTrue(any(not ref.startswith("./") for ref in references))

    def test_action_updates_are_proposed_weekly_for_review(self):
        config = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
        self.assertEqual(config["version"], 2)
        updates = [row for row in config["updates"]
                   if row["package-ecosystem"] == "github-actions"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["directory"], "/")
        self.assertEqual(updates[0]["schedule"]["interval"], "weekly")
        self.assertGreater(updates[0]["open-pull-requests-limit"], 0)
