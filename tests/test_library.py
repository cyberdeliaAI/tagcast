import unittest
from copy import deepcopy
from unittest.mock import patch

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
    def test_editor_names_keep_exact_active_genres_and_composer_roles_without_track_views(self):
        data = raw()
        artists = data["library"]["artists"]
        artists.update({"7": ["Bach; Handel"], "8": ["Featured guest"], "9": ["Hidden composer"]})
        albums = data["library"]["albums"]
        albums["map"]["trashed"] = 5
        for key in ("10", "11", "12"):
            albums[key].append(key == "12")
        tracks = data["library"]["tracks"]
        tracks["map"].update({"artists_additional": 8, "genres_additional": 9})
        tracks["100"][4] = "Pop;Rock"
        tracks["100"].extend([[[7, None, "composer"], [8, None, "artist"],
                               [6, None, "lyricist"], [999, None, "composer"]], ["Jazz / Blues", "café"]])
        tracks["103"][4] = "Trashed genre"
        tracks["103"].extend([[[9, None, "composer"]], []])
        tracks["104"].extend([[[9, None, "composer"]], []])
        tracks["999"] = ["Unlisted", 10, 4, 1982, "Unlisted genre", 9, False, 0,
                         [[9, None, "composer"]], []]
        library = Library(data)
        with patch.object(library, "track_view", side_effect=AssertionError("No track views")), \
                patch.object(library, "album_view", side_effect=AssertionError("No album views")):
            library.album_index()
            with patch.object(library, "album_index", side_effect=AssertionError("No second scan")):
                names = library.editor_names()
        self.assertEqual(names, {"genres": ["café", "Jazz", "Jazz / Blues", "Pop;Rock", "Rock"],
                                 "composers": ["Bach; Handel"]})
        names["genres"].clear()
        self.assertIn("Pop;Rock", library.editor_names()["genres"])
        data["library"]["tracks"]["100"][4] = "New genre"
        self.assertIn("New genre", Library(data).editor_names()["genres"])

    def test_latest_upload_uses_active_valid_track_timestamps_only(self):
        data = raw()
        rows = data['library']['tracks']
        rows['map'].update({'uploaded_on': 8, 'uploaded_time': 9})
        rows['100'].extend(['2026-10-01', '10:20:30'])
        rows['101'].extend(['2026-10-01', '16:40:50'])
        rows['103'].extend(['2026-12-01', '23:59:59'])  # trashed
        library = Library(data)
        self.assertEqual(library.album_summary(10)['uploaded_at'], '2026-10-01T16:40:50')
        self.assertEqual(library.album_view(10)['uploaded_at'], '2026-10-01T16:40:50')
        self.assertEqual(Library(library.to_cache()).album_summary(10)['uploaded_at'], '2026-10-01T16:40:50')
        self.assertNotIn('tracks', library.album_summary(10))

    def test_full_upload_timestamp_keeps_stored_precision_and_disc_group_dates(self):
        for day, clock, expected in [
            ("2026-10-15", "09:45:47", "2026-10-15T09:45:47"),
            ("2026-10-15 22:48:19", "", "2026-10-15T22:48:19"),
            ("2026-10-15", "", "2026-10-15"),
            ("2026-10-15", "25:00:00", "2026-10-15"),
            ("2026-02-30", "09:45:47", ""), ("", "09:45:47", ""),
        ]:
            with self.subTest(day=day, clock=clock):
                data = raw()
                rows = data["library"]["tracks"]
                rows["map"].update({"uploaded_on": 8, "uploaded_time": 9})
                rows["100"].extend([day, clock])
                library = Library(data)
                self.assertEqual(library.track_view(100)["uploaded_at"], expected)
                self.assertEqual(Library(library.to_cache()).track_view(100)["uploaded_at"], expected)
                self.assertEqual(library.track_view(100)["uploaded_on"], day[:10])
                self.assertEqual(library.album_summary(10)["uploaded_at"], expected)

    def test_file_formats_reuse_stored_types_in_details_search_favourites_and_cache(self):
        for mime, expected in [("audio/flac", "FLAC"), ("audio/x-flac", "FLAC"),
                               (" Audio/MPEG ", "MP3"), ("audio/mp3", "MP3"),
                               ("audio/mp4", "AAC/ALAC"), ("audio/wav", "WAV"),
                               ("audio/unrecognized", ""), ("", "")]:
            with self.subTest(mime=mime):
                value = raw()
                rows = value["library"]["tracks"]
                rows["map"]["type"], rows["map"]["rating"] = 8, 9
                rows["100"].extend([mime, 5])
                library = Library(value)
                self.assertEqual(library.album_view(10)["tracks"][0]["format"], expected)
                self.assertEqual(library.search_tracks("Song One")["tracks"][0]["format"], expected)
                self.assertEqual(library.favourites()["tracks"][0]["format"], expected)
                self.assertEqual(Library(library.to_cache()).track_view(100)["format"], expected)
                self.assertNotIn("type", library.track_view(100))

    def test_disc_grouping_requires_year_and_active_upload_date_set(self):
        for year, dates, expected in [
            (1982, ["2026-09-25 12:10:00", "2026-10-02 09:00:00"], 1),
            (1983, ["2026-09-25", "2026-10-02"], 2),
            (0, ["2026-09-25", "2026-10-02"], 2),
            (1982, ["2026-09-26", "2026-10-02"], 2),
            (1982, ["", ""], 2),
        ]:
            with self.subTest(year=year, dates=dates):
                value = raw()
                rows = value["library"]["albums"]
                rows["12"][0], rows["12"][3], rows["12"][4] = " ORIGINAL ", year, 2
                rows["12"][2].append(105)
                tracks = value["library"]["tracks"]
                tracks["map"]["uploaded_on"] = 8
                tracks["100"].append("2026-10-02 10:00:00")
                tracks["101"].append("2026-09-25 11:00:00")
                tracks["103"].append("1999-01-01")  # trashed dates never participate
                tracks["104"].append(dates[0])
                tracks["105"] = ["Final", 12, 4, year, "Rock", 2, False, 0, dates[1]]
                library = Library(value)
                self.assertEqual(library.album_summary(10)["upload_dates"],
                                 ["2026-09-25", "2026-10-02"])
                self.assertEqual(library.track_view(100)["uploaded_on"], "2026-10-02")
                self.assertEqual(library.browse("track-artists", key="4")["group"]["albums"], expected)
                cached = Library(library.to_cache())
                self.assertEqual(cached.album_set_key(10), library.album_set_key(10))
                self.assertEqual(cached.browse("track-artists"), library.browse("track-artists"))

    def test_album_summary_counts_tracks_without_genre_or_cover(self):
        summary = lib().album_summary(10)  # Song One: no genre, no cover; Song Two: both
        self.assertEqual((summary["no_genre"], summary["no_cover"], summary["track_count"]), (1, 1, 2))
        self.assertNotIn("tracks", summary)

    def test_native_favourites_include_top_ratings_only_and_search_and_paginate_on_server(self):
        data = raw()
        tracks = data["library"]["tracks"]
        tracks["map"]["rating"] = 8
        for item_id, rating in [(100, 5), (101, 3), (102, 10), (103, 5), (104, 1)]:
            tracks[str(item_id)].append(rating)
        library = Library(data)
        found = library.favourites(limit=1)
        self.assertEqual((found["count"], found["total"], len(found["tracks"])), (2, 2, 1))
        self.assertEqual(found["tracks"][0]["id"], "100")
        self.assertEqual(library.favourites(offset=1, limit=1)["tracks"][0]["id"], "102")
        self.assertEqual(library.favourites(offset=99, limit=1)["offset"], 1)
        self.assertEqual(library.favourites("ÁRTIST B")["total"], 1)
        self.assertEqual(library.track_view(101)["rating"], 3)
        cached = Library(library.to_cache())
        self.assertEqual(cached.favourites()["tracks"], library.favourites()["tracks"])

    def test_favourite_uses_the_displayed_combined_album_even_with_an_original_disc_id(self):
        data = raw()
        data["library"]["tracks"]["map"]["rating"] = 8
        data["library"]["tracks"]["100"][1] = 99  # original disc absent from the combined view
        data["library"]["tracks"]["100"].append(5)
        library = Library(data)
        self.assertEqual(library.active_track_album(100), 10)
        self.assertEqual(library.favourites()["tracks"][0]["album_id"], "10")


