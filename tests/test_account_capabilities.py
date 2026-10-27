"""Plan labels must not grant capabilities; unknown/false flags stay non-Premium."""
import tempfile
import unittest
from unittest.mock import Mock

from tagcast.client import Studio, account_view


class AccountCapabilityTests(unittest.TestCase):
    def test_account_display_and_playback_use_the_same_explicit_premium_flag(self):
        for plan in ("Free", "Premium Basic", "Premium Unlimited", "Unannounced plan"):
            for flag in (False, 0, "0", None, "false", "true", "Premium", {}, [], True, 1, "1"):
                with self.subTest(plan=plan, flag=flag), tempfile.TemporaryDirectory() as home:
                    expected = flag in (True, 1, "1")
                    data = {"user": {"id": "synthetic", "username": "synthetic", "premium": flag,
                                     "subscription": {"plan": {"name": plan}}}}
                    self.assertIs(account_view(data)["premium"], expected)
                    studio = Studio(home)
                    transport = Mock()
                    transport._jsonrequest.return_value = data
                    studio._remote_state(transport)
                    self.assertIs(studio.premium, expected)
                    studio._account_name(transport)
                    self.assertIs(studio.premium, expected)
                    self.assertEqual({call.args[0] for call in transport._jsonrequest.call_args_list}, {"status"})
