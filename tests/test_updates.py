"""Update checks use fake GitHub responses and never contact a real account or GitHub."""

import json
import threading
import unittest
from copy import deepcopy
from unittest.mock import Mock, patch

import requests

from tagcast import updates


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.store = {}
        self.version = patch.object(updates, "__version__", "0.10.1")
        self.version.start()
        self.addCleanup(self.version.stop)
        self.clock = patch.object(updates.time, "time", return_value=100000)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.factory = patch.object(updates.requests, "Session")
        self.session_factory = self.factory.start()
        self.addCleanup(self.factory.stop)
        self.session = self.session_factory.return_value.__enter__.return_value
        self.response = self.session.get.return_value.__enter__.return_value
        self.reply()

    def checker(self, write=None):
        def save(name, data):
            self.store[name] = deepcopy(data)
        return updates.UpdateChecker(lambda name: deepcopy(self.store.get(name)), write or save)

    def reply(self, version="0.11.0", **extra):
        self.response.status_code = 200
        self.response.iter_content.return_value = [json.dumps({"tag_name": f"v{version}", "name": "Tagcast release", **extra}).encode()]

    def test_public_check_compares_versions_and_constructs_its_own_link(self):
        self.reply(html_url="https://evil.example/", body="private data", token="secret")
        result = self.checker().check()
        self.assertTrue(result["available"])
        self.assertEqual(result["url"], updates.RELEASE_PAGE + "0.11.0")
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("private data", json.dumps(result))
        self.assertFalse(self.session.trust_env)
        args, kwargs = self.session.get.call_args
        self.assertEqual(args, (updates.RELEASE_API,))
        self.assertEqual(kwargs["timeout"], (3.05, 7))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(set(kwargs["headers"]), {"Accept", "User-Agent"})

    def test_numeric_comparison_and_beta_to_final_do_not_suggest_downgrades(self):
        for current, latest, available in [("0.9.9", "0.10.0", True), ("0.11.0", "0.10.1", False),
                                            ("0.10.1", "0.10.1", False), ("0.11.0b2", "0.11.0", True),
                                            ("0.12.0b1", "0.11.0", False)]:
            with self.subTest(current=current, latest=latest), patch.object(updates, "__version__", current):
                self.reply(latest)
                self.assertEqual(self.checker().check(manual=True)["available"], available)

    def test_daily_cache_survives_a_restart_and_expires_after_24_hours(self):
        self.checker().check()
        self.checker().check()
        self.session.get.assert_called_once()
        with patch.object(updates.time, "time", return_value=100000 + updates.CHECK_INTERVAL):
            self.checker().check()
        self.assertEqual(self.session.get.call_count, 2)

    def test_disabled_automatic_checks_still_allow_an_explicit_manual_check(self):
        checker = self.checker()
        self.assertEqual(checker.check(enabled=False)["state"], "disabled")
        self.session.get.assert_not_called()
        self.assertTrue(checker.check(enabled=False, manual=True)["available"])
        self.assertFalse(checker.check(enabled=False)["auto_updates"])
        self.session.get.assert_called_once()

    def test_failures_are_throttled_and_preserve_the_last_successful_release(self):
        checker = self.checker()
        checker.check()
        self.session.get.side_effect = requests.Timeout("secret exception context")
        result = checker.check(manual=True)
        self.assertEqual(result["state"], "error")
        self.assertTrue(result["available"])
        self.assertEqual(result["checked_at"], 100000)
        self.assertNotIn("secret", json.dumps(result))
        self.checker().check()
        self.assertEqual(self.session.get.call_count, 2, "Restarting after a failure does not keep retrying")

    def test_invalid_responses_never_claim_to_be_up_to_date_or_offer_untrusted_links(self):
        for extra in [{"draft": True}, {"prerelease": True}, {"tag_name": "v0.11.0-beta.1"},
                      {"tag_name": "0.11.0"}, {"tag_name": "v1.2.3/../../elsewhere"}]:
            with self.subTest(extra=extra):
                self.store.clear()
                self.reply(**extra)
                result = self.checker().check()
                self.assertEqual(result["state"], "error")
                self.assertFalse(result["available"])
                self.assertEqual(result["url"], "")
        for status in (302, 403, 404, 429, 500):
            with self.subTest(status=status):
                self.response.status_code = status
                self.assertEqual(self.checker().check(manual=True)["state"], "error")

    def test_corrupt_or_oversized_json_is_a_nonfatal_check_failure(self):
        for body in (b"not json", b"[]", b"x" * (updates.MAX_RESPONSE + 1)):
            with self.subTest(length=len(body)):
                self.response.iter_content.return_value = [body]
                self.assertEqual(self.checker().check(manual=True)["state"], "error")

    def test_invalid_or_future_cache_values_do_not_prevent_a_fresh_check(self):
        self.store["updates.json"] = {"attempted_at": 999999, "checked_at": "bad",
                                      "latest": {"version": "javascript:bad", "url": "https://evil.example/"}}
        result = self.checker().check()
        self.assertEqual(result["latest"], "0.11.0")
        self.session.get.assert_called_once()

    def test_a_readonly_settings_folder_does_not_break_the_check(self):
        checker = self.checker(write=Mock(side_effect=OSError("read only")))
        self.assertTrue(checker.check()["available"])
        checker.check()
        self.session.get.assert_called_once()

    def test_concurrent_automatic_checks_make_only_one_request(self):
        checker = self.checker()
        results = []
        threads = [threading.Thread(target=lambda: results.append(checker.check())) for _ in range(4)]
        for worker in threads:
            worker.start()
        for worker in threads:
            worker.join(timeout=2)
        self.assertEqual(len(results), 4)
        self.session.get.assert_called_once()


if __name__ == "__main__":
    unittest.main()
