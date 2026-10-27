"""Album merges use the observed native payload, with no real-account requests."""

import copy
import threading
import unittest
from unittest.mock import patch

from tagcast.album_merge import AlbumMerge
from tagcast.library import ConflictError, Library, LibraryError


def data():
    tracks = {}
    for tid, album, position in [(101, 11, 1), (103, 11, 3), (102, 22, 2), (104, 22, 4), (201, 33, 1)]:
        tracks[str(tid)] = {"title": f"Song {tid}", "album_id": album, "artist_id": 1,
            "track": position, "year": 1994, "length": 180, "type": "audio/flac", "rating": 1,
            "genre": "Rock", "genres_additional": ["Pop"], "artwork_id": album,
            "artists_additional": [{"artist_id": 2, "type": "composer", "phrase": "Composed by"},
                                   {"artist_id": 2, "type": "publisher", "phrase": "Keep this"}],
            "userdata": [{"type": "lyrics", "value": "An invented test lyric"}],
            "uploaded_on": "2026-01-01", "uploaded_time": "11:12:13"}
    return {"combine_sets": False, "library": {"artists": {"1": {"name": "A"}, "2": {"name": "B"}},
        "albums": {str(i): {"name": "Fragments" if i != 33 else "Unselected", "artist_id": 0 if i == 11 else 2,
            "year": 1995, "disc": 1, "rating": 4 if i == 11 else 1,
            "tracks": [int(tid) for tid, track in tracks.items() if track["album_id"] == i]}
            for i in (11, 22, 33)}, "tracks": tracks,
        "tags": {"10": {"name": "Test", "tracks": [101, 104, 201], "archived": False}},
        "playlists": {"10": {"name": "Test playlist", "tracks": [101, 101, 201]}}}}


class MergeStudio:
    def __init__(self):
        self.raw = data()
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.playback_session = "session"
        self.library_user = "account"
        self.client = self
        self.downloads = 0
        self.writes = []
        self.jobs = {}
        self.fail = self.accept_then_fail = self.ignore = self.partial = False
        self.on_write = None

    def _require_client(self):
        if self.client is None:
            raise LibraryError("Disconnected")
        return self.client

    def _current(self, client, **kwargs):
        return Library(copy.deepcopy(self.raw)), "memory"

    def _jsonrequest(self, mode, **body):
        self.writes.append((mode, copy.deepcopy(body)))
        assert mode == "update_track" and body["_retry"] is False
        if self.fail:
            raise LibraryError("Lost reply")
        if not self.ignore:
            for index, row in enumerate(body["tracks"]):
                assert set(row) == {"file_id", "album_id", "album"}
                if self.partial and index:
                    break
                track = self.raw["library"]["tracks"][str(row["file_id"])]
                self.raw["library"]["albums"][str(track["album_id"])]["tracks"].remove(row["file_id"])
                self.raw["library"]["albums"][str(row["album_id"])]["tracks"].append(row["file_id"])
                track["album_id"] = row["album_id"]
        if self.on_write:
            self.on_write()
        if self.accept_then_fail:
            raise LibraryError("Accepted but reply lost")
        return {"result": True}

    def _check_later(self, client, written, check):
        self.jobs["merge-job"] = {"state": "done", "results": check(Library(copy.deepcopy(self.raw)))}
        return "merge-job"


