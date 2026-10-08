"""OAuth HTTP controls without contacting a real account."""

import unittest
from unittest.mock import Mock, patch

import requests

from tagcast import auth


def response(data, ok=True):
    return Mock(ok=ok, status_code=200 if ok else 400, json=lambda: data)


TOKENS = {"access_token": "test-access", "refresh_token": "test-refresh", "expires_in": 3600}


class AuthTests(unittest.TestCase):
    def test_all_oauth_requests_have_a_timeout(self):
        with patch.object(auth.requests, "get", return_value=response({"device_code": "test"})) as get, \
                patch.object(auth.requests, "post", return_value=response(TOKENS)) as post, \
                patch.object(auth.time, "sleep"):
            auth.device_code_request("test", ["user.library:read"])
            auth.poll_for_token("test", "device", 1)
            auth.exchange_auth_code("test", "code", "http://localhost/callback", "verifier")
            auth.refresh_access_token("test", "refresh")
            auth.revoke_token("test", "refresh")
        self.assertEqual(len(get.call_args_list) + len(post.call_args_list), 5)
        for call in [*get.call_args_list, *post.call_args_list]:
            self.assertEqual(call.kwargs["timeout"], 45)
        self.assertEqual(post.call_args_list[1].kwargs["data"]["code_verifier"], "verifier")

    def test_polling_keeps_pending_and_slow_down_semantics(self):
        replies = [response({"error": "authorization_pending"}, False),
                   response({"error": "slow_down"}, False), response(TOKENS)]
        with patch.object(auth.requests, "post", side_effect=replies), \
                patch.object(auth.time, "sleep") as sleep:
            tokens = auth.poll_for_token("test", "device", 2)
        self.assertEqual(tokens.refresh_token, "test-refresh")
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [2, 2, 7])

    def test_polling_stops_on_denial_expiry_or_timeout(self):
        for error in ("access_denied", "expired_token"):
            with self.subTest(error=error), patch.object(auth.time, "sleep"), \
                    patch.object(auth.requests, "post", return_value=response({"error": error}, False)):
                with self.assertRaises(auth.oauth.OAuthError):
                    auth.poll_for_token("test", "device", 1)
        with patch.object(auth.time, "sleep"), \
                patch.object(auth.requests, "post", side_effect=requests.Timeout):
            with self.assertRaises(requests.Timeout):
                auth.poll_for_token("test", "device", 1)

    def test_refresh_preserves_the_refresh_token_when_not_rotated(self):
        with patch.object(auth.requests, "post", return_value=response(
                {"access_token": "new", "expires_in": 3600})):
            tokens = auth.refresh_access_token("test", "existing-refresh")
        self.assertEqual(tokens.refresh_token, "existing-refresh")

    def test_failed_requests_do_not_return_tokens(self):
        with patch.object(auth.requests, "post", return_value=response({}, False)):
            for call in (lambda: auth.refresh_access_token("test", "refresh"),
                         lambda: auth.exchange_auth_code("test", "code", "uri", "verifier"),
                         lambda: auth.revoke_token("test", "refresh")):
                with self.assertRaises(auth.oauth.OAuthError):
                    call()
