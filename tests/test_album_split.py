"""Manual splits and metadata-only suggestions; no real account or music requests."""

import copy
import unittest
from unittest.mock import patch

from test_album_merge import MergeStudio

from tagcast.album_split import AlbumSplit, split_suggestions
from tagcast.library import ConflictError, Library, LibraryError


class SplitStudio(MergeStudio):
    def __init__(self):
        super().__init__()
        self.create_response = {"result": True, "album_id": 44}
        self.create_fail = self.create_lost = False
        self.after_create = None

    def _jsonrequest(self, mode, **body):
        if mode != "create_album":
            return super()._jsonrequest(mode, **body)
        self.writes.append((mode, copy.deepcopy(body)))
        assert body.pop("_retry") is False
        if self.create_fail:
            raise LibraryError("Lost creation response")
        self.raw["library"]["albums"]["44"] = {**body, "tracks": [], "rating": 0}
        if self.after_create:
            self.after_create()
        if self.create_lost:
            raise LibraryError("Accepted creation, reply lost")
        return self.create_response


class AlbumSplitTests(unittest.TestCase):
    def setUp(self):
        self.studio = SplitStudio()
        self.split = AlbumSplit(self.studio)

    def selection(self):
        album = Library(self.studio.raw).album_view(11)
        return self.split.selection({"session": "session", "album": {
            **{k: album[k] for k in ("id", "name", "artist", "year", "disc")},
            "tracks": [t["id"] for t in album["tracks"]]}})

    def review(self, tracks=None, **target):
        return self.split.review({"session": "session", "selection": self.selection()["selection"],
            "tracks": [101] if tracks is None else tracks,
            "target": {"name": "Fragments", "year": 1983, "disc": 1, **target}})

    def save(self, review=None):
        return self.split.save({"session": "session", "approved": True,
                               "review": (review or self.review())["review"]})

    def test_selection_and_review_never_create_or_move(self):
        before = copy.deepcopy(self.studio.raw)
        self.assertEqual(self.selection()["suggestions"], [])
        review = self.review()
        self.assertEqual([t["id"] for t in review["tracks"]], ["101"])
        self.assertEqual(review["remaining"], 1)
        self.assertEqual(review["target"]["artist"], "Various Artists")
        self.assertEqual(self.studio.writes, [])
        self.assertEqual(self.studio.raw, before)

    def test_native_create_then_move_only_selected_members_and_preserve_metadata(self):
        before = copy.deepcopy(self.studio.raw["library"])
        result = self.save()
        self.assertEqual(result["target"], "44")
        self.assertEqual(self.studio.writes, [
            ("create_album", {"_retry": False, "name": "Fragments", "year": 1983, "disc": 1, "artist_id": 0}),
            ("update_track", {"_retry": False, "tracks": [{"file_id": 101, "album_id": 44, "album": "Fragments"}]})])
        after = self.studio.raw["library"]
        for tid, track in before["tracks"].items():
            self.assertEqual(after["tracks"][tid], {**track, "album_id": 44} if tid == "101" else track)
        for table in ("tags", "playlists", "artists"):
            self.assertEqual(after[table], before[table])
        self.assertEqual(after["albums"]["11"]["year"], 1995)
        self.assertEqual(after["tracks"]["101"]["year"], 1994, "New album year does not retag tracks")
        self.assertEqual([r["status"] for r in self.studio.jobs[result["job"]]["results"]], ["saved"])

    def test_no_empty_source_or_invalid_selection(self):
        for tracks in ([], [101, 103], [101, 101], [201], [True], "101"):
            with self.subTest(tracks=tracks), self.assertRaises(LibraryError):
                self.review(tracks)
        self.assertEqual(self.studio.writes, [])

    def test_target_validation_and_existing_album_collision(self):
        for target in ({"name": ""}, {"name": "x" * 1001}, {"year": True}, {"year": 1700},
                       {"year": "1983"}, {"disc": 0}, {"disc": 10000}, {"disc": False},
                       {"name": "Fragments", "year": 1995, "disc": 1}):
            with self.subTest(target=target), self.assertRaises(LibraryError):
                self.review(**target)
        self.assertEqual(self.studio.writes, [])

    def test_snapshot_rejects_album_track_credit_and_membership_changes(self):
        mutations = [lambda d: d["albums"]["11"].update(year=2000),
                     lambda d: d["tracks"]["103"].update(year=2001),
                     lambda d: d["tracks"]["101"].update(title="Renamed"),
                     lambda d: d["artists"]["2"].update(name="Renamed"),
                     lambda d: d["tracks"]["103"].update(trashed=True),
                     lambda d: d["tracks"]["103"]["artists_additional"][0].update(phrase="Changed"),
                     lambda d: d["albums"]["11"]["tracks"].append(201)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp()
                review = self.review()
                mutate(self.studio.raw["library"])
                with self.assertRaises(LibraryError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])

    def test_stale_selection_cannot_reach_review(self):
        selection = self.selection()
        self.studio.raw["library"]["tracks"]["103"]["year"] = 2000
        with self.assertRaises(ConflictError):
            self.split.review({"session": "session", "selection": selection["selection"],
                "tracks": [101], "target": {"name": "Separate", "year": 1983, "disc": 1}})

    def test_changed_destination_collision_before_save_is_blocked(self):
        review = self.review()
        self.studio.raw["library"]["albums"]["55"] = {"name": "Fragments", "year": 1983, "disc": 1, "artist_id": 0, "tracks": []}
        with self.assertRaises(LibraryError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])

    def test_creation_uncertainty_missing_confirmation_or_existing_id_never_moves(self):
        for case in ("create_fail", "create_lost", "missing_id", "existing_id", "wrong_result", "boolean_id"):
            with self.subTest(case=case):
                self.setUp()
                review = self.review()
                if case.startswith("create_"):
                    setattr(self.studio, case, True)
                else:
                    self.studio.create_response = {"result": True, "album_id": 44}
                    self.studio.create_response.update({"missing_id": {"album_id": None},
                        "existing_id": {"album_id": 11}, "wrong_result": {"result": "true"},
                        "boolean_id": {"album_id": True}}[case])
                result = self.save(review)
                self.assertEqual(len(self.studio.writes), 1)
                self.assertTrue(result["error"])
                self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "not_sent")
                with self.assertRaises(ConflictError):
                    self.save(review)

    def test_recheck_after_creation_blocks_conflicts_and_populated_targets(self):
        for mutate in (lambda: self.studio.raw["library"]["tracks"]["103"].update(title="Changed"),
                       lambda: self.studio.raw["library"]["albums"]["44"].update(year=2000),
                       lambda: self.studio.raw["library"]["albums"]["44"]["tracks"].append(201),
                       lambda: setattr(self.studio, "playback_session", "replaced")):
            with self.subTest(mutate=mutate):
                self.setUp()
                self.studio.after_create = mutate
                result = self.save()
                self.assertEqual(len(self.studio.writes), 1)
                self.assertTrue(result["error"])

    def test_move_reply_loss_is_read_back_without_resending(self):
        self.studio.accept_then_fail = True
        result = self.save()
        self.assertTrue(result["error"])
        self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "saved")
        self.assertEqual(len(self.studio.writes), 2)

    def test_ignored_and_failed_moves_never_report_success(self):
        for flag in ("ignore", "fail"):
            with self.subTest(flag=flag):
                self.setUp()
                setattr(self.studio, flag, True)
                result = self.save()
                self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "unverified")
                self.assertEqual(len(self.studio.writes), 2)

    def test_readback_checks_remaining_tracks_and_destination_metadata(self):
        for mutate in (lambda: self.studio.raw["library"]["tracks"]["103"].update(year=2000),
                       lambda: self.studio.raw["library"]["albums"]["44"].update(disc=2),
                       lambda: self.studio.raw["library"]["albums"]["44"]["tracks"].append(201)):
            with self.subTest(mutate=mutate):
                self.setUp()
                self.studio.on_write = mutate
                result = self.save()
                self.assertEqual(self.studio.jobs[result["job"]]["results"][0]["status"], "unverified")

    def test_session_and_combine_changes_busy_and_unapproved_saves(self):
        for field in ("playback_session", "library_user", "client"):
            with self.subTest(field=field):
                self.setUp()
                review = self.review()
                setattr(self.studio, field, "changed")
                with self.assertRaises(LibraryError):
                    self.save(review)
                self.assertEqual(self.studio.writes, [])
        self.setUp()
        review = self.review()
        with self.studio.save_lock, self.assertRaises(LibraryError):
            self.save(review)
        with self.assertRaises(LibraryError):
            self.split.save({"session": "session", "review": review["review"]})
        self.studio.raw["combine_sets"] = True
        with self.assertRaises(LibraryError):
            self.save(review)
        self.assertEqual(self.studio.writes, [])

    def test_additional_album_credits_are_blocked_rather_than_lost(self):
        self.studio.raw["library"]["albums"]["11"]["artists_additional"] = [{"artist_id": 2, "type": "artist"}]
        with self.assertRaisesRegex(LibraryError, "additional album credits"):
            self.selection()

    def test_expiry_and_bounded_tokens(self):
        with patch("tagcast.album_merge.time.monotonic", return_value=100):
            review = self.review()
        with patch("tagcast.album_merge.time.monotonic", return_value=2000):
            with self.assertRaises(ConflictError):
                self.save(review)
        for _ in range(5):
            self.review()
        self.assertEqual(len(self.split.selections), 2)
        self.assertEqual(len(self.split.reviews), 2)

    def test_partial_moves_are_unverified(self):
        self.studio.raw["library"]["albums"]["11"]["tracks"].append(105)
        self.studio.raw["library"]["tracks"]["105"] = {**self.studio.raw["library"]["tracks"]["103"], "track": 5}
        self.studio.partial = True
        result = self.save(self.review([101, 103]))
        self.assertEqual({r["status"] for r in self.studio.jobs[result["job"]]["results"]}, {"unverified"})


