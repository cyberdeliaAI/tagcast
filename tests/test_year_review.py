"""Year comparisons stay read-only, bounded and tied to the loaded account/session."""

import copy
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tagcast.library import ConflictError, Library, LibraryError, plan_save
from tagcast.year_review import YearReview, compare_years, stored_year


def library_data():
    raw = {"library": {"artists": {"1": {"name": "Artist"}}, "albums": {}, "tracks": {}}}
    for index, (year, years) in enumerate([(2004, [1958, 1958]), (1958, [2004]),
                                          (2004, [1958, 2004]), (1958, [0, 1958]),
                                          (0, [1958]), (0, [0]), (1958, [1958]), (1700, [1958])], 10):
        ids = [index * 100 + n for n in range(len(years))]
        raw["library"]["albums"][str(index)] = {"name": f"Album {index}", "artist_id": 1,
                                                "disc": 1, "year": year, "tracks": ids}
        for position, (track_id, track_year) in enumerate(zip(ids, years), 1):
            raw["library"]["tracks"][str(track_id)] = {"title": f"Track {position}", "album_id": index,
                                                       "artist_id": 1, "year": track_year, "track": position}
    return raw


def studio(raw=None):
    s = SimpleNamespace(lock=threading.RLock(), client=object(), library=Library(raw or library_data()),
                        library_user="owner", playback_session="session", combine_sets=False,
                        _current=Mock(side_effect=AssertionError("No remote requests")),
                        save=Mock(side_effect=AssertionError("No writes")))
    s.year_review = YearReview(s)
    s.library.combine_sets = False
    return s


