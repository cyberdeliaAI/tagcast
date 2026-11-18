"""Creation receipts survive incomplete writes; no cleanup, replay or real account."""

import copy
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests
from test_library import change, raw
from test_write_reliability import response

from tagcast import client
from tagcast.errors import error_payload
from tagcast.library import Library


class WriteEffectsTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.studio = client.Studio(self.home.name)
        self.transport = client.StudioClient(access_token="synthetic-test-token")
        self.studio.client = self.transport
        self.remote = raw()
        self.studio._current = Mock(side_effect=lambda *_a, **_k:
                                    (Library(copy.deepcopy(self.remote)), 0))
        self.checked = []

        def check_later(_owner, _written, check, **_kwargs):
            self.checked = check(Library(copy.deepcopy(self.remote)))
            return "synthetic-readback"

        self.studio._check_later = check_later

    def test_prior_artist_receipts_survive_later_creation_failure_without_sending_metadata(self):
        changes = [change("track", 100, 10, artist=("Artist A", "New A")),
                   change("track", 101, 10, artist=("Artist A", "New B"))]
        for failure in (client.ApiError("Refused"), client.UncertainWrite("Lost reply")):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(self.transport, "_jsonrequest", side_effect=[
                        {"result": True, "artist_id": 99}, failure]) as send:
                with self.assertRaises(client.ApiError) as caught:
                    self.studio.save(changes)
                effects = error_payload(caught.exception)["write_effects"]
                self.assertEqual(effects.get("artists_created"), 1)
                self.assertEqual(effects.get("artist_uncertain", False),
                                 isinstance(failure, client.UncertainWrite))
                self.assertEqual([c.args[0] for c in send.call_args_list],
                                 ["create_artist", "create_artist"])
                self.assertFalse(self.studio.save_lock.locked())
                self.assertEqual(self.checked, [])

    def test_missing_artist_receipt_never_claims_creation_or_sends_metadata(self):
        with patch.object(self.transport, "_jsonrequest", return_value={"result": True}) as send:
            with self.assertRaises(client.ApiError) as caught:
                self.studio.save([change("track", 100, 10, artist=("Artist A", "New A"))])
        self.assertEqual(send.call_count, 1)
        self.assertEqual(error_payload(caught.exception)["write_effects"], {"artist_uncertain": True})

    def test_artist_creation_is_retained_when_metadata_assignment_is_refused(self):
        with patch.object(self.transport, "_jsonrequest", side_effect=[
                {"result": True, "artist_id": 99}, client.ApiError("Refused")]) as send:
            result = self.studio.save([change("track", 100, 10, artist=("Artist A", "New A"))])
        self.assertEqual(result["write_effects"], {"artists_created": 1})
        self.assertEqual(result["created_artists"], ["New A"])
        self.assertEqual(self.checked[0]["status"], "failed")
        self.assertEqual([c.args[0] for c in send.call_args_list], ["create_artist", "update_track"])

    def artwork_body(self, source):
        return {"target": "album", "id": "10", "before": {"tracks": {"100": 0, "101": 77}},
                "source": source}

    def test_confirmed_upload_then_refused_assignment_retains_receipt_without_cleanup(self):
        for target in ("album", "artist"):
            with self.subTest(target=target), patch.object(self.studio, "_image", return_value=99), \
                    patch.object(self.transport, "_jsonrequest", side_effect=client.ApiError("Refused")) as send:
                body = self.artwork_body({"data": "synthetic"})
                if target == "artist":
                    body.update(target="artist", id="4", before={"artwork_id": 0})
                with self.assertRaises(client.ApiError) as caught:
                    self.studio.change_artwork(body)
                self.assertEqual(error_payload(caught.exception)["write_effects"], {"artwork_created": "99"})
                self.assertEqual(send.call_count, 1)
                self.assertEqual(send.call_args.args[0], "set_artwork" if target == "album" else "set_artist_artwork")
                self.assertFalse(self.studio.save_lock.locked())

    def test_reusing_artwork_does_not_claim_a_new_upload(self):
        with patch.object(self.transport, "_jsonrequest", side_effect=client.ApiError("Refused")):
            with self.assertRaises(client.ApiError) as caught:
                self.studio.change_artwork(self.artwork_body({"artwork_id": 99}))
        self.assertNotIn("write_effects", error_payload(caught.exception))

    def test_uncertain_assignment_keeps_receipt_and_existing_readback(self):
        for applied in (False, True):
            def assign(*_a, **_k):
                if applied:
                    for tid in ("100", "101"):
                        self.remote["library"]["tracks"][tid][7] = 99
                raise client.UncertainWrite("Lost reply")

            with self.subTest(applied=applied), patch.object(self.studio, "_image", return_value=99), \
                    patch.object(self.transport, "_jsonrequest", side_effect=assign) as send:
                result = self.studio.change_artwork(self.artwork_body({"data": "synthetic"}))
                self.assertEqual(result["write_effects"], {"artwork_created": "99"})
                self.assertEqual(self.checked[0]["status"], "saved" if applied else "unverified")
                self.assertEqual(send.call_count, 1)

    def test_upload_ambiguity_is_reported_without_inventing_an_id_or_retrying(self):
        for fault in (requests.ReadTimeout(), response(503), response(data={"result": True}), response(data=[])):
            with self.subTest(fault=repr(fault)), patch.object(client.requests, "post", side_effect=[fault]) as send:
                with self.assertRaises(client.ApiError) as caught:
                    self.transport.upload_artwork(b"synthetic", "cover.png", "image/png", 1)
                self.assertEqual(error_payload(caught.exception)["write_effects"], {"artwork_uncertain": True})
                self.assertEqual(send.call_count, 1)

    def test_rejected_upload_does_not_claim_an_artwork_may_exist(self):
        with patch.object(client.requests, "post", return_value=response(400, {"result": False})) as send:
            with self.assertRaises(client.ApiError) as caught:
                self.transport.upload_artwork(b"synthetic", "cover.png", "image/png", 1)
        self.assertNotIn("write_effects", error_payload(caught.exception))
        self.assertEqual(send.call_count, 1)

    def test_error_diagnostics_only_include_fixed_bounded_fields(self):
        failure = client.ApiError("Failed")
        failure.write_effects = {"artists_created": 2, "artist_uncertain": True,
            "artwork_created": "99", "album_created": "<script>", "album_uncertain": "yes",
            "token": "synthetic-secret", "provider_body": {"anything": 1}}
        self.assertEqual(error_payload(failure), {"error": "Failed", "write_effects": {
            "artists_created": 2, "artist_uncertain": True, "artwork_created": "99"}})
        for value in (True, -1, 0, 1_000_001, "2", [], None):
            failure.write_effects = {"artists_created": value}
            self.assertNotIn("write_effects", error_payload(failure))