class SplitSuggestionTests(unittest.TestCase):
    def rows(self):
        return [{"id": str(i * 10 + n), "track": n, "year": year, "uploaded_at": day}
                for i, (year, day) in enumerate([(1991, "2022-04-06"), (1983, "2026-11-07")]) for n in (1, 2, 3)]

    def test_two_uploads_years_and_restarting_numbers_propose_exact_groups_only(self):
        rows = self.rows()
        original = copy.deepcopy(rows)
        proposals = split_suggestions(rows)
        self.assertEqual([g["year"] for g in proposals], [1991, 1983])
        self.assertEqual(proposals[1]["tracks"], ["11", "12", "13"])
        self.assertEqual(rows, original, "Suggestions never alter selection or metadata")

    def test_year_alone_unknown_dates_mixed_years_and_repeated_positions_are_not_enough(self):
        mutations = [lambda r: r[0].update(uploaded_at=""), lambda r: r[0].update(year=0),
                     lambda r: r[0].update(year=1985), lambda r: r[0].update(track=2),
                     lambda r: [t.update(uploaded_at="2026-11-07") for t in r],
                     lambda r: [t.update(year=1983) for t in r],
                     lambda r: [t.update(track=t["track"] + 10) for t in r[3:]]]
        for mutate in mutations:
            rows = self.rows()
            mutate(rows)
            with self.subTest(mutate=mutate):
                self.assertEqual(split_suggestions(rows), [])
