"""Loaded browsing is local; fresh writes/reloads and read-back retain their own gates."""

import copy
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from test_client import client, mock_ibroadcast

from tagcast.library import ConflictError, Library


class BrowsingSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.original = copy.deepcopy(mock_ibroadcast.STATE)
        mock_ibroadcast.STATE.update(busy=0, frozen=False, reject=set(), tags={
            10: {"name": "Weekend", "archived": False, "tracks": [900, 903]}})
        for track in mock_ibroadcast.STATE["tracks"].values():
            track["rating"] = 0
        self.home = tempfile.TemporaryDirectory()
        self.studio = client.Studio(self.home.name)
        self.studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, "refresh-1", time.time() + 3600), save=False)
        self.studio.load_library(refresh=True)

    def tearDown(self):
        with self.studio.cache_lock:
            pass
        self.home.cleanup()
        mock_ibroadcast.STATE.clear()
        mock_ibroadcast.STATE.update(self.original)

    def job(self, response):
        for _ in range(500):
            result = self.studio.job(response["job"])
            if result["state"] != "checking":
                return result
            time.sleep(.01)
        self.fail("Read-back did not finish")

    def read_all(self):
        studio = self.studio
        for kind in ("track-artists", "composers", "genres", "years", "decades", "tags"):
            for order in ("az", "za", "count"):
                result = studio.browse(kind, sort=order, limit="60")
                self.assertEqual(result, studio.library.browse(kind, sort=order, limit=60))
                studio.browse(kind, query="e", offset="60", limit="60", sort=order)
                if result["groups"]:
                    key = result["groups"][0]["key"]
                    self.assertEqual(studio.browse(kind, key=key), studio.library.browse(kind, key=key))
        studio.favourites(query="Kate", limit="100")
        studio.collections.album_favourites()
        studio.collections.artist_favourites()
        studio.tags.catalogue()
        studio.tags.catalogue(tag_id="10")
        studio.tags.selection(["72"])
        studio.tags.selection(["72"], track="900")
        studio.tags.selection(["72", "73"], multiple=True)

    def test_repeated_categories_filters_pages_favourites_and_tags_never_contact_upstream(self):
        library = self.studio.library
        with patch.object(self.studio.client, "_jsonrequest", side_effect=AssertionError("No upstream read")):
            self.read_all()
            self.read_all()
        self.assertIs(self.studio.library, library)

    def test_temporary_upstream_outage_does_not_prevent_loaded_browsing(self):
        with patch.object(self.studio.client, "_jsonrequest", side_effect=client.ApiError("Synthetic outage")) as request:
            self.read_all()
            request.assert_not_called()
            with self.assertRaises(client.ApiError):
                self.studio.load_library(refresh=True)
            self.read_all()
        self.assertEqual(request.call_count, 1, "Only explicit refresh may fail against the unavailable service")

    def test_explicit_refresh_replaces_indexes_even_at_an_unchanged_revision(self):
        studio = self.studio
        before = studio.library
        self.assertEqual(studio.tags.catalogue()["tags"][0]["name"], "Weekend")
        mock_ibroadcast.STATE["tags"][10]["name"] = "Changed remotely"
        mock_ibroadcast.STATE["tracks"][900]["rating"] = 5
        self.assertEqual(studio.tags.catalogue()["tags"][0]["name"], "Weekend")
        self.assertEqual(studio.favourites()["count"], 0)
        with patch.object(studio.client, "_jsonrequest", wraps=studio.client._jsonrequest) as request:
            studio.load_library(refresh=True)
        self.assertIn("status", [c.args[0] for c in request.call_args_list])
        self.assertIn("library", [c.args[0] for c in request.call_args_list])
        self.assertIsNot(studio.library, before)
        with patch.object(studio.client, "_jsonrequest", side_effect=AssertionError("No follow-up refresh")):
            self.assertEqual(studio.tags.catalogue()["tags"][0]["name"], "Changed remotely")
            self.assertEqual(studio.favourites()["count"], 1)

    def test_missing_snapshot_loads_once_and_old_tag_cache_upgrades_only_on_tag_use(self):
        studio = self.studio
        studio.library = None
        with patch.object(studio.client, "_jsonrequest", wraps=studio.client._jsonrequest) as request:
            studio.browse("genres")
            studio.browse("years")
        self.assertEqual([c.args[0] for c in request.call_args_list].count("status"), 1)
        data = studio.library.to_cache()
        data["library"].pop("tags")
        studio.library = Library(data)
        with patch.object(studio.client, "_jsonrequest", wraps=studio.client._jsonrequest) as request:
            studio.browse("genres")
            request.assert_not_called()
            studio.tags.selection(["72"])
            studio.tags.catalogue()
            studio.browse("tags")
        self.assertEqual([c.args[0] for c in request.call_args_list], ["status", "library"])

    def test_account_replacement_discards_old_snapshot_and_disconnection_cannot_expose_it(self):
        studio = self.studio
        old = studio.library
        studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, "new-refresh", time.time() + 3600), save=False)
        self.assertIsNone(studio.library)
        original = studio.client._jsonrequest
        def other_account(mode, **fields):
            result = original(mode, **fields)
            if mode == "status":
                result["user"]["id"] = "other-account"
            return result
        with patch.object(studio.client, "_jsonrequest", side_effect=other_account):
            studio.browse("genres")
        self.assertEqual(studio.library_user, "other-account")
        self.assertIsNot(studio.library, old)
        studio.client = None
        with self.assertRaises(client.ApiError):
            studio.browse("genres")
        with self.assertRaises(client.ApiError):
            studio.favourites()
        with self.assertRaises(client.ApiError):
            studio.tags.catalogue()

    def test_replaced_owner_or_snapshot_during_computation_never_returns_a_stale_response(self):
        studio = self.studio
        before = {name: getattr(studio, name) for name in ("client", "library_user", "playback_session", "library")}
        for field in before:
            for operation, method in ((lambda: studio.browse("genres"), "browse"),
                                      (studio.favourites, "favourites")):
                with self.subTest(field=field, method=method):
                    original = getattr(before["library"], method)
                    def replace(*args, **kwargs):
                        value = original(*args, **kwargs)
                        setattr(studio, field, object() if field in ("client", "library") else "replaced")
                        return value
                    with patch.object(before["library"], method, side_effect=replace):
                        with self.assertRaises(ConflictError):
                            operation()
                    for name, value in before.items():
                        setattr(studio, name, value)

    def test_tag_writes_still_refresh_and_reject_a_stale_cached_review(self):
        studio = self.studio
        tag = studio.tags.catalogue(tag_id="10")
        mock_ibroadcast.STATE["tags"][10]["name"] = "External edit"
        mock_ibroadcast.STATE["version"] += 1
        writes = len(mock_ibroadcast.STATE["writes"])
        with patch.object(studio.client, "_jsonrequest", wraps=studio.client._jsonrequest) as request:
            with self.assertRaises(ConflictError):
                studio.tags.save({"approved": True, "action": "rename", "id": "10", "before": tag["before"], "name": "My edit"})
        self.assertIn("status", [c.args[0] for c in request.call_args_list])
        self.assertEqual(len(mock_ibroadcast.STATE["writes"]), writes)

    def test_pending_completed_and_failed_readback_do_not_make_browsing_poll_or_confirm_writes(self):
        for uncertain, fail in ((False, False), (True, False), (True, True)):
            with self.subTest(uncertain=uncertain, failed_readback=fail):
                studio = self.studio
                mock_ibroadcast.STATE["tracks"][900]["rating"] = 0
                studio.load_library(refresh=True)
                before = studio.library
                written, entered, release = threading.Event(), threading.Event(), threading.Event()
                original = studio.client._jsonrequest
                sends = []
                def request(mode, **fields):
                    if mode == "ratetrack":
                        value = original(mode, **fields)
                        sends.append(mode)
                        written.set()
                        if uncertain:
                            raise client.UncertainWrite("Applied remotely, reply lost")
                        return value
                    if mode == "status" and written.is_set():
                        entered.set()
                        if not release.wait(5):
                            raise AssertionError("Read-back was not released")
                        if fail:
                            raise client.ApiError("Synthetic read-back outage")
                    return original(mode, **fields)
                with patch.object(studio.client, "_jsonrequest", side_effect=request):
                    response = studio.favourite({"track_id": "900", "before": 0, "rating": 5})
                    try:
                        self.assertTrue(entered.wait(3))
                        self.assertEqual(studio.job(response["job"])["state"], "checking")
                        self.assertEqual(studio.favourites()["count"], 0)
                        self.assertIs(studio.library, before)
                        studio.tags.catalogue()
                    finally:
                        release.set()
                    result = self.job(response)
                self.assertEqual(sends, ["ratetrack"])
                self.assertEqual(result["state"], "error" if fail else "done")
                with patch.object(studio.client, "_jsonrequest", side_effect=AssertionError("No browse polling")):
                    self.assertEqual(studio.favourites()["count"], 0 if fail else 1)
                if fail:
                    self.assertIs(studio.library, before)
                    self.assertNotIn("results", result)
                else:
                    self.assertIsNot(studio.library, before)
                    self.assertEqual(result["results"][0]["status"], "saved")
