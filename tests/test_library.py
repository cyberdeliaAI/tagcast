import unittest
from copy import deepcopy

from tagcast.library import (
    ConflictError,
    Library,
    LibraryError,
    decode_table,
    plan_save,
    verify,
    write_requests,
)


def raw():
    return {"library": {
        "artists": {"map": {"name": 0}, "4": ["Artist A"], "5": ["Artist B"], "6": ["artist c"]},
        "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2, "year": 3, "disc": 4},
                   "10": ["Original", 4, [100, 101, 103], 1982, 1],
                   "11": ["Other artist", 5, [102], 1992, 1],
                   "12": ["Second by A", 4, [104], "1990", "1"]},
        "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "year": 3,
                           "genre": 4, "track": 5, "trashed": 6, "artwork_id": 7},
                   "100": ["Song One", 10, 4, 1982, "", 1, False, 0],
                   "101": ["Song Two", 10, 4, 1982, "Rock", 2, False, 77],
                   "102": ["Elsewhere", 11, 5, 1992, "Jazz", 1, False, 0],
                   "103": ["Trashed", 10, 4, 1982, "", 3, True, 0],
                   "104": ["Later", 12, 4, 1990, "Pop", "1", False, 0]},
    }, "settings": {"artwork_server": "https://art.example"}}


def lib():
    return Library(raw())


def edited(table, item_id, key, value):
    """A library as iBroadcast would return it after one field changed."""
    data = raw()
    rows = data["library"][table]
    rows[str(item_id)][rows["map"][key]] = value
    return Library(data)


def change(kind, item_id, album_id=None, **fields):
    return {"kind": kind, "id": str(item_id), "albumId": str(album_id or item_id),
            "label": "x", "fields": {k: {"before": b, "after": a} for k, (b, a) in fields.items()}}


class DecodeTests(unittest.TestCase):
    def test_maps_are_decoded_by_name_not_fixed_positions(self):
        self.assertEqual(decode_table({"map": {"name": 1}, "7": [0, "Björk"]}),
                         {7: {"name": "Björk"}})

    def test_nested_map_entries_are_ignored(self):
        table = {"map": {"name": 0, "artists_additional_map": {"phrase": 1}}, "7": ["A", []]}
        self.assertEqual(decode_table(table), {7: {"name": "A"}})

    def test_unknown_array_format_is_rejected(self):
        with self.assertRaises(LibraryError):
            decode_table({"7": ["No map"]})

    def test_album_view_excludes_trash_and_normalizes_numbers(self):
        album = lib().album_view(10)
        self.assertEqual([t["title"] for t in album["tracks"]], ["Song One", "Song Two"])
        self.assertEqual(album["artwork"], "https://art.example/artwork/77-300")
        self.assertEqual(lib().album_view(12)["year"], 1990)
        self.assertEqual(lib().album_view(12)["tracks"][0]["track"], 1)


class SummaryTests(unittest.TestCase):
    def test_album_summary_counts_tracks_without_genre_or_cover(self):
        summary = lib().album_summary(10)  # Song One: no genre, no cover; Song Two: both
        self.assertEqual((summary["no_genre"], summary["no_cover"], summary["track_count"]), (1, 1, 2))
        self.assertNotIn("tracks", summary)