class RecentlyPlayedTests(unittest.TestCase):
    def test_native_type_order_search_pagination_and_cache_without_private_playlist_data(self):
        data = raw()
        data["library"]["playlists"] = {
            "map": {"type": 0, "name": 1, "tracks": 2, "public_id": 3},
            "7": [None, "Recently Played", [102], "private-key"],
            "8": ["recently-played", "Translated title", [104, 101, 999, 103, 100, 101], "private-key"],
        }
        library = Library(data)
        self.assertEqual(library.recent_track_ids, [104, 101, 999, 103, 100])
        found = library.recently_played(limit=2)
        self.assertTrue(found["available"])
        self.assertEqual(found["total"], 3)
        self.assertEqual([t["id"] for t in found["tracks"]], ["104", "101"])
        self.assertEqual(library.recently_played(offset=99, limit=2)["tracks"][0]["id"], "100")
        self.assertEqual([t["id"] for t in library.recently_played("song")["tracks"]], ["101", "100"])
        cached = library.to_cache()
        self.assertIn("playlists", cached["library"])
        self.assertNotIn("private-key", str(cached))
        self.assertEqual(Library(cached).recently_played(), library.recently_played())
        self.assertNotIn("played_at", found["tracks"][0])

    def test_missing_playlist_is_distinct_from_empty_and_old_cache(self):
        data = raw()
        self.assertFalse(Library(data).recent_loaded)
        data["library"]["playlists"] = {"map": {"type": 0, "tracks": 1}}
        library = Library(data)
        self.assertTrue(library.recent_loaded)
        self.assertFalse(library.recently_played()["available"])
        self.assertTrue(Library(library.to_cache()).recent_loaded)
        data["library"]["playlists"]["8"] = ["recently-played", []]
        self.assertTrue(Library(data).recently_played()["available"])
        self.assertEqual(Library(data).recently_played()["tracks"], [])
        data["library"]["playlists"]["8"][1] = "100"
        self.assertFalse(Library(data).recently_played()["available"])
        data["library"]["playlists"] = {"map": {}, "8": []}
        library = Library(data)
        self.assertEqual(library.playlist_count, 1)
        self.assertFalse(library.recently_played()["available"])

    def test_combined_disc_ids_resolve_to_the_displayed_album(self):
        data = raw()
        data["library"]["tracks"]["100"][1] = 99
        data["recently_played"] = [100]
        self.assertEqual(Library(data).recently_played()["tracks"][0]["album_id"], "10")