class AlbumMergeTests(unittest.TestCase):
    def setUp(self):
        self.studio = MergeStudio()
        self.merge = AlbumMerge(self.studio)

    def selection(self, ids=(11, 22)):
        lib = Library(self.studio.raw)
        rows = []
        for album_id in ids:
            album = lib.album_view(album_id)
            rows.append({k: album[k] for k in ("id", "name", "artist", "year", "disc")}
                        | {"track_count": len(album["tracks"])})
        return self.merge.selection({"session": self.studio.playback_session, "albums": rows})

    def review(self, target=11):
        selection = self.selection()
        return self.merge.review({"selection": selection["selection"], "target": str(target), "session": "session"})

    def save(self, review=None, **kwargs):
        return self.merge.save({"session": "session", "approved": True,
                               "review": (review or self.review())["review"], **kwargs})

    def test_preview_and_review_are_read_only_and_have_exact_order(self):
        before = copy.deepcopy(self.studio.raw)
        review = self.review()
        self.assertEqual([t["track"] for t in review["tracks"]], [1, 2, 3, 4])
        self.assertEqual(review["target"]["artist"], "Various Artists")
        self.assertEqual(review["overlapping_numbers"], [])
        self.assertEqual(self.studio.raw, before)
        self.assertEqual(self.studio.writes, [])

    def test_native_move_preserves_every_track_field_and_other_memberships(self):
        before = copy.deepcopy(self.studio.raw)
        self.save()
        self.assertEqual(self.studio.writes, [("update_track", {"_retry": False, "tracks": [
            {"file_id": 102, "album_id": 11, "album": "Fragments"},
            {"file_id": 104, "album_id": 11, "album": "Fragments"}]})])
        for tid, track in before["library"]["tracks"].items():
            expected = {**track, "album_id": 11} if tid in ("102", "104") else track
            self.assertEqual(self.studio.raw["library"]["tracks"][tid], expected)
        for key in ("artists", "tags", "playlists"):
            self.assertEqual(self.studio.raw["library"][key], before["library"][key])
        self.assertEqual(self.studio.raw["library"]["albums"]["11"]["artist_id"], 0)
        self.assertEqual({r["status"] for r in self.studio.jobs["merge-job"]["results"]}, {"saved"})

    def test_destination_is_explicit_and_not_automatically_various_artists(self):
        self.save(self.review(22))
        lib = Library(self.studio.raw)
        self.assertEqual(set(lib.active_track_ids(22)), {101, 102, 103, 104})
        self.assertEqual(lib.album_view(22)["artist"], "B")

    def test_single_use_even_when_response_is_lost_or_partial(self):
        for flag in ("fail", "accept_then_fail", "partial", "ignore"):
            with self.subTest(flag=flag):
                self.setUp()
                review = self.review()
                setattr(self.studio, flag, True)
                if flag in ("fail", "accept_then_fail"):
                    with self.assertRaises(LibraryError):
                        self.save(review)
                else:
                    self.save(review)
                    self.assertEqual({r["status"] for r in self.studio.jobs["merge-job"]["results"]}, {"unverified"})
                with self.assertRaises(ConflictError):
                    self.save(review)
                self.assertEqual(len(self.studio.writes), 1)

    def test_new_tracks_metadata_and_album_changes_invalidate_approval(self):
        mutations = [lambda d: d["tracks"]["101"].update(title="Changed"),
                     lambda d: d["artists"]["1"].update(name="Renamed artist"),
                     lambda d: d["tracks"]["101"].update(track=8),
                     lambda d: d["tracks"]["101"]["artists_additional"][0].update(phrase="Changed"),
                     lambda d: d["albums"]["11"].update(artist_id=1),
                     lambda d: d["albums"]["11"].update(year=2000),
                     lambda d: d["albums"]["11"]["tracks"].pop(),
                     lambda d: d["albums"]["11"]["tracks"].append(201),
                     lambda d: d["tracks"]["101"].update(trashed=True),
                     lambda d: d["tracks"]["101"].update(album_id=22)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp()
                review = self.review()
                mutate(self.studio.raw["library"])
                with self.assertRaises(LibraryError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])

    def test_changes_between_selection_and_review_are_blocked(self):
        selection = self.selection()
        self.studio.raw["library"]["tracks"]["101"]["genre"] = "Changed"
        with self.assertRaises(ConflictError):
            self.merge.review({"session": "session", "selection": selection["selection"], "target": "11"})
        self.assertEqual(self.studio.writes, [])

    def test_session_account_and_client_replacement_are_blocked(self):
        for key, value in (("playback_session", "new"), ("library_user", "new"), ("client", object())):
            with self.subTest(key=key):
                self.setUp()
                review = self.review()
                setattr(self.studio, key, value)
                with self.assertRaises(ConflictError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])

    def test_combine_setting_and_distinct_disc_numbers_are_blocked(self):
        self.studio.raw["combine_sets"] = True
        with self.assertRaisesRegex(LibraryError, "Turn off"):
            self.selection()
        self.studio.raw["combine_sets"] = False
        self.studio.raw["library"]["albums"]["22"]["disc"] = 2
        with self.assertRaisesRegex(LibraryError, "Different discs"):
            self.selection()

    def test_entire_or_partial_displayed_multi_disc_sets_are_blocked(self):
        albums = self.studio.raw["library"]["albums"]
        albums["22"].update(artist_id=0, disc=2)
        for ids in ((11, 22), (11, 33)):
            with self.subTest(ids=ids), self.assertRaisesRegex(LibraryError, "Multi-disc"):
                self.selection(ids)

    def test_setting_change_after_review_is_blocked(self):
        review = self.review()
        self.studio.raw["combine_sets"] = True
        with self.assertRaises(LibraryError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])

    def test_overlapping_and_missing_numbers_are_preserved_only_after_acknowledgement(self):
        self.studio.raw["library"]["tracks"]["102"]["track"] = 1
        self.studio.raw["library"]["tracks"]["104"]["track"] = 0
        review = self.review()
        self.assertEqual(review["overlapping_numbers"], [1])
        self.assertEqual(review["missing_numbers"], 1)
        with self.assertRaisesRegex(LibraryError, "overlapping"):
            self.save(review)
        self.save(self.review(), keep_overlapping_numbers=True)
        self.assertEqual(self.studio.raw["library"]["tracks"]["102"]["track"], 1)
        self.assertEqual(self.studio.raw["library"]["tracks"]["104"]["track"], 0)

    def test_selection_boundaries_and_unselected_destination_are_rejected(self):
        for ids in ((11,), (11, 11), tuple(range(21))):
            with self.subTest(ids=ids):
                rows = [{"id": str(i)} for i in ids]
                with self.assertRaises(LibraryError):
                    self.merge.selection({"session": "session", "albums": rows})
        selection = self.selection()
        with self.assertRaises(LibraryError):
            self.merge.review({"session": "session", "selection": selection["selection"], "target": "33"})

    def test_snapshot_detects_stale_visible_album_identity(self):
        with self.assertRaises(ConflictError):
            self.merge.selection({"session": "session", "albums": [
                {"id": "11", "name": "Old name"}, {"id": "22", "name": "Fragments"}]})
        self.assertEqual(self.studio.writes, [])

    def test_readback_detects_metadata_corruption_and_new_destination_members(self):
        for mutate in (lambda: self.studio.raw["library"]["tracks"]["102"].update(title="Wrong"),
                       lambda: self.studio.raw["library"]["albums"]["11"]["tracks"].append(201),
                       lambda: self.studio.raw["library"]["albums"]["11"].update(artist_id=2),
                       lambda: setattr(self.studio, "playback_session", "new")):
            with self.subTest(mutate=mutate):
                self.setUp()
                self.studio.on_write = mutate
                self.save()
                self.assertTrue(any(r["status"] == "unverified" for r in self.studio.jobs["merge-job"]["results"]))

    def test_review_expiry_and_bounded_memory(self):
        with patch("tagcast.album_merge.time.monotonic", return_value=100):
            review = self.review()
        with patch("tagcast.album_merge.time.monotonic", return_value=1000):
            with self.assertRaises(ConflictError):
                self.save(review)
        for _ in range(5):
            self.review()
        self.assertEqual(len(self.merge.selections), 2)
        self.assertEqual(len(self.merge.reviews), 2)

    def test_no_write_without_approval_or_while_another_save_is_active(self):
        review = self.review()
        with self.assertRaises(LibraryError):
            self.merge.save({"session": "session", "review": review["review"]})
        with self.studio.save_lock, self.assertRaises(LibraryError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])

    def test_total_tracks_are_bounded_before_returning_details(self):
        for i in range(1000, 1500):
            self.studio.raw["library"]["tracks"][str(i)] = {"title": "Test", "album_id": 11}
            self.studio.raw["library"]["albums"]["11"]["tracks"].append(i)
        with self.assertRaisesRegex(LibraryError, "500 tracks"):
            self.selection()

    def test_ordinary_play_counts_do_not_invalidate_a_review(self):
        review = self.review()
        self.studio.raw["library"]["tracks"]["101"]["plays"] = 100
        self.save(review)
        self.assertEqual({r["status"] for r in self.studio.jobs["merge-job"]["results"]}, {"saved"})