class GenreTests(unittest.TestCase):
    def library(self):
        return Library({"library": {
            "artists": {"map": {"name": 0}, "4": ["A"]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2}, "10": ["X", 4, [1, 2, 3]]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "genre": 3, "genres_additional": 4},
                       "1": ["a", 10, 4, "Rock", ["Metal", "rock"]],
                       "2": ["b", 10, 4, "Pop;Rock", []],
                       "3": ["c", 10, 4, "", []]}}})

    def test_main_genre_comes_first_and_combined_tags_stay_one_genre(self):
        library = self.library()
        self.assertEqual(library.track_view(1)["genres"], ["Rock", "Metal"])
        self.assertEqual(library.track_view(2)["genres"], ["Pop;Rock"])
        self.assertEqual(library.track_view(3)["genres"], [])

    def test_summary_splits_combined_genres_for_search_and_counts_them(self):
        summary = self.library().album_summary(10)
        self.assertEqual(summary["genres"], ["Metal", "Pop", "Rock"])
        self.assertEqual((summary["combined_genres"], summary["no_genre"]), (1, 1))

    def test_genres_are_sent_as_main_genre_plus_additional(self):
        plan = plan_save(self.library(), [change("track", 2, 10, genres=(["Pop;Rock"], ["Pop", " Rock ", "pop"]))])
        self.assertEqual(write_requests(plan, {}), [("update_track", {"tracks": [
            {"file_id": 2, "genre": "Pop", "genres_additional": ["Rock"]}]})])

    def test_clearing_genres(self):
        plan = plan_save(self.library(), [change("track", 1, 10, genres=(["Rock", "Metal"], []))])
        self.assertEqual(write_requests(plan, {})[0][1]["tracks"][0],
                         {"file_id": 1, "genre": "", "genres_additional": []})

    def test_bad_genre_lists_are_refused(self):
        for bad in ("Rock", ["x" * 101], ["a"] * 21, [1]):
            with self.assertRaises(LibraryError):
                plan_save(self.library(), [change("track", 1, 10, genres=(["Rock", "Metal"], bad))])


class ComposerAndGapTests(unittest.TestCase):
    def library(self):
        return Library({"library": {
            "artists": {"map": {"name": 0, "trashed": 1, "artwork_id": 2},
                        "4": ["Duo", True, 0], "5": ["Bach", False, 0], "6": ["Guest", False, 0]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2}, "10": ["X", 4, [1, 2, 3]]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3, "artists_additional": 4,
                               "artists_additional_map": {"artist_id": 0, "phrase": 1, "type": 2}},
                       "1": ["a", 10, 6, 1, [[5, None, "composer"], [6, "feat.", "artist"]]],
                       "2": ["b", 10, 6, 2, []],
                       "3": ["c", 10, 6, 5, []]}}})

    def test_trashed_album_artist_is_still_an_artist(self):
        library = self.library()
        self.assertEqual(library.artist_art(4), 0)
        self.assertIn("Duo", library.artist_names())

    def test_composers_and_gaps_in_track_numbers(self):
        library = self.library()
        self.assertEqual(library.track_view(1)["composers"], ["Bach"])
        summary = library.album_summary(10)
        self.assertEqual((summary["no_composer"], summary["track_gaps"]), (2, 2))  # 3 and 4 missing

    def test_composers_keep_other_extra_artists(self):
        plan = plan_save(self.library(), [change("track", 1, 10, composers=(["Bach"], ["Bach", "Guest"]))])
        self.assertEqual(write_requests(plan, plan["artists"])[0][1]["tracks"][0]["artists_additional"], [
            {"artist_id": 6, "phrase": "feat.", "type": "artist"},
            {"artist_id": 5, "type": "composer"}, {"artist_id": 6, "type": "composer"}])

    def test_nested_maps_survive_the_cache(self):
        library = Library(self.library().to_cache())
        self.assertEqual(library.track_view(1)["composers"], ["Bach"])


