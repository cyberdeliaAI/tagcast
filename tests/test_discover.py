"""Local artist discovery never fetches audio/providers or changes the account."""

import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch

from tagcast.client import Studio
from tagcast.discover import MAX_RESULTS, DiscoverIndex
from tagcast.library import ConflictError, Library, LibraryError


def discovery_data():
    artists = {"map": {"name": 0, "rating": 1}, "1": ["Seed", 0]}
    albums = {"map": {"name": 0, "artist_id": 1, "tracks": 2, "year": 3, "disc": 4, "rating": 5}}
    tracks = {"map": {"album_id": 0, "genre": 1, "genres_additional": 2, "file": 3,
                       "trashed": 4, "uploaded_on": 5}}
    rows = [(1, 1, "Seed album", ["Rock", "Progressive Rock"], 1, 0),
            (2, 2, "Related", ["Rock", "Progressive Rock"], 1, 0),
            (3, 3, "Broad genre", ["Rock"], 1, 5),
            (4, 4, "Unrelated", ["Jazz"], 1, 5),
            (5, 2, "Related", ["Rock", "Progressive Rock"], 2, 0),
            (6, 2, "Another by related artist", ["Rock"], 1, 0),
            (7, 0, "Compilation", ["Rock", "Progressive Rock"], 1, 5)]
    for album_id, artist_id, name, genres, disc, rating in rows:
        if artist_id:
            artists.setdefault(str(artist_id), [f"Artist {artist_id}", 0])
        albums[str(album_id)] = [name, artist_id, [album_id], 1990, disc, rating]
        tracks[str(album_id)] = [album_id, genres[0], genres[1:], "/128/song.mp3", False, "2026-01-01"]
    return {"status": {"lastmodified": "v1"}, "combine_sets": False,
            "library": {"artists": artists, "albums": albums, "tracks": tracks}}


class DiscoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.studio = Studio(self.tmp.name)
        self.studio.client = Mock()
        self.studio.library_user = "account-a"
        self.studio.playback_session = "session-a"
        self.data = discovery_data()
        self.studio.library = Library(self.data)

    def view(self, **changes):
        return self.studio.discover.view({"artists": ["1"], "name": "Seed", "session": "session-a", "source": "local", **changes})

    def replace(self):
        self.studio.library = Library(deepcopy(self.data))

    def test_only_explicit_read_builds_one_snapshot_index_without_requests_or_files(self):
        library = self.studio.library
        self.assertIsNone(library._discover_index)
        before = json.dumps(library.to_cache(), sort_keys=True)
        with patch.object(self.studio, "_current", side_effect=AssertionError("No library refresh")), \
                patch.object(self.studio.lookup.http, "json", side_effect=AssertionError("No provider")), \
                patch.object(library, "album_index", wraps=library.album_index) as summary:
            result = self.view()
            self.assertEqual(result, self.view())
            self.assertEqual(summary.call_count, 1)
        self.assertEqual(result["artist"], "Seed")
        self.assertEqual(result["session"], "session-a")
        self.assertEqual(result["status"], "ready")
        self.assertEqual([a["id"] for a in result["albums"]], ["2", "3"])
        self.assertEqual(set(result["albums"][0]["shared_genres"]), {"Rock", "Progressive Rock"})
        self.assertTrue(all(a["playable"] for a in result["albums"]))
        self.assertEqual(json.dumps(library.to_cache(), sort_keys=True), before)
        self.studio.client._jsonrequest.assert_not_called()
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_no_genres_or_no_shared_genres_do_not_invent_suggestions(self):
        self.data["library"]["tracks"]["1"][1:3] = ["", []]
        self.replace()
        self.assertEqual(self.view()["status"], "missing_genres")
        self.assertEqual(self.view()["albums"], [])
        self.data["library"]["tracks"]["1"][1:3] = ["Unshared", []]
        self.replace()
        self.assertEqual(self.view()["status"], "no_matches")
        self.assertEqual(self.view()["albums"], [])

    def test_unrelated_high_ratings_cannot_outrank_shared_genres(self):
        result = self.view()["albums"]
        self.assertEqual(result[0]["id"], "2")
        self.assertNotIn("4", [a["id"] for a in result])

    def test_rating_breaks_equal_genre_scores_and_unknown_is_not_negative(self):
        self.data["library"]["tracks"]["3"][2] = ["Progressive Rock"]
        self.replace()
        self.assertEqual(self.view()["albums"][0]["id"], "3")
        self.data["library"]["albums"]["3"][5] = 0
        self.replace()
        first = self.view()
        self.data["library"]["albums"] = dict(reversed(list(self.data["library"]["albums"].items())))
        self.replace()
        self.assertEqual(self.view(), first)

    def test_local_casefold_preserves_genre_punctuation_without_inventing_aliases(self):
        for row in self.data["library"]["tracks"].values():
            if isinstance(row, list):
                row[1:3] = ["", []]
        self.data["library"]["tracks"]["1"][1] = "Funk / Soul"
        self.data["library"]["tracks"]["2"][1] = "funk / soul"
        self.data["library"]["tracks"]["3"][1] = "Soul"
        self.replace()
        self.assertEqual([a["id"] for a in self.view()["albums"]], ["2"])

    def test_missing_stream_metadata_keeps_navigation_but_removes_playback_permission(self):
        self.data["library"]["tracks"]["5"][3] = ""
        self.replace()
        self.assertFalse(self.view()["albums"][0]["playable"])
        self.data["library"]["tracks"]["2"][4] = True
        self.data["library"]["tracks"]["5"][4] = True
        self.replace()
        self.assertNotIn("2", [a["id"] for a in self.view()["albums"]])

    def test_repeated_disc_numbers_are_not_combined_or_returned_twice_for_one_artist(self):
        self.data["library"]["albums"]["5"][4] = 1
        self.replace()
        index = DiscoverIndex(self.studio.library)
        copies = [a for a in index.albums if a["name"] == "Related"]
        self.assertEqual([a["ids"] for a in copies], [("2",), ("5",)])
        self.assertEqual(len([a for a in self.view()["albums"] if a["id"] in ("2", "5", "6")]), 1)

    def test_more_than_six_artists_stays_bounded_and_never_recommends_seed_or_compilations(self):
        for i in range(8, 24):
            self.data["library"]["artists"][str(i)] = [f"Artist {i}", 0]
            self.data["library"]["albums"][str(i)] = [f"Album {i}", i, [i], 2000, 1, 0]
            self.data["library"]["tracks"][str(i)] = [i, "Rock", [], "/128/song.mp3", False, ""]
        self.replace()
        result = self.view()
        self.assertEqual(len(result["albums"]), MAX_RESULTS)
        self.assertFalse({"1", "7"} & {a["id"] for a in result["albums"]})

    def test_invalid_or_incomplete_artist_identity_and_stale_sessions_are_rejected(self):
        for changes in ({"artists": []}, {"artists": ["1", "1"]}, {"artists": ["١"]},
                        {"artists": [1]}, {"name": ""}, {"artists": ["9" * 33]}):
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.view(**changes)
        for changes in ({"artists": ["2"]}, {"name": "Wrong name"}, {"session": "other"}):
            with self.subTest(changes=changes), self.assertRaises(ConflictError):
                self.view(**changes)

    def test_same_named_native_ids_require_the_complete_group(self):
        self.data["library"]["artists"]["2"][0] = "Seed"
        self.replace()
        with self.assertRaises(ConflictError):
            self.view()
        self.assertNotIn("2", [a["id"] for a in self.view(artists=["1", "2"])["albums"]])

    def test_real_artist_named_various_artists_is_distinct_from_compilations(self):
        self.data["library"]["artists"]["1"][0] = "Various Artists"
        self.replace()
        self.assertEqual(self.view(name="Various Artists")["status"], "ready")
        self.data["library"]["artists"]["1"][0] = "Seed"
        self.data["library"]["artists"]["2"][0] = "Various Artists"
        self.replace()
        self.assertEqual(self.view()["albums"][0]["id"], "2")
        self.assertNotIn("7", [a["id"] for a in self.view()["albums"]])

    def test_additional_album_artist_membership_excludes_seed_collaborations(self):
        albums = self.data["library"]["albums"]
        albums["map"]["artists_additional"] = 6
        albums["3"].append([{"artist_id": 1, "type": "artist", "phrase": "with"}])
        self.replace()
        result = self.view()
        self.assertNotIn("3", [a["id"] for a in result["albums"]])
        self.assertEqual(result["albums"][0]["id"], "2")

    def test_a_new_snapshot_at_the_same_revision_gets_a_new_index(self):
        first = self.view()
        old = self.studio.library
        self.data["library"]["tracks"]["1"][1:3] = ["Jazz", []]
        self.replace()
        self.assertEqual(self.studio.library.lastmodified, old.lastmodified)
        self.assertIsNone(self.studio.library._discover_index)
        result = self.view()
        self.assertNotEqual(result, first)
        self.assertEqual([a["id"] for a in result["albums"]], ["4"])

    def test_replacement_during_index_build_never_publishes_other_accounts_results(self):
        for kind in ("account", "session", "client", "library", "combine"):
            self.replace()
            self.studio.library_user = "account-a"
            self.studio.playback_session = "session-a"
            self.studio.combine_sets = False
            library = self.studio.library
            original = library.album_index

            def replaced():
                self.assertFalse(self.studio.lock._is_owned(), "Index work must not hold Studio.lock")
                if kind == "account":
                    self.studio.library_user = "account-b"
                elif kind == "session":
                    self.studio.playback_session = "session-b"
                elif kind == "client":
                    self.studio.client = Mock()
                elif kind == "library":
                    self.replace()
                else:
                    self.studio.combine_sets = True
                return original()

            with self.subTest(kind=kind), patch.object(library, "album_index", side_effect=replaced), \
                    self.assertRaises(ConflictError):
                self.view()
            self.assertIsNone(library._discover_index)

    def test_replacement_after_ranking_is_rejected_too(self):
        self.view()
        index = self.studio.library._discover_index
        original = index.recommendations

        def replaced(name):
            self.studio.library_user = "account-b"
            return original(name)

        with patch.object(index, "recommendations", side_effect=replaced), self.assertRaises(ConflictError):
            self.view()

    def test_concurrent_reads_share_one_index_and_own_their_response_values(self):
        library = self.studio.library
        original = library.album_index
        entered, release = threading.Event(), threading.Event()

        def build():
            entered.set()
            if not release.wait(5):
                raise TimeoutError("Test did not release index")
            return original()

        with patch.object(library, "album_index", side_effect=build) as summary, ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.view)
            try:
                self.assertTrue(entered.wait(5))
                second = pool.submit(self.view)
            finally:
                release.set()
            left, right = first.result(timeout=5), second.result(timeout=5)
            self.assertEqual(summary.call_count, 1)
        left["albums"][0]["shared_genres"].clear()
        self.assertEqual(self.view(), right)
