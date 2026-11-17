"""Review-bound empty_trash with synthetic recoverable files; no live account."""

import copy
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests
from test_album_merge import MergeStudio

from tagcast import client
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.trash_emptying import MAX_TRASH_REVIEW, TrashEmptying


class EmptyStudio(MergeStudio):
    def __init__(self):
        super().__init__()
        self.raw["library"]["tracks"]["101"]["trashed"] = True
        self.raw["library"]["tracks"]["103"]["trashed"] = True
        self.recoverable = {}
        self.reads = []
        self.before_read = None
        self.lost = self.refused = False

    def _current(self, owner, **kwargs):
        self.reads.append(kwargs)
        if self.before_read:
            self.before_read()
        return super()._current(owner, **kwargs)

    def _jsonrequest(self, mode, **body):
        self.writes.append((mode, copy.deepcopy(body)))
        assert mode == "empty_trash" and body["_retry"] is False
        if self.refused:
            raise client.ApiError("Refused")
        if not self.ignore:
            for index, tid in enumerate(body["tracks"]):
                if self.partial and index:
                    break
                assert self.raw["library"]["tracks"][str(tid)]["trashed"] is True
                self.recoverable[tid] = self.raw["library"]["tracks"].pop(str(tid))
        if self.on_write:
            self.on_write()
        if self.lost:
            raise client.UncertainWrite("Lost reply")
        return {"result": True}


