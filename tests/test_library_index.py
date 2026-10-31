"""Snapshot-local summary reuse must never become a stale write-verification cache."""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from unittest.mock import patch

from test_library import raw

from tagcast.library import Library


class AlbumIndexTests(unittest.TestCase):
    def test_repeated_loads_and_editor_names_share_one_summary_pass(self):
        library = Library(raw())
        with patch.object(library, "album_summary", wraps=library.album_summary) as summary:
            first = library.album_index()
            self.assertEqual(library.editor_names(), {"genres": ["Jazz", "Pop", "Rock"],
                                                       "composers": []})
            self.assertEqual(library.album_index(), first)
            self.assertEqual(summary.call_count, 3)

    def test_callers_cannot_mutate_cached_summaries_or_other_responses(self):
        library = Library(raw())
        expected = library.album_index()
        response = library.album_index()

        def assert_owned(left, right):
            if isinstance(left, (dict, list)):
                self.assertIsNot(left, right)
                for key in left if isinstance(left, dict) else range(len(left)):
                    assert_owned(left[key], right[key])

        # Check the entire schema, including future nested fields, rather than
        # assuming the currently known mutable summary fields are exhaustive.
        assert_owned(expected, response)
        response[0]["name"] = "Changed response"
        response[0]["genres"].clear()
        response[0]["upload_dates"].append("2099-01-01")
        response[0]["album_artists"][0]["name"] = "Changed artist"
        response[0]["album_artists"].append({"id": "999"})
        response.pop()
        response.append({"id": "999"})
        self.assertEqual(library.album_index(), expected)
        names = library.editor_names()
        names["genres"].clear()
        self.assertEqual(library.editor_names()["genres"], ["Jazz", "Pop", "Rock"])

    def test_editor_names_can_build_the_shared_index_first(self):
        library = Library(raw())
        with patch.object(library, "album_summary", wraps=library.album_summary) as summary:
            library.editor_names()
            self.assertEqual(len(library.album_index()), 3)
            self.assertEqual(summary.call_count, 3)

    def test_empty_library_is_cached_too(self):
        data = raw()
        data["library"]["albums"] = {"map": data["library"]["albums"]["map"]}
        library = Library(data)
        with patch.object(library, "album_ids", wraps=library.album_ids) as ids:
            self.assertEqual(library.album_index(), [])
            self.assertEqual(library.album_index(), [])
            self.assertEqual(library.editor_names(), {"genres": [], "composers": []})
            self.assertEqual(ids.call_count, 1)

    def test_failed_pass_is_not_published_and_can_be_retried(self):
        library = Library(raw())
        original = library.album_summary
        failed = False

        def summary(album_id, names=None):
            nonlocal failed
            if album_id == 11 and not failed:
                failed = True
                names["genres"].add("Incomplete pass")
                raise ValueError("Interrupted summary build")
            return original(album_id, names)

        with patch.object(library, "album_summary", side_effect=summary) as build:
            with self.assertRaisesRegex(ValueError, "Interrupted"):
                library.album_index()
            self.assertEqual(library.editor_names()["genres"], ["Jazz", "Pop", "Rock"])
            self.assertEqual(len(library.album_index()), 3)
            self.assertEqual(build.call_count, 5)

    def test_concurrent_loads_share_a_complete_pass_without_blocking_other_libraries(self):
        library = Library(raw())
        original = library.album_summary
        entered, release = threading.Event(), threading.Event()

        def summary(album_id, names=None):
            if album_id == 10:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("Test did not release the summary builder")
            return original(album_id, names)

        with patch.object(library, "album_summary", side_effect=summary) as build, \
                ThreadPoolExecutor(max_workers=3) as pool:
            first = pool.submit(library.album_index)
            try:
                self.assertTrue(entered.wait(5))
                names = pool.submit(library.editor_names)
                second = pool.submit(library.album_index)
                self.assertFalse(names.done())
                self.assertFalse(second.done())
                # No global cache or lock: another account/snapshot can still load.
                expected = Library(raw()).album_index()
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5), expected)
            self.assertEqual(second.result(timeout=5), expected)
            self.assertEqual(names.result(timeout=5)["genres"], ["Jazz", "Pop", "Rock"])
            self.assertEqual(build.call_count, 3)

    def test_new_snapshot_at_same_revision_recomputes_all_summary_fields(self):
        data = raw()
        data["status"] = {"lastmodified": "unchanged-second"}
        old = Library(data)
        before = old.album_index()
        new_data = deepcopy(data)
        albums, tracks, artists = (new_data["library"][key]
                                   for key in ("albums", "tracks", "artists"))
        albums["map"].update({"rating": 5, "artists_additional": 6})
        albums["10"] = ["New title", 5, [100], 2007, 2, 4, [[6, None, "artist"]]]
        artists["map"].update({"rating": 1, "artwork_id": 2})
        artists["5"] = ["New primary artist", 5, 888]
        tracks["map"].update({"uploaded_on": 8, "artists_additional": 9})
        tracks["100"] = ["Song One", 10, 4, 2007, "Dance", 3, False, 999,
                          "2026-10-30", [[6, None, "composer"]]]
        new_data["combine_sets"] = True
        new = Library(new_data)
        after = new.album_index()[0]
        self.assertEqual(new.lastmodified, old.lastmodified)
        self.assertEqual((after["name"], after["year"], after["disc"], after["rating"]),
                         ("New title", 2007, 2, 4))
        self.assertEqual(after["artist"], "New primary artist")
        self.assertEqual([entry["id"] for entry in after["album_artists"]], ["5", "6"])
        self.assertEqual((after["artist_rating"], after["artist_artwork_id"]), (5, 888))
        self.assertEqual(after["genres"], ["Dance"])
        self.assertEqual(after["artwork"], "https://art.example/artwork/999-300")
        self.assertEqual((after["track_count"], after["no_composer"], after["track_gaps"]),
                         (1, 0, 2))
        self.assertEqual(after["upload_dates"], ["2026-10-30"])
        self.assertIn("Dance", new.editor_names()["genres"])
        self.assertEqual(new.editor_names()["composers"], ["artist c"])
        self.assertEqual(old.album_index(), before)
        # Derived caches stay in memory, never in the persisted native snapshot.
        self.assertEqual(Library(new.to_cache()).album_index(), new.album_index())
        self.assertNotIn("_album_summaries", new.to_cache())