class BrowseTests(unittest.TestCase):
    def test_track_artists_use_ids_and_exact_names_not_substring_matches(self):
        data = raw()
        data["library"]["artists"]["4"] = ["Björk; Guest"]
        data["library"]["artists"]["5"] = ["Björk"]
        library = Library(data)
        groups = library.browse("track-artists", query="bjork", limit=1)
        self.assertEqual((groups["total"], groups["count"], len(groups["groups"])), (2, 2, 1))
        self.assertEqual(library.browse("track-artists", key="4")["album_ids"], ["10", "12"])
        self.assertEqual(library.browse("track-artists", key="5")["album_ids"], ["11"])
        self.assertNotIn("tracks", library.browse("track-artists", key="4"))
        cached = Library(library.to_cache())
        self.assertEqual(cached.browse("track-artists"), library.browse("track-artists"))

    def test_genres_include_additional_labels_keep_combined_labels_and_deduplicate(self):
        library = GenreTests().library()
        found = library.browse("genres")
        self.assertEqual({g["label"]: g["tracks"] for g in found["groups"]}, {"Rock": 1, "Metal": 1, "Pop;Rock": 1})
        self.assertEqual(library.browse("genres", key="ROCK")["album_ids"], ["10"])
        self.assertEqual(library.browse("genres", key="pop;rock")["album_ids"], ["10"])
        self.assertEqual(library.browse("genres", query="pop")["total"], 1)

    def test_composers_use_credit_type_nested_map_and_distinct_ids(self):
        data = ComposerAndGapTests().library().to_cache()
        tracks = data["library"]["tracks"]
        tracks["map"]["artists_additional_map"] = {"artist_id": 2, "phrase": 0, "type": 1}
        tracks["1"][4] = [[None, "composer", 5], [None, "composer", 5], ["feat.", "artist", 6]]
        library = Library(data)
        self.assertEqual(library.browse("composers")["groups"], [{"key": "5", "label": "Bach", "image": "", "tracks": 1, "albums": 1}])
        self.assertEqual(library.browse("composers", key="5")["album_ids"], ["10"])
        self.assertEqual(library.browse("composers", query="Guest")["total"], 0)

    def test_years_use_track_year_then_album_year_and_keep_unknown_last(self):
        data = raw()
        data["library"]["tracks"]["100"][3] = 2001
        data["library"]["tracks"]["101"][3] = 0
        data["library"]["tracks"]["104"][3] = 0
        data["library"]["albums"]["12"][3] = 0
        library = Library(data)
        self.assertEqual([g["key"] for g in library.browse("years", sort="za")["groups"]], ["2001", "1992", "1982", "0"])
        self.assertEqual([g["key"] for g in library.browse("years")["groups"]], ["1982", "1992", "2001", "0"])
        self.assertEqual(library.browse("years", key="1982")["album_ids"], ["10"])
        self.assertEqual(library.browse("years", key="0")["album_ids"], ["12"])

    def test_decades_use_effective_years_keep_centuries_distinct_and_exclude_unknown(self):
        data = raw()
        data["library"]["tracks"]["100"][3] = 1929
        data["library"]["tracks"]["101"][3] = 0  # falls back to 1982
        data["library"]["tracks"]["102"][3] = 2020
        data["library"]["tracks"]["104"][3] = 0
        data["library"]["albums"]["12"][3] = 0
        library = Library(data)
        self.assertEqual([g["label"] for g in library.browse("decades")["groups"]],
                         ["1920s", "1980s", "2020s"])
        self.assertEqual(library.browse("decades", key="1980")["album_ids"], ["10"])
        self.assertEqual(library.browse("decades", key="2020")["album_ids"], ["11"])
        self.assertEqual(library.browse("decades", query="198")["groups"][0]["tracks"], 1)
        self.assertEqual(Library(library.to_cache()).browse("decades"), library.browse("decades"))

    def test_browse_excludes_unavailable_tracks_and_resolves_combined_discs(self):
        data = raw()
        data["library"]["tracks"]["100"][1] = 99
        data["library"]["tracks"]["105"] = ["Orphan", 10, 6, 2000, "Rock", 4, False, 0]
        data["library"]["albums"]["11"].append(True)
        data["library"]["albums"]["map"]["trashed"] = 5
        # Duplicate membership still counts a track once; use the first displayed album.
        data["library"]["albums"]["12"][2].append(100)
        library = Library(data)
        self.assertEqual(library.browse("track-artists")["groups"], [{"key": "4", "label": "Artist A", "image": "", "tracks": 3, "albums": 2}])
        self.assertEqual(library.browse("track-artists", key="4")["album_ids"], ["10", "12"])
        with self.assertRaises(LibraryError):
            library.browse("composers", key="6")
        with self.assertRaises(LibraryError):
            library.browse("invalid")
        self.assertEqual(library.browse("track-artists", offset=999, limit=1)["offset"], 0)

    def test_album_counts_match_the_shelf_for_every_group_and_single_disc_matches(self):
        data = raw()
        data["library"]["albums"]["12"][0] = " ORIGINAL "
        data["library"]["albums"]["12"][4] = 2
        data["library"]["albums"]["12"][3] = 1982
        data["library"]["albums"]["11"][3] = 1982
        data["library"]["tracks"]["map"]["artists_additional"] = 8
        for track in data["library"]["tracks"].values():
            if isinstance(track, list):
                track[3], track[4] = 0, "Rock"
                track.append([{"artist_id": 5, "type": "composer"}])
        library = Library(data)
        for kind, key in [("genres", "rock"), ("composers", "5"), ("years", "1982"), ("decades", "1980")]:
            with self.subTest(kind=kind):
                group = next(g for g in library.browse(kind)["groups"] if g["key"] == key)
                self.assertEqual((group["albums"], group["tracks"]), (2, 4))
                self.assertEqual(len(library.browse(kind, key=key)["album_ids"]), 3)
        artist = library.browse("track-artists", key="4")["group"]
        self.assertEqual(artist["albums"], 1)
        self.assertEqual(Library(library.to_cache()).browse("genres"), library.browse("genres"))
        # A label on only the second disc still opens/counts the whole set once.
        data["library"]["tracks"]["104"][4] = "Jazz"
        group = Library(data).browse("genres", key="jazz")
        self.assertEqual((group["group"]["albums"], group["album_ids"]), (1, ["12"]))

    def test_duplicate_disc_numbers_and_different_album_artists_do_not_merge_counts(self):
        data = raw()
        for album in ("10", "11", "12"):
            data["library"]["albums"][album][0] = "Original"
        # Artist A's two disc-1 albums are separate; Artist B's disc 2 is separate too.
        data["library"]["albums"]["11"][4] = 2
        library = Library(data)
        self.assertEqual(library.browse("track-artists", key="4")["group"]["albums"], 2)
        self.assertEqual(library.browse("track-artists", key="5")["group"]["albums"], 1)


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
        for bad in ("Rock", ["x" * 201], ["a"] * 21, [1]):
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

    def test_duplicate_tracks_require_the_same_number_and_title(self):
        self.assertEqual(self.library().album_summary(10)["duplicates"], 0)
        library = Library({"library": {
            "artists": {"map": {"name": 0}, "6": ["Guest"]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2},
                       "10": ["X", 6, list(range(1, 11))], "11": ["X", 6, [11]]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3},
                       "1": ["Angel", 10, 6, 1], "2": ["  angel ", 10, 6, "1"],
                       "3": ["", 10, 6, 2], "4": ["", 10, 6, 2],
                       "5": ["Angel", 10, 6, 17],  # reprise, not an extra copy
                       "6": ["Other song", 10, 6, 1],  # same number, different title
                       "7": ["Unknown", 10, 6, 0], "8": ["Unknown", 10, 6, 0],
                       "9": ["Missing", 10, 6], "10": ["Missing", 10, 6],
                       "11": ["Angel", 11, 6, 1]}}})
        self.assertEqual(library.album_summary(10)["duplicates"], 1)
        self.assertEqual(library.album_summary(11)["duplicates"], 0)

    def test_duplicate_tracks_ignore_quotes_but_keep_version_text(self):
        pairs = [
            ('Red Shoes (from the "Dumplin\'" Original Motion Picture Soundtrack)',
             "Red Shoes (from the Dumplin' Original Motion Picture Soundtrack)", 1),
            ("Holdin’ On To You", "Holdin' On To You", 1),
            ("“Angel”", "angel", 1),
            ("Song (Live)", "Song", 0),
            ("Song (Radio Edit)", "Song", 0),
            ("Song (Parts I–V)", "Song (Parts VI–IX)", 0),
            ("Rock & Roll", "Rock Roll", 0),
            ("'''", '"""', 0),
        ]
        for first, second, expected in pairs:
            with self.subTest(first=first, second=second):
                data = {"library": {
                    "artists": {"map": {"name": 0}, "6": ["Dolly Parton"]},
                    "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2},
                               "10": ["Dumplin'", 6, [1, 2]]},
                    "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3},
                               "1": [first, 10, 6, 4], "2": [second, 10, 6, 4]}}}
                library = Library(data)
                self.assertEqual(library.album_summary(10)["duplicates"], expected)
                self.assertEqual([library.track_view(i)["title"] for i in (1, 2)],
                                 [first, second])  # Comparing never changes stored titles.

    def test_repeated_numbers_find_differing_titles_but_keep_discs_and_trash_separate(self):
        titles = ["Sous le soleil exactement", "Sous le soleil exactement",
                  'Sous le soleil exactement (Bande originale de la comédie musicale télévisée "Anna")',
                  "C'est la cristallisation comme dit Stendhal",
                  'C\'est la cristallisation comme dit Stendhal (BOF "Anna")',
                  "Pas mal pas mal du tout", "Unknown", "Unknown", "Trashed"]
        numbers = [1, 2, "2", 3, 3, 4, 0, 0, 4]
        rows = {str(i): [title, 10, 6, position, i == 9]
                for i, (title, position) in enumerate(zip(titles, numbers), 1)}
        rows["10"] = [titles[0], 11, 6, 1, False]
        library = Library({"library": {
            "artists": {"map": {"name": 0}, "6": ["Anna"]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2, "disc": 3},
                       "10": ["Anna", 6, list(range(1, 10)), 1], "11": ["Anna", 6, [10], 2]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3,
                               "trashed": 4}, **rows}}})
        summary = library.album_summary(10)
        self.assertEqual((summary["repeated_numbers"], summary["duplicates"]), (2, 0))
        self.assertNotIn("tracks", summary, "The filter uses summaries without fetching tracks")
        self.assertEqual(library.album_summary(11)["repeated_numbers"], 0)
        self.assertEqual(Library(library.to_cache()).album_summary(10)["repeated_numbers"], 2)
        self.assertEqual([library.tracks[i]["title"] for i in range(1, 10)], titles)

    def test_native_combined_view_compares_the_original_discs_separately(self):
        value = {"combine_sets": True, "library": {
            "artists": {"map": {"name": 0}, "6": ["Artist"]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2},
                       "10": ["Combined set", 6, [1, 2]]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3},
                       "1": ["Same title", 91, 6, 1], "2": ["Same title", 92, 6, 1]}}}
        library = Library(value)
        self.assertEqual((library.album_summary(10)["repeated_numbers"],
                          library.album_summary(10)["duplicates"]), (0, 0))
        self.assertEqual([t["album_id"] for t in library.album_view(10)["tracks"]], ["91", "92"])
        value["library"]["albums"]["10"][2].append(3)
        value["library"]["tracks"]["3"] = ["Different title", 92, 6, 1]
        summary = Library(value).album_summary(10)
        self.assertEqual((summary["repeated_numbers"], summary["duplicates"]), (1, 0))

    def test_composers_keep_other_extra_artists(self):
        plan = plan_save(self.library(), [change("track", 1, 10, composers=(["Bach"], ["Bach", "Guest"]))])
        self.assertEqual(write_requests(plan, plan["artists"])[0][1]["tracks"][0]["artists_additional"], [
            {"artist_id": 6, "phrase": "feat.", "type": "artist"},
            {"artist_id": 5, "type": "composer"}, {"artist_id": 6, "type": "composer"}])

    def test_nested_maps_survive_the_cache(self):
        library = Library(self.library().to_cache())
        self.assertEqual(library.track_view(1)["composers"], ["Bach"])