class TrashEmptyingTests(unittest.TestCase):
    def setUp(self):
        self.studio = EmptyStudio()
        self.feature = TrashEmptying(self.studio)

    def review(self):
        return self.feature.review({"session": "session"})

    def save(self, review):
        return self.feature.save({"session": "session", "review": review["review"],
                                  "approved": True, "acknowledged": True})

    def test_review_checks_current_trash_and_pages_without_any_writes(self):
        for tid in range(1000, 1060):
            self.studio.raw["library"]["tracks"][str(tid)] = {
                "title": f"Trashed {tid}", "artist_id": 1, "album_id": 11, "trashed": True}
        review = self.review()
        self.assertEqual(review["count"], 62)
        self.assertEqual(len(review["tracks"]), 50)
        self.assertEqual(self.studio.reads, [{}])
        page = self.feature.page({"session": "session", "review": review["review"], "offset": 50})
        self.assertEqual(len(page["tracks"]), 12)
        self.assertEqual(page["digest"], review["digest"])
        self.assertEqual(self.studio.reads, [{}])
        self.assertEqual(self.studio.writes, [])
        self.assertEqual(set(review), {"review", "count", "digest", "offset", "limit", "tracks"})

    def test_explicit_approval_and_acknowledgement_are_both_required(self):
        review = self.review()
        for field in ("approved", "acknowledged"):
            for invalid in (None, False, "true", 1):
                with self.subTest(field=field, invalid=invalid), self.assertRaises(LibraryError):
                    self.feature.save({"session": "session", "review": review["review"],
                                       "approved": True, "acknowledged": True, field: invalid})
        self.assertEqual(self.studio.writes, [])
        self.save(review)

    def test_empty_only_exact_trashed_ids_preserves_active_tracks_and_is_single_use(self):
        before = copy.deepcopy(self.studio.raw["library"]["tracks"])
        review = self.review()
        result = self.save(review)
        self.assertEqual(self.studio.writes, [("empty_trash", {"_retry": False, "tracks": [101, 103]})])
        self.assertEqual(self.studio.reads, [{}, {}])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["digest"], review["digest"])
        self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "saved")
        self.assertEqual(self.studio.recoverable, {tid: before[str(tid)] for tid in (101, 103)})
        self.assertEqual(self.studio.raw["library"]["tracks"],
                         {tid: row for tid, row in before.items() if tid not in ("101", "103")})
        with self.assertRaises(ConflictError):
            self.save(review)
        self.assertEqual(len(self.studio.writes), 1)

    def test_membership_and_display_identity_changes_block_and_consume_the_review(self):
        mutations = [lambda t: t["104"].update(trashed=True),
                     lambda t: t["101"].update(trashed=False),
                     lambda t: t.pop("101"), lambda t: t["101"].update(title="Changed"),
                     lambda t: t["101"].update(album_id=22), lambda t: t["101"].update(artist_id=2)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp()
                review = self.review()
                mutate(self.studio.raw["library"]["tracks"])
                with self.assertRaisesRegex(ConflictError, "trash changed"):
                    self.save(review)
                with self.assertRaises(ConflictError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])

    def test_both_combine_modes_work_but_a_changed_mode_blocks_the_review(self):
        for combined in (False, True):
            with self.subTest(combined=combined):
                self.setUp()
                self.studio.raw["combine_sets"] = combined
                self.save(self.review())
                self.assertEqual(len(self.studio.writes), 1)
        self.setUp()
        review = self.review()
        self.studio.raw["combine_sets"] = True
        with self.assertRaises(ConflictError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])

    def test_unrelated_active_metadata_changes_do_not_expand_the_request(self):
        review = self.review()
        self.studio.raw["library"]["tracks"]["201"]["title"] = "External edit"
        self.save(review)
        self.assertEqual(self.studio.raw["library"]["tracks"]["201"]["title"], "External edit")
        self.assertEqual(self.studio.writes[0][1]["tracks"], [101, 103])

    def test_changed_account_session_client_or_expiry_cannot_use_a_review(self):
        for field in ("client", "library_user", "playback_session"):
            with self.subTest(field=field):
                self.setUp()
                review = self.review()
                setattr(self.studio, field, "different")
                with self.assertRaises(LibraryError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])
        self.setUp()
        with patch("tagcast.album_merge.time.monotonic", return_value=100):
            review = self.review()
        with patch("tagcast.album_merge.time.monotonic", return_value=2000), self.assertRaises(ConflictError):
            self.save(review)

    def test_account_replacement_during_review_does_not_return_old_data(self):
        self.studio.before_read = lambda: setattr(self.studio, "playback_session", "replaced")
        with self.assertRaises(ConflictError):
            self.review()
        self.assertEqual(self.feature.reviews, {})
        self.assertEqual(self.studio.writes, [])

    def test_busy_lane_does_not_consume_review_or_send_and_tokens_are_bounded(self):
        review = self.review()
        with self.studio.save_lock, self.assertRaises(LibraryError):
            self.save(review)
        self.save(review)
        self.setUp()
        for _ in range(4):
            self.review()
        self.assertEqual(len(self.feature.reviews), 2)

    def test_empty_trash_needs_no_write_and_invalid_paging_is_read_only(self):
        for track in self.studio.raw["library"]["tracks"].values():
            track["trashed"] = False
        review = self.review()
        self.assertEqual(review["count"], 0)
        self.assertEqual(review["review"], "")
        with self.assertRaises(ConflictError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])
        self.setUp()
        review = self.review()
        for offset in (-1, 1, 50, "0", True):
            with self.subTest(offset=offset), self.assertRaises(LibraryError):
                self.feature.page({"session": "session", "review": review["review"], "offset": offset})

    def test_ambiguous_results_are_read_back_without_retry_and_refusals_are_terminal(self):
        for flag, status in (("lost", "saved"), ("ignore", "unverified"), ("partial", "unverified")):
            with self.subTest(flag=flag):
                self.setUp()
                setattr(self.studio, flag, True)
                result = self.save(self.review())
                self.assertEqual(len(self.studio.writes), 1)
                self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], status)
        self.setUp()
        self.studio.refused = True
        review = self.review()
        with self.assertRaises(client.ApiError):
            self.save(review)
        with self.assertRaises(ConflictError):
            self.save(review)
        self.assertEqual(len(self.studio.writes), 1)
        self.assertFalse(self.studio.save_lock.locked())
        self.assertEqual(self.studio.jobs, {})

    def test_restored_tracks_do_not_count_as_confirmed_and_fresh_signed_paths_do_not_conflict(self):
        review = self.review()
        for row in self.studio.raw["library"]["tracks"].values():
            row["file"] = "/different-signed-path"
        self.save(review)
        self.setUp()
        review = self.review()
        self.studio.ignore = True
        self.studio.on_write = lambda: self.studio.raw["library"]["tracks"]["101"].update(trashed=False)
        result = self.save(review)
        self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "unverified")
        self.assertEqual(len(self.studio.writes), 1)

    def test_bounds_and_unreadable_flags_fail_closed(self):
        for flag in ("0", "1", [], {}, 2):
            with self.subTest(flag=flag):
                self.setUp()
                self.studio.raw["library"]["tracks"]["101"]["trashed"] = flag
                with self.assertRaises(LibraryError):
                    self.review()
                self.assertEqual(self.studio.writes, [])
        self.setUp()
        sample = self.studio.raw["library"]["tracks"]["101"]
        self.studio.raw["library"]["tracks"] = {str(i): dict(sample) for i in range(1, MAX_TRASH_REVIEW + 2)}
        with self.assertRaisesRegex(LibraryError, "review limit"):
            self.review()
        self.assertEqual(self.studio.writes, [])

    def test_disconnect_and_reconnect_release_review_tokens(self):
        for replace in (False, True):
            with self.subTest(replace=replace), tempfile.TemporaryDirectory() as home:
                studio = client.Studio(home)
                studio.client = client.StudioClient(access_token="synthetic")
                studio.library_user, studio.playback_session = "account", "session"
                studio._current = Mock(return_value=(Library(copy.deepcopy(self.studio.raw)), 0))
                review = studio.trash_emptying.review({"session": "session"})
                self.assertTrue(studio.trash_emptying.reviews)
                if replace:
                    studio._connect(client.oauth.TokenSet("next", "refresh", 9999999999), save=False)
                else:
                    studio._disconnect()
                self.assertEqual(studio.trash_emptying.reviews, {})
                with self.assertRaises(ConflictError):
                    studio.trash_emptying._get(studio.trash_emptying.reviews, review["review"])

    def test_real_transport_sends_the_native_payload_once_after_a_lost_reply(self):
        with tempfile.TemporaryDirectory() as home:
            studio = client.Studio(home)
            transport = client.StudioClient(access_token="synthetic")
            studio.client = transport
            studio.library_user, studio.playback_session = "account", "session"
            raw = copy.deepcopy(self.studio.raw)
            studio._current = Mock(side_effect=lambda *_a, **_k: (Library(copy.deepcopy(raw)), 0))
            checked = []
            def later(_owner, _written, check):
                checked.extend(check(Library(copy.deepcopy(raw))))
                return "job"
            studio._check_later = later
            review = studio.trash_emptying.review({"session": "session"})
            def post(_url, **kwargs):
                body = json.loads(kwargs["data"])
                self.assertEqual(body["mode"], "empty_trash")
                self.assertEqual(body["tracks"], [101, 103])
                for tid in body["tracks"]:
                    raw["library"]["tracks"].pop(str(tid))
                raise requests.ReadTimeout()
            with patch.object(client.requests, "post", side_effect=post) as send:
                studio.trash_emptying.save({"session": "session", "review": review["review"],
                                           "approved": True, "acknowledged": True})
            self.assertEqual(send.call_count, 1)
            self.assertEqual(checked[0]["status"], "saved")