class YearReviewTests(unittest.TestCase):
    def test_classification_excludes_consistent_and_keeps_missing_separate_without_writes(self):
        s = studio()
        report = s.year_review.analyse()
        self.assertEqual(report["stats"]["albums"], 8)
        self.assertEqual(report["stats"]["tracks"], 11)
        self.assertEqual(report["stats"]["different_tracks"], 4)
        self.assertEqual(report["stats"]["missing_track_years"], 1)
        self.assertEqual(report["stats"]["categories"], {"different": 2, "mixed": 1,
                         "missing-tracks": 1, "missing-album": 1, "unknown": 1, "consistent": 1, "invalid": 1})
        self.assertEqual(report["total"], 6)
        self.assertEqual(s.year_review.view(report["id"], category="unknown")["total"], 1)
        s._current.assert_not_called()
        s.save.assert_not_called()

    def test_choices_only_return_details_for_the_selected_album_and_preserve_every_value(self):
        raw = library_data()
        before = copy.deepcopy(raw)
        s = studio(raw)
        report = s.year_review.analyse()
        choice = s.year_review.choice({"id": report["id"], "album": "10", "direction": "album-to-tracks"})
        self.assertEqual((choice["year"], choice["direction"]), (2004, "album-to-tracks"))
        self.assertEqual([a["id"] for a in choice["albums"]], ["10"])
        self.assertEqual([t["year"] for t in choice["albums"][0]["tracks"]], [1958, 1958])
        choice = s.year_review.choice({"id": report["id"], "album": "11", "direction": "tracks-to-album", "year": 2004})
        self.assertEqual(choice["albums"][0]["year"], 1958)
        self.assertEqual(choice["year"], 2004)
        self.assertEqual(raw, before)
        s.save.assert_not_called()

    def test_no_automatic_minimum_majority_unknown_or_unrelated_year(self):
        s = studio()
        report = s.year_review.analyse()
        for direction in ("tracks-to-album", "tracks-to-album-and-tracks"):
            for value in (None, "1958", True, 0, 1900, 2051):
                with self.subTest(direction=direction, year=value), self.assertRaises(LibraryError):
                    s.year_review.choice({"id": report["id"], "album": "12", "direction": direction, "year": value})
        choice = s.year_review.choice({"id": report["id"], "album": "12", "direction": "tracks-to-album", "year": 1958})
        self.assertEqual(choice["year"], 1958)
        for aid in ("14", "15", "17", "9999"):
            with self.subTest(album=aid), self.assertRaises(LibraryError):
                s.year_review.choice({"id": report["id"], "album": aid, "direction": "album-to-tracks"})

    def test_library_account_session_combine_and_report_replacement_invalidate_old_results(self):
        for key, value in [("library", Library(library_data())), ("client", object()),
                           ("library_user", "other"), ("playback_session", "new"), ("combine_sets", True)]:
            with self.subTest(key=key):
                s = studio()
                report = s.year_review.analyse()
                setattr(s, key, value)
                with self.assertRaises(ConflictError):
                    s.year_review.view(report["id"])
        s = studio()
        first = s.year_review.analyse()
        second = s.year_review.analyse()
        self.assertNotEqual(first["id"], second["id"])
        with self.assertRaises(ConflictError):
            s.year_review.choice({"id": first["id"], "album": "10", "direction": "album-to-tracks"})
        self.assertEqual(s.year_review.view(second["id"])["id"], second["id"])

    def test_disconnected_or_unloaded_analysis_cannot_download_a_library(self):
        for key in ("client", "library"):
            s = studio()
            setattr(s, key, None)
            with self.subTest(key=key), self.assertRaises(LibraryError):
                s.year_review.analyse()
            s._current.assert_not_called()

    def test_search_category_and_pagination_are_bounded(self):
        raw = library_data()
        for i in range(20, 80):
            raw["library"]["albums"][str(i)] = {"name": f"Another {i}", "artist_id": 1, "year": 2004, "tracks": [i], "disc": 1}
            raw["library"]["tracks"][str(i)] = {"title": "Old", "album_id": i, "year": 1958}
        s = studio(raw)
        report = s.year_review.analyse()
        self.assertEqual(len(report["rows"]), 25)
        filtered = s.year_review.view(report["id"], "another 1958", "different", "25")
        self.assertEqual((filtered["total"], len(filtered["rows"]), filtered["offset"]), (60, 25, 25))
        for query, category, offset in [("x" * 201, "different", "0"), ("", "bad", "0"), ("", "mixed", "nan")]:
            with self.subTest(category=category), self.assertRaises(LibraryError):
                s.year_review.view(report["id"], query, category, offset)
        self.assertNotIn("tracks", filtered["rows"][0].get("albums", {}))

    def test_disc_grouping_matches_the_existing_editor_and_keeps_ambiguous_sets_separate(self):
        raw = library_data()
        a, b = raw["library"]["albums"]["10"], raw["library"]["albums"]["11"]
        b.update(name=a["name"], year=a["year"], disc=2)
        s = studio(raw)
        report = s.year_review.analyse()
        row = next(r for r in report["rows"] if r["id"] == "10")
        self.assertEqual((row["ids"], row["discs"], row["tracks"]), (["10", "11"], 2, 3))
        self.assertEqual(len(s.year_review.choice({"id": report["id"], "album": "10", "direction": "album-to-tracks"})["albums"]), 2)
        for patch in ({"disc": 1}, {"year": 2005}, {"artists_additional": [{"artist_id": 2, "type": "artist"}]}):
            changed = copy.deepcopy(raw)
            changed["library"]["albums"]["11"].update(patch)
            rows, _ = compare_years(Library(changed))
            self.assertEqual(next(r for r in rows if r["id"] == "10")["ids"], ["10"])

    def test_trash_is_ignored_and_large_choices_remain_read_only(self):
        raw = library_data()
        raw["library"]["tracks"]["1000"]["trashed"] = True
        raw["library"]["albums"]["11"]["trashed"] = True
        for i in range(500):
            raw["library"]["tracks"][str(50000 + i)] = {"title": "More", "album_id": 10, "year": 1958}
            raw["library"]["albums"]["10"]["tracks"].append(50000 + i)
        s = studio(raw)
        report = s.year_review.analyse()
        self.assertEqual(report["stats"]["albums"], 7)
        row = next(r for r in report["rows"] if r["id"] == "10")
        self.assertEqual(row["tracks"], 501)
        self.assertFalse(row["bounded"])
        with self.assertRaises(LibraryError):
            s.year_review.choice({"id": report["id"], "album": "10", "direction": "album-to-tracks"})

    def test_combined_views_allow_track_drafts_but_block_album_drafts(self):
        s = studio()
        s.combine_sets = s.library.combine_sets = True
        report = s.year_review.analyse()
        self.assertTrue(report["combine_sets"])
        self.assertEqual(s.year_review.choice({"id": report["id"], "album": "10", "direction": "album-to-tracks"})["year"], 2004)
        for direction in ("tracks-to-album", "tracks-to-album-and-tracks"):
            with self.subTest(direction=direction), self.assertRaisesRegex(LibraryError, "Combine Multi-Disc"):
                s.year_review.choice({"id": report["id"], "album": "10", "direction": direction, "year": 1958})

    def test_combined_year_choice_is_explicit_read_only_and_uses_normal_conflict_checks(self):
        s = studio()
        report = s.year_review.analyse()
        choice = s.year_review.choice({"id": report["id"], "album": "12",
                                       "direction": "tracks-to-album-and-tracks", "year": 1958})
        self.assertEqual(choice["direction"], "tracks-to-album-and-tracks")
        album = choice["albums"][0]
        self.assertEqual((album["year"], [t["year"] for t in album["tracks"]]), (2004, [1958, 2004]))
        changes = [{"kind": "album", "id": album["id"], "albumId": album["id"],
                    "label": album["name"], "fields": {"year": {"before": 2004, "after": 1958}}},
                   {"kind": "track", "id": "1201", "albumId": album["id"], "label": "Track 2",
                    "fields": {"year": {"before": 2004, "after": 1958}}}]
        self.assertEqual(len(plan_save(s.library, changes)["items"]), 2)
        for kind in ("albums", "tracks"):
            fresh = library_data()
            fresh["library"][kind]["12" if kind == "albums" else "1201"]["year"] = 1999
            with self.subTest(kind=kind), self.assertRaises(ConflictError):
                plan_save(Library(fresh), changes)
        s.save.assert_not_called()

    def test_native_numeric_strings_are_accepted_without_truncating_bad_years(self):
        for value in (None, "", 0, "0", "1958", 1958):
            with self.subTest(value=value):
                self.assertFalse(stored_year(value)[1])
        for value in (True, False, 1958.5, "1958.5", "unknown", 1700, 2051):
            with self.subTest(value=value):
                self.assertTrue(stored_year(value)[1])

    def test_year_drafts_use_the_existing_plan_and_detect_conflicting_before_values(self):
        s = studio()
        report = s.year_review.analyse()
        choice = s.year_review.choice({"id": report["id"], "album": "10", "direction": "album-to-tracks"})
        changes = [{"kind": "track", "id": t["id"], "albumId": "10", "label": t["title"],
                    "fields": {"year": {"before": t["year"], "after": choice["year"]}}} for t in choice["albums"][0]["tracks"]]
        plan = plan_save(s.library, changes)
        self.assertEqual(len(plan["items"]), 2)
        fresh = library_data()
        fresh["library"]["tracks"]["1000"]["year"] = 1999
        with self.assertRaises(ConflictError):
            plan_save(Library(fresh), changes)