class SearchTests(unittest.TestCase):
    def library(self):
        return Library({"library": {
            "artists": {"map": {"name": 0}, "4": ["Björk"], "5": ["Bach"], "6": ["Choir"]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2, "year": 3, "disc": 4, "trashed": 5},
                       "10": ["Post", 4, [1, 2, 3], 1995, 1, False], "11": ["Mass", 6, [5, 4], 0, 2, False],
                       "12": ["Gone", 4, [6], 2001, 1, True]},
            "tracks": {"map": {"title": 0, "album_id": 1, "artist_id": 2, "track": 3, "trashed": 4,
                               "length": 5, "year": 6, "artists_additional": 7,
                               "artists_additional_map": {"artist_id": 0, "phrase": 1, "type": 2}},
                       "1": ["Army of Me", 10, 4, 1, False, 234, 0, []],
                       "2": ["Hyper-Ballad", 10, 4, 4, False, 321, 1995, []],
                       "3": ["Army of Me (Remix)", 10, 4, 2, True, 200, 0, []],
                       "4": ["Kyrie", 11, 6, 1, False, 300, 1749, [[5, None, "composer"]]],
                       "5": ["Gloria", 11, 6, 2, False, 400, 0, [[5, None, "composer"]]],
                       "6": ["Army of None", 12, 4, 1, False, 100, 0, []]}}})

    def titles(self, query, **options):
        return [t["title"] for t in self.library().search_tracks(query, **options)["tracks"]]

    def test_every_word_must_match_title_artist_album_or_composer(self):
        self.assertEqual(self.titles("army"), ["Army of Me"])  # not trashed tracks or albums
        self.assertEqual(self.titles("bjork post"), ["Army of Me", "Hyper-Ballad"])  # accents don't count
        self.assertEqual(self.titles("BACH"), ["Kyrie", "Gloria"])  # composer, in track order
        self.assertEqual(self.titles("bach army"), [])
        self.assertEqual(self.titles("   "), [])

    def test_results_say_where_the_track_is_and_are_capped(self):
        library = self.library()
        kyrie = library.search_tracks("kyrie")["tracks"][0]
        self.assertEqual(kyrie, {"id": "4", "album_id": "11", "title": "Kyrie", "artist": "Choir",
                                 "performers": [{"id": "6", "name": "Choir"}],
                                 "composers": ["Bach"], "album": "Mass", "disc": 2, "track": 1,
                                 "year": 1749, "length": 300, "format": "", "rating": 0})
        self.assertEqual(library.search_tracks("army")["tracks"][0]["year"], 1995)  # album year
        capped = library.search_tracks("o", limit=2)
        self.assertEqual((len(capped["tracks"]), capped["total"]), (2, 4))


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

    def test_various_artists_uses_reserved_id_without_changing_tracks_or_creating_artist(self):
        data = raw()
        data["library"]["artists"]["7"] = ["Various Artists"]
        library = Library(data)
        self.assertEqual(library.find_artist("Various Artists"), 7)
        plan = plan_save(library, [change("album", 10, artist_id=(4, 0)),
                                   change("album", 12, artist_id=(4, 0))])
        self.assertEqual(plan["new_artists"], [])
        self.assertEqual(plan["artists"], {})
        self.assertEqual(write_requests(plan, {}), [("update_album", {"albums": [
            {"album_id": 10, "artist_id": 0}, {"album_id": 12, "artist_id": 0}]})])
        self.assertEqual([r["status"] for r in verify(library, plan, {})],
                         ["unverified", "unverified"])
        data["library"]["albums"]["10"][1] = 0
        data["library"]["albums"]["12"][1] = 0
        after = Library(data)
        self.assertEqual(after.album_view(10)["artist"], "Various Artists")
        self.assertEqual([t["artist"] for t in after.album_view(10)["tracks"]],
                         ["Artist A", "Artist A"])
        self.assertEqual([r["status"] for r in verify(after, plan, {})], ["saved", "saved"])

    def test_various_artists_checks_identity_and_rejects_ambiguous_or_unsupported_ids(self):
        with self.assertRaises(ConflictError):
            plan_save(edited("albums", 10, "artist_id", 5),
                      [change("album", 10, artist_id=(4, 0))])
        for value in [True, False, 4, -1, "0", None]:
            with self.subTest(value=value), self.assertRaises(LibraryError):
                plan_save(lib(), [change("album", 10, artist_id=(4, value))])
        with self.assertRaises(LibraryError):
            plan_save(lib(), [change("track", 100, 10, artist_id=(4, 0))])
        with self.assertRaises(LibraryError):
            plan_save(lib(), [change("album", 10, artist_id=(4, 0),
                                      artist=("Artist A", "Artist B"))])
        with self.assertRaises(LibraryError):
            plan_save(lib(), [change("album", 10, artist_id=(4, 0)),
                              change("album", 11, artist_id=(5, 0))])

    def test_various_artists_can_be_replaced_by_a_named_album_artist(self):
        library = edited("albums", 10, "artist_id", 0)
        plan = plan_save(library, [change("album", 10, artist=("Various Artists", "Artist B"))])
        self.assertEqual(write_requests(plan, plan["artists"]),
                         [("update_album", {"albums": [{"album_id": 10, "artist_id": 5}]})])

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

    def test_album_and_track_year_boundaries_allow_clearing_and_future_releases(self):
        for kind, item_id in [("album", 10), ("track", 100)]:
            for year in [0, 1800, 2027, 2050]:
                with self.subTest(kind=kind, year=year):
                    plan = plan_save(lib(), [change(kind, item_id, 10, year=(1982, year))])
                    mode, payload = write_requests(plan, {})[0]
                    self.assertEqual(mode, "update_album" if kind == "album" else "update_track")
                    self.assertEqual(payload["albums" if kind == "album" else "tracks"][0]["year"], str(year))
            for year in [-1, 1, 1799, 2051, 9999, True, "2000", 2000.5]:
                with self.subTest(kind=kind, year=year), self.assertRaises(LibraryError):
                    plan_save(lib(), [change(kind, item_id, 10, year=(1982, year))])

    def test_existing_bad_year_does_not_block_unrelated_metadata_or_a_valid_correction(self):
        for year in [1700, 3000]:
            with self.subTest(year=year):
                library = edited("albums", 10, "year", year)
                plan = plan_save(library, [change("album", 10, name=("Original", "Correct title"))])
                self.assertEqual(write_requests(plan, {}), [("update_album", {
                    "albums": [{"album_id": 10, "name": "Correct title"}]})])
                plan = plan_save(library, [change("album", 10, year=(year, 2000))])
                self.assertEqual(plan["items"][0]["patch"], {"year": 2000})

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
