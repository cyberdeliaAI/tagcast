"""Lost replies must not replay a mutation over a newer external edit. No live account."""

import copy
import json
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import requests
from test_library import change, raw

from tagcast import client
from tagcast.library import ConflictError, Library


def response(status=200, data=None):
    return Mock(status_code=status, ok=200 <= status < 300,
                json=Mock(return_value={"result": True} if data is None else data))


class WriteReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.remote = raw()
        self.transport = client.StudioClient(access_token="synthetic-test-token")
        self.studio = client.Studio(self.home.name)
        self.studio.client = self.transport
        self.studio._current = Mock(side_effect=lambda *_a, **_k:
                                    (Library(copy.deepcopy(self.remote)), 0))
        self.checked = []

        def check_later(_owner, _written, check, **_kwargs):
            self.checked = check(Library(copy.deepcopy(self.remote)))
            return "synthetic-readback"

        self.studio._check_later = check_later

    def test_all_mutations_send_once_for_timeout_lost_reply_http_and_invalid_json(self):
        modes = ["update_album", "update_track", "ratetrack", "ratealbum", "rateartist",
                 "set_artwork", "set_artist_artwork", "updateplaylist", "appendplaylist",
                 "create_artist", "createplaylist", "createplaylistfolder", "deleteplaylist",
                 "createtag", "updatetag", "deletetags", "tagtracks", "trash", "playqueue_token",
                 "future_unknown_mode", "status"]
        invalid = response()
        invalid.json.side_effect = ValueError("truncated JSON")
        faults = [requests.ReadTimeout(), requests.ConnectionError(), response(429),
                  response(500), response(503), invalid, response(data=[]), response(data={})]
        for mode in modes:
            for fault in faults:
                with self.subTest(mode=mode, fault=repr(fault)), \
                        patch.object(client.requests, "post", side_effect=[fault]) as post, \
                        patch.object(client.time, "sleep"):
                    kwargs = {"history": []} if mode == "status" else {}
                    with self.assertRaises(client.UncertainWrite):
                        self.transport._jsonrequest(mode, **kwargs)
                    self.assertEqual(post.call_count, 1)

    def test_safe_reads_keep_bounded_retries(self):
        for mode in client.RETRY_READS:
            for fault in [requests.ReadTimeout(), requests.ConnectionError(), response(429), response(503)]:
                with self.subTest(mode=mode, fault=repr(fault)), \
                        patch.object(client.requests, "post", side_effect=[fault, fault, response()]) as post, \
                        patch.object(client.time, "sleep"):
                    self.assertEqual(self.transport._jsonrequest(mode), {"result": True})
                    self.assertEqual(post.call_count, 3)

    def test_explicit_auth_rejection_may_refresh_and_send_once_with_new_token(self):
        self.transport._refresh_token = "synthetic-refresh"
        self.transport._client_id = "synthetic-client"
        with patch.object(client.requests, "post", side_effect=[
                response(401, {"authenticated": False}), response()]) as post, \
                patch.object(self.transport, "_refresh_or_fail") as refresh:
            self.transport._jsonrequest("update_track", tracks=[])
        refresh.assert_called_once()
        self.assertEqual(post.call_count, 2)

    def save_after_lost_reply(self, external=False):
        def post(_url, **kwargs):
            row = json.loads(kwargs["data"])["tracks"][0]
            self.remote["library"]["tracks"]["100"][0] = row["title"]
            if external:
                self.remote["library"]["tracks"]["100"][0] = "new external edit"
            raise requests.ReadTimeout("response lost after applying")

        changes = [change("track", 100, 10, title=("Song One", "reviewed title")),
                   change("track", 101, 10, title=("Song Two", "different patch"))]
        with patch.object(client.requests, "post", side_effect=post) as sending:
            result = self.studio._save(self.transport, changes)
        self.assertEqual(sending.call_count, 1)
        self.assertEqual([r["status"] for r in result["results"]], ["sent", "not_sent"])
        self.assertEqual(self.checked[1]["status"], "not_sent")
        self.assertIn("could not be confirmed", result["error"])
        return changes

    def test_lost_reply_is_confirmed_by_readback_and_stops_remaining_batch(self):
        self.save_after_lost_reply()
        self.assertEqual(self.checked[0]["status"], "saved")

    def test_external_edit_is_not_overwritten_and_old_review_cannot_be_reused(self):
        changes = self.save_after_lost_reply(external=True)
        self.assertEqual(self.checked[0]["status"], "unverified")
        self.assertEqual(self.remote["library"]["tracks"]["100"][0], "new external edit")
        with patch.object(client.requests, "post") as sending, self.assertRaises(ConflictError):
            self.studio._save(self.transport, changes)
        sending.assert_not_called()

    def test_definite_rejection_stays_failed_and_does_not_send_following_patch(self):
        with patch.object(client.requests, "post", return_value=response(400, {"message": "Rejected"})) as post:
            result = self.studio._save(self.transport, [
                change("track", 100, 10, title=("Song One", "A")),
                change("track", 101, 10, title=("Song Two", "B"))])
        self.assertEqual(post.call_count, 1)
        self.assertEqual([r["status"] for r in result["results"]], ["failed", "not_sent"])

    def test_uncertain_artwork_assignment_is_read_back_instead_of_replayed(self):
        body = {"target": "album", "id": "10", "before": {"tracks": {"100": 0, "101": 77}},
                "source": {"artwork_id": 99}}

        def lost(_url, **kwargs):
            for track_id in json.loads(kwargs["data"])["tracks"]:
                self.remote["library"]["tracks"][str(track_id)][7] = 99
            raise requests.ConnectionError()

        with patch.object(client.requests, "post", side_effect=lost) as post:
            result = self.studio.change_artwork(body)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(self.checked[0]["status"], "saved")
        self.assertIn("no automatic retry", result["note"])

    def test_uncertain_track_rating_is_checked(self):
        with patch.object(client.requests, "post", side_effect=requests.ReadTimeout()) as post:
            self.studio.favourite({"track_id": "100", "before": 0, "rating": 5})
        self.assertEqual(post.call_count, 1)
        self.assertEqual(self.checked[0]["status"], "unverified")

    def test_failed_readback_does_not_claim_saved(self):
        self.studio._current.side_effect = client.ApiError("synthetic read timeout")
        job = client.Studio._check_later(self.studio, self.transport, 0, lambda _after: [])
        for _ in range(100):
            result = self.studio.job(job)
            if result["state"] != "checking":
                break
            time.sleep(.01)
        self.assertEqual(result["state"], "error")
        self.assertNotIn("Saved", result["error"])
        self.assertIn("could not be verified", result["error"])