class PlanTests(unittest.TestCase):
    def test_album_year_maps_to_string_payload_and_leaves_tracks_alone(self):
        plan = plan_save(lib(), [change("album", 10, year=(1982, 1981))])
        self.assertEqual(write_requests(plan, {}),
                         [("update_album", {"albums": [{"album_id": 10, "year": "1981"}]})])

    def test_identical_track_patches_share_one_request(self):
        plan = plan_save(lib(), [change("track", 100, 10, genre=("", "Art Rock")),
                                 change("track", 101, 10, genre=("Rock", "Art Rock"))])
        self.assertEqual(write_requests(plan, {}), [("update_track", {"tracks": [
            {"file_id": 100, "genre": "Art Rock"}, {"file_id": 101, "genre": "Art Rock"}]})])

    def test_track_number_uses_track_no_on_the_wire(self):
        plan = plan_save(lib(), [change("track", 100, 10, track=(1, 4), title=("Song One", "Intro"))])
        self.assertEqual(write_requests(plan, {})[0][1]["tracks"][0],
                         {"file_id": 100, "track_no": 4, "title": "Intro"})

    def test_existing_artist_is_reused_and_unknown_artist_is_flagged_for_creation(self):
        plan = plan_save(lib(), [change("album", 10, artist=("Artist A", "Artist B")),
                                 change("track", 100, 10, artist=("Artist A", "New Person"))])
        self.assertEqual(plan["artists"], {"Artist B": 5})
        self.assertEqual(plan["new_artists"], ["New Person"])
        requests = write_requests(plan, {**plan["artists"], "New Person": 9})
        self.assertEqual(requests[0], ("update_album", {"albums": [{"album_id": 10, "artist_id": 5}]}))
        self.assertEqual(requests[1], ("update_track", {"tracks": [{"file_id": 100, "artist_id": 9}]}))

    def test_case_only_artist_match_reuses_existing_artist(self):
        plan = plan_save(lib(), [change("album", 10, artist=("Artist A", "Artist C"))])
        self.assertEqual(plan["artists"], {"Artist C": 6})

    def test_conflict_is_detected_against_fresh_data(self):
        fresh = edited("albums", 10, "year", 2000)
        with self.assertRaises(ConflictError):
            plan_save(fresh, [change("album", 10, year=(1982, 1981))])

    def test_value_already_saved_is_skipped(self):
        fresh = edited("albums", 10, "year", 1981)
        self.assertEqual(plan_save(fresh, [change("album", 10, year=(1982, 1981))])["items"], [])

    def test_track_moved_to_other_album_is_a_conflict(self):
        with self.assertRaises(ConflictError):
            plan_save(lib(), [change("track", 102, 10, genre=("Jazz", "Blues"))])

    def test_trashed_track_cannot_be_edited(self):
        with self.assertRaises(ConflictError):
            plan_save(lib(), [change("track", 103, 10, genre=("", "Rock"))])

    def test_scope_is_one_album_artist(self):
        self.assertEqual(len(plan_save(lib(), [change("album", 10, disc=(1, 2)),
                                               change("album", 12, disc=(1, 2))])["items"]), 2)
        with self.assertRaises(LibraryError):
            plan_save(lib(), [change("album", 10, disc=(1, 2)), change("album", 11, disc=(1, 2))])

    def test_bad_values_and_unknown_fields_are_rejected(self):
        for bad in (change("album", 10, year=(1982, "1999")), change("album", 10, year=(1982, True)),
                    change("album", 10, year=(1982, 10000)), change("album", 10, name=("Original", " ")),
                    change("album", 10, trashed=(False, True)), change("track", 100, 10, name=("", "x"))):
            with self.assertRaises(LibraryError):
                plan_save(lib(), [bad])

    def test_duplicates_and_empty_saves_are_rejected(self):
        with self.assertRaises(LibraryError):
            plan_save(lib(), [change("album", 10, disc=(1, 2)), change("album", 10, year=(1982, 1))])
        with self.assertRaises(LibraryError):
            plan_save(lib(), [])

    def test_record_views_do_not_mutate_the_library(self):
        library = lib()
        original = deepcopy(dict(library.albums[10]))
        library.album_view(10)["tracks"].append({})
        self.assertEqual(dict(library.albums[10]), original)


class VerifyTests(unittest.TestCase):
    def test_readback_reports_saved_unverified_and_failed(self):
        plan = plan_save(lib(), [change("album", 10, year=(1982, 1981)),
                                 change("track", 100, 10, genre=("", "Rock")),
                                 change("track", 101, 10, title=("Song Two", "Two"))])
        after = edited("albums", 10, "year", "1981")
        results = verify(after, plan, {}, {("track", 101): "failed"})
        self.assertEqual([r["status"] for r in results], ["saved", "unverified", "failed"])

    def test_artist_readback_compares_ids(self):
        plan = plan_save(lib(), [change("album", 10, artist=("Artist A", "artist b"))])
        after = edited("albums", 10, "artist_id", 5)
        self.assertEqual(verify(after, plan, {"artist b": 5})[0]["status"], "saved")


if __name__ == "__main__":
    unittest.main()
