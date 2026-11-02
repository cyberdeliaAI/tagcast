"""Concurrent OAuth refresh without real credentials, networking or timing sleeps."""

import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from tagcast import client


def tokens(access="old-access", refresh="old-refresh", expired=False):
    return client.oauth.TokenSet(access, refresh, 0 if expired else time.time() + 3600)


def response(data=None, status=200):
    return Mock(status_code=status, ok=200 <= status < 400, json=lambda: data or {})


def start(operation):
    result = Future()

    def run():
        try:
            result.set_result(operation())
        except BaseException as error:
            result.set_exception(error)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, result


class TokenRefreshTests(unittest.TestCase):
    def transport(self, expired=False, callback=None):
        original = tokens(expired=expired)
        transport = client.StudioClient(access_token=original.access_token,
            refresh_token=original.refresh_token, client_id="test-client",
            token_refreshed_callback=callback)
        transport.token_set = original
        return transport

    def finish(self, workers):
        for thread, _ in workers:
            thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread, _ in workers), "A request deadlocked")
        return [result.result(timeout=1) for _, result in workers]

    def test_valid_api_requests_still_run_in_parallel_without_refresh(self):
        transport = self.transport()
        sending = threading.Barrier(3)

        def post(url, **kwargs):
            sending.wait(5)
            self.assertEqual(kwargs["headers"]["Authorization"], "Bearer old-access")
            return response({"result": True})

        with patch.object(client.requests, "post", side_effect=post), \
                patch.object(client.auth, "refresh_access_token") as refresh:
            workers = [start(lambda: transport._jsonrequest("status")) for _ in range(3)]
            self.assertEqual(self.finish(workers), [{"result": True}] * 3)
            refresh.assert_not_called()

    def test_expired_api_upload_and_stream_share_one_refresh_and_one_persistence_callback(self):
        saved, entered, release = [], threading.Event(), threading.Event()
        transport = self.transport(expired=True, callback=saved.append)
        renewed = tokens("new-access", "new-refresh")

        def refresh(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return renewed

        def post(url, **kwargs):
            self.assertEqual(kwargs["headers"]["Authorization"], "Bearer new-access")
            return response({"result": True, "artwork_id": 83})

        def get(url, **kwargs):
            self.assertEqual(kwargs["params"]["Signature"], "new-access")
            self.assertEqual(kwargs["headers"]["Range"], "bytes=10-19")
            return response(status=206)

        with patch.object(client.auth, "refresh_access_token", side_effect=refresh) as refresh_call, \
                patch.object(client.requests, "post", side_effect=post), \
                patch.object(client.requests, "get", side_effect=get):
            workers = [start(lambda: transport._jsonrequest("status")),
                       start(lambda: transport.upload_artwork(b"test", "cover.png", "image/png", "7")),
                       start(lambda: transport.open_stream("/audio", 9, "7", 123, "bytes=10-19"))]
            try:
                self.assertTrue(entered.wait(5))
            finally:
                release.set()
            results = self.finish(workers)
            self.assertEqual(results[1], 83)
            self.assertEqual(results[2].status_code, 206)
            refresh_call.assert_called_once_with("test-client", "old-refresh")
        self.assertEqual(saved, [renewed])
        self.assertIs(transport.token_set, renewed)
        self.assertEqual(transport._refresh_token, "new-refresh")

    def test_concurrent_authentication_failures_share_the_new_token(self):
        transport = self.transport()
        old_requests = threading.Barrier(4)
        observed = []

        def post(url, **kwargs):
            authorization = kwargs["headers"]["Authorization"]
            observed.append(authorization)
            if authorization == "Bearer old-access":
                old_requests.wait(5)
                return response({"authenticated": False}, status=401)
            return response({"result": True})

        with patch.object(client.requests, "post", side_effect=post), \
                patch.object(client.auth, "refresh_access_token", return_value=tokens("new-access", "new-refresh")) as refresh:
            workers = [start(lambda: transport._jsonrequest("status")) for _ in range(4)]
            self.assertEqual(self.finish(workers), [{"result": True}] * 4)
            refresh.assert_called_once_with("test-client", "old-refresh")
        self.assertEqual(observed.count("Bearer old-access"), 4)
        self.assertEqual(observed.count("Bearer new-access"), 4)

    def test_late_old_api_failure_reuses_refresh_even_when_access_token_value_stays_the_same(self):
        for access in ["new-access", "old-access"]:
            with self.subTest(access=access):
                transport = self.transport()
                entered, release = threading.Event(), threading.Event()
                observed = []

                def post(url, **kwargs):
                    observed.append(kwargs["headers"]["Authorization"])
                    if len(observed) == 1:
                        entered.set()
                        self.assertTrue(release.wait(5))
                        return response({"authenticated": False})
                    return response({"result": True})

                with patch.object(client.requests, "post", side_effect=post), \
                        patch.object(client.auth, "refresh_access_token", return_value=tokens(access, "new-refresh")) as refresh:
                    worker = start(lambda: transport._jsonrequest("create_artist", name="New artist"))
                    try:
                        self.assertTrue(entered.wait(5))
                        transport._refresh()
                    finally:
                        release.set()
                    self.assertEqual(self.finish([worker]), [{"result": True}])
                    refresh.assert_called_once_with("test-client", "old-refresh")
                self.assertEqual(observed, ["Bearer old-access", f"Bearer {access}"])

    def test_late_stream_or_upload_rejection_closes_old_response_and_retries_latest_token_once(self):
        for kind, status in [("stream", 401), ("stream", 403), ("upload", 401), ("upload", 403)]:
            with self.subTest(kind=kind, status=status):
                transport = self.transport()
                entered, release = threading.Event(), threading.Event()
                rejected, accepted = response(status=status), response({"artwork_id": 83}, status=206 if kind == "stream" else 200)
                seen = []

                def send(url, **kwargs):
                    seen.append(kwargs["params"]["Signature"] if kind == "stream" else kwargs["headers"]["Authorization"])
                    if len(seen) == 1:
                        entered.set()
                        self.assertTrue(release.wait(5))
                        return rejected
                    return accepted

                operation = (lambda: transport.open_stream("/audio", 9, "7", 123, "bytes=10-19")) if kind == "stream" \
                    else (lambda: transport.upload_artwork(b"test", "cover.png", "image/png", "7"))
                with patch.object(client.requests, "get" if kind == "stream" else "post", side_effect=send), \
                        patch.object(client.auth, "refresh_access_token", return_value=tokens("new-access", "new-refresh")) as refresh:
                    worker = start(operation)
                    try:
                        self.assertTrue(entered.wait(5))
                        transport._refresh()
                    finally:
                        release.set()
                    self.finish([worker])
                    refresh.assert_called_once_with("test-client", "old-refresh")
                rejected.close.assert_called_once_with()
                accepted.close.assert_not_called()
                self.assertEqual(seen, ["old-access", "new-access"] if kind == "stream"
                                 else ["Bearer old-access", "Bearer new-access"])

    def test_rejected_new_token_is_not_refreshed_or_retried_in_a_loop(self):
        transport = self.transport()
        with patch.object(client.requests, "post", return_value=response({"authenticated": False}, 401)) as post, \
                patch.object(client.auth, "refresh_access_token", return_value=tokens("new-access", "new-refresh")) as refresh:
            with self.assertRaises(client.NotConnected):
                transport._jsonrequest("create_artist", name="Example")
            self.assertEqual(post.call_count, 2)
            refresh.assert_called_once_with("test-client", "old-refresh")
            self.assertEqual([json.loads(c.kwargs["data"])["name"] for c in post.call_args_list], ["Example", "Example"])

    def test_failed_refresh_keeps_existing_credentials_and_releases_the_gate(self):
        for error in [client.oauth.OAuthError("Rejected"), requests.Timeout("Timed out"), KeyError("access_token"), ValueError("Bad response")]:
            with self.subTest(error=error):
                saved = []
                transport = self.transport(expired=True, callback=saved.append)
                previous = transport.token_set
                with patch.object(client.auth, "refresh_access_token", side_effect=[error, tokens("new-access", "new-refresh")]) as refresh, \
                        patch.object(client.requests, "post", return_value=response({"result": True})) as post:
                    with self.assertRaisesRegex(client.ConnectionUnavailable, "sign-in is retained"):
                        transport._jsonrequest("status")
                    post.assert_not_called()
                    self.assertIs(transport.token_set, previous)
                    self.assertEqual(saved, [])
                    self.assertEqual(transport._jsonrequest("status"), {"result": True})
                    self.assertEqual(refresh.call_count, 2)
                self.assertEqual(len(saved), 1)

    def test_waiting_requests_share_a_failed_refresh_instead_of_retrying_it(self):
        transport = self.transport(expired=True)
        entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
        waiter_lock, waiter_count = threading.Lock(), 0

        def fail(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            raise requests.Timeout("Private OAuth details must not reach the caller")

        with patch.object(client.auth, "refresh_access_token", side_effect=fail) as refresh, \
                patch.object(client.requests, "post") as post:
            workers = [start(lambda: transport._jsonrequest("status"))]
            try:
                self.assertTrue(entered.wait(5))
                pending = transport._refreshing
                original_result = pending.result

                def joined(*args, **kwargs):
                    nonlocal waiter_count
                    with waiter_lock:
                        waiter_count += 1
                        if waiter_count == 2:
                            waiting.set()
                    return original_result(*args, **kwargs)

                with patch.object(pending, "result", side_effect=joined):
                    workers.extend(start(lambda: transport._jsonrequest("status")) for _ in range(2))
                    try:
                        self.assertTrue(waiting.wait(5))
                    finally:
                        release.set()
                    for thread, result in workers:
                        thread.join(5)
                        self.assertFalse(thread.is_alive())
                        with self.assertRaises(client.ConnectionUnavailable) as caught:
                            result.result(timeout=1)
                        self.assertNotIn("Private OAuth", str(caught.exception))
            finally:
                release.set()
            refresh.assert_called_once_with("test-client", "old-refresh")
            post.assert_not_called()
        self.assertEqual(transport._access_token, "old-access")
        self.assertEqual(transport._refresh_token, "old-refresh")

    def test_two_clients_have_independent_refresh_gates(self):
        first, second = self.transport(expired=True), self.transport(expired=True)
        first._client_id, second._client_id = "client-one", "client-two"
        refreshing = threading.Barrier(2)

        def refresh(client_id, refresh_token):
            refreshing.wait(5)
            self.assertEqual(refresh_token, "old-refresh")
            return tokens(f"access-{client_id}", f"refresh-{client_id}")

        with patch.object(client.auth, "refresh_access_token", side_effect=refresh) as renew, \
                patch.object(client.requests, "post", return_value=response({"result": True})):
            workers = [start(lambda: first._jsonrequest("status")), start(lambda: second._jsonrequest("status"))]
            self.assertEqual(self.finish(workers), [{"result": True}] * 2)
            self.assertEqual(renew.call_count, 2)
        self.assertEqual(first._access_token, "access-client-one")
        self.assertEqual(second._access_token, "access-client-two")

    def test_api_upload_and_stream_auth_rejections_also_share_one_refresh(self):
        transport = self.transport()
        rejected_together = threading.Barrier(3)
        rejected = []

        def send(url, **kwargs):
            access = (kwargs.get("params") or {}).get("Signature") or kwargs["headers"]["Authorization"].removeprefix("Bearer ")
            if access == "old-access":
                rejected_together.wait(5)
                old = response({"authenticated": False}, 401)
                rejected.append(old)
                return old
            self.assertEqual(access, "new-access")
            return response({"result": True, "artwork_id": 83})

        with patch.object(client.auth, "refresh_access_token", return_value=tokens("new-access", "new-refresh")) as renew, \
                patch.object(client.requests, "post", side_effect=send), \
                patch.object(client.requests, "get", side_effect=send):
            workers = [start(lambda: transport._jsonrequest("status")),
                       start(lambda: transport.upload_artwork(b"test", "cover.png", "image/png", "7")),
                       start(lambda: transport.open_stream("/audio", 9, "7", 123))]
            self.finish(workers)
            renew.assert_called_once_with("test-client", "old-refresh")
        self.assertEqual(len(rejected), 3)
        self.assertEqual(sum(r.close.call_count for r in rejected), 2)

    def test_transport_retry_keeps_authentication_failure_bound_to_the_token_that_was_sent(self):
        transport = self.transport()
        seen = []

        def post(url, **kwargs):
            seen.append(kwargs["headers"]["Authorization"])
            if len(seen) == 1:
                transport._refresh()
                return response(status=429)
            if seen[-1] == "Bearer old-access":
                return response({"authenticated": False}, 401)
            return response({"result": True})

        with patch.object(client.requests, "post", side_effect=post), \
                patch.object(client.auth, "refresh_access_token", return_value=tokens("new-access", "new-refresh")) as renew, \
                patch.object(client.time, "sleep"):
            self.assertEqual(transport._jsonrequest("status"), {"result": True})
            renew.assert_called_once_with("test-client", "old-refresh")
        self.assertEqual(seen, ["Bearer old-access", "Bearer old-access", "Bearer new-access"])

    def test_missing_refresh_credentials_do_not_start_an_oauth_request(self):
        for field in ["_refresh_token", "_client_id"]:
            with self.subTest(field=field):
                transport = self.transport(expired=True)
                setattr(transport, field, None)
                with patch.object(client.auth, "refresh_access_token") as renew, \
                        patch.object(client.requests, "post", return_value=response({"authenticated": False}, 401)) as post:
                    with self.assertRaises(client.NotConnected):
                        transport._jsonrequest("status")
                    renew.assert_not_called()
                    self.assertEqual(post.call_count, 1)

    def test_refresh_does_not_hold_the_client_gate_while_waiting_for_the_studio_session_lock(self):
        with tempfile.TemporaryDirectory() as home:
            studio = client.Studio(home)
            studio._connect(tokens(expired=True))
            transport = studio.client
            entered, release, session_locked = threading.Event(), threading.Event(), threading.Event()
            renewed = tokens("new-access", "new-refresh")

            def refresh(*args):
                entered.set()
                self.assertTrue(release.wait(5))
                return renewed

            def holding_session():
                with studio.lock:
                    session_locked.set()
                    return transport._jsonrequest("status")

            with patch.object(client.auth, "refresh_access_token", side_effect=refresh) as refresh_call, \
                    patch.object(client.requests, "post", return_value=response({"result": True})):
                first = start(lambda: transport._jsonrequest("status"))
                workers = [first]
                try:
                    self.assertTrue(entered.wait(5))
                    workers.append(start(holding_session))
                    self.assertTrue(session_locked.wait(5))
                finally:
                    release.set()
                self.assertEqual(self.finish(workers), [{"result": True}] * 2)
                refresh_call.assert_called_once()
            self.assertEqual(studio._read("tokens.json")["token_set"], renewed.to_dict())

    def test_late_persistence_callback_cannot_overwrite_a_newer_refresh(self):
        with tempfile.TemporaryDirectory() as home:
            studio = client.Studio(home)
            studio._connect(tokens())
            transport = studio.client
            entered, release = threading.Event(), threading.Event()
            first, newest = tokens("access-1", "refresh-1"), tokens("access-2", "refresh-2")

            def save(value):
                if value is first:
                    entered.set()
                    self.assertTrue(release.wait(5))
                studio._save_tokens(value, transport)

            transport._token_refreshed_callback = save
            with patch.object(client.auth, "refresh_access_token", side_effect=[first, newest]) as refresh:
                worker = start(transport._refresh)
                try:
                    self.assertTrue(entered.wait(5))
                    transport._refresh()
                finally:
                    release.set()
                self.finish([worker])
                self.assertEqual(refresh.call_count, 2)
            self.assertEqual(studio._read("tokens.json")["token_set"], newest.to_dict())
            self.assertNotIn("access-1", Path(home, "tokens.json").read_text())

    def test_temporary_refresh_failure_preserves_studio_session_and_saved_tokens(self):
        failures = [requests.Timeout('private'), requests.ConnectionError('private'),
                    requests.exceptions.SSLError('private'), ValueError('bad JSON'),
                    client.oauth.OAuthError('HTTP 503')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as home:
                studio = client.Studio(home)
                studio._connect(tokens(expired=True))
                original, session = studio.client, studio.playback_session
                saved = Path(home, 'tokens.json').read_bytes()
                with patch.object(client.auth, 'refresh_access_token', side_effect=failure):
                    self.assertTrue(studio.status()['connected'])
                self.assertIs(studio.client, original)
                self.assertEqual(studio.playback_session, session)
                self.assertEqual(Path(home, 'tokens.json').read_bytes(), saved)
                with patch.object(client.auth, 'refresh_access_token', return_value=tokens('new', 'new-r')), \
                        patch.object(client.requests, 'post', return_value=response({'user': {'username': 'Recovered'}})):
                    self.assertEqual(studio.status()['account'], 'Recovered')

    def test_explicit_invalid_grant_disconnects_and_reports_disconnected(self):
        with tempfile.TemporaryDirectory() as home:
            studio = client.Studio(home)
            studio._connect(tokens(expired=True))
            with patch.object(client.auth, '_token_request', return_value=response({'error': 'invalid_grant'}, 400)):
                self.assertFalse(studio.status()['connected'])
            self.assertIsNone(studio.client)
            self.assertFalse(Path(home, 'tokens.json').exists())
