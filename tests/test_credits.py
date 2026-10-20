"""Native credit identities, conservative saves and bounded large-playlist reads."""

import copy
import threading
import unittest
from types import SimpleNamespace

from test_library import change, lib

from tagcast.cleanup import candidate
from tagcast.collections import Collections
from tagcast.library import (
    ConflictError,
    LibraryError,
    decode_table,
    plan_save,
    verify,
    write_requests,
)


def credited_library():
    library = lib()
    library.albums.rows[10] = {**dict(library.albums[10]), "artists_additional": [
        {"artist_id": 5, "type": "artist", "phrase": "with"}]}
    library.tracks.rows[100] = {**dict(library.tracks[100]), "artists_additional": [
        {"artist_id": 5, "type": "lyricist", "phrase": "Words by"},
        {"artist_id": 6, "type": "guitar", "phrase": "Original credit"}]}
    return library


class CreditTests(unittest.TestCase):
    def test_all_album_artists_are_compact_searchable_and_survive_cache(self):
        library = credited_library()
        summary = library.album_summary(10)
        self.assertEqual([a["id"] for a in summary["album_artists"]], ["4", "5"])
        self.assertNotIn("tracks", summary)
        self.assertEqual([t["id"] for t in library.search_tracks("Original Artist B")["tracks"]], ["100", "101"])
        self.assertEqual([t["id"] for t in library.search_tracks("Original artist c")["tracks"]], ["100"])
        cached = type(library)(library.to_cache())
        self.assertEqual(cached.album_summary(10)["album_artists"], summary["album_artists"])
        self.assertEqual(cached.album_view(10)["credits"][0]["phrase"], "with")

    def test_album_nested_credit_map_and_distinct_set_membership(self):
        library = credited_library()
        library.albums.nested["artists_additional_map"] = {"artist_id": 1, "type": 0, "phrase": 2}
        library.albums.rows[10]["artists_additional"] = [["artist", 5, "with"]]
        self.assertEqual(library.album_artist_ids(library.albums[10]), [4, 5])
        library.albums.rows[12] = {**dict(library.albums[10]), "tracks": [104], "disc": 2,
                                   "artists_additional": [["artist", 6, "with"]]}
        self.assertNotEqual(library.album_set_key(10), library.album_set_key(12))

    def test_credit_saves_keep_native_ids_roles_phrases_and_read_back_new_ids(self):
        library = credited_library()
        before = library.track_view(100)["credits"]
        after = [copy.deepcopy(before[1]), {"artist_id": None, "name": "New Writer", "type": "lyricist", "phrase": "Lyrics"}]
        plan = plan_save(library, [change("track", 100, 10, credits=(before, after))])
        self.assertEqual(plan["new_artists"], ["New Writer"])
        wire = write_requests(plan, {"New Writer": 9})[0][1]["tracks"][0]
        self.assertEqual(wire["artists_additional"], [
            {"artist_id": 6, "type": "guitar", "phrase": "Original credit"},
            {"artist_id": 9, "type": "lyricist", "phrase": "Lyrics"}])
        library.artists.rows[9] = {"name": "New Writer"}
        library.tracks.rows[100]["artists_additional"] = wire["artists_additional"]
        result = verify(library, plan, {"New Writer": 9})[0]
        self.assertEqual(result["status"], "saved")
        self.assertEqual(result["credits"][1]["artist_id"], 9)
        undo = plan_save(library, [change("track", 100, 10, credits=(result["credits"], before))])
        self.assertEqual(write_requests(undo, {})[0][1]["tracks"][0]["artists_additional"][0]["artist_id"], 5)
        library.tracks.rows[100]["artists_additional"][1]["type"] = "composer"
        self.assertEqual(verify(library, plan, {"New Writer": 9})[0]["status"], "unverified")

    def test_credit_validation_rejects_stale_ids_roles_duplicates_and_conflicting_editors(self):
        library = credited_library()
        before = library.track_view(100)["credits"]
        for entry in [{**before[0], "name": "Another artist"}, {**before[0], "artist_id": 999}]:
            with self.subTest(entry=entry), self.assertRaises(ConflictError):
                plan_save(library, [change("track", 100, 10, credits=(before, [entry]))])
        for after in [[{**before[0], "type": "invented_role"}], [before[0], before[0]],
                      [{"artist_id": None, "name": "Various Artists", "type": "artist", "phrase": None}],
                      [{**before[0], "phrase": "x" * 1001}], [{**before[0], "artist_id": True}]]:
            with self.subTest(after=after), self.assertRaises(LibraryError):
                plan_save(library, [change("track", 100, 10, credits=(before, after))])
        with self.assertRaises(LibraryError):
            plan_save(library, [change("track", 100, 10, credits=(before, []), composers=([], []))])
        with self.assertRaises(ConflictError):
            plan_save(library, [change("track", 100, 10, credits=([], []))])

    def test_album_credits_allow_shared_artist_scope_and_reject_primary_duplicates(self):
        library = credited_library()
        before = library.album_view(10)["credits"]
        plan = plan_save(library, [change("album", 10, 10, year=(1982, 1983)),
                                  change("album", 11, 11, year=(1992, 1993))])
        self.assertEqual(len(plan["items"]), 2)
        for after in [[{"artist_id": 4, "name": "Artist A", "type": "artist", "phrase": None}],
                      [{"artist_id": 5, "name": "Artist B", "type": "lyricist", "phrase": None}]]:
            with self.subTest(after=after), self.assertRaises(LibraryError):
                plan_save(library, [change("album", 10, 10, credits=(before, after))])
        with self.assertRaises(LibraryError):
            plan_save(library, [change("album", 11, 11, year=(1992, 1993)),
                                change("album", 12, 12, year=(1990, 1991))])
        with self.assertRaises(LibraryError):
            plan_save(library, [change("album", 10, 10, artist=("Artist A", "Artist B"))])
        after = [{"artist_id": None, "name": "New Guest", "type": "artist", "phrase": None}]
        plan = plan_save(library, [change("album", 10, 10, artist=("Artist A", "New Primary"), credits=(before, after))])
        self.assertEqual(plan["new_artists"], ["New Primary", "New Guest"])

    def test_genre_limits_match_cleanup_without_truncating_200_characters(self):
        library = credited_library()
        label = "A" * 200
        plan = plan_save(library, [change("track", 100, 10, genres=([], [label]))])
        self.assertEqual(write_requests(plan, {})[0][1]["tracks"][0]["genre"], label)
        self.assertEqual(plan_save(library, [change("track", 100, 10, genre=("", label))])["items"][0]["patch"]["genre"], label)
        with self.assertRaises(LibraryError):
            plan_save(library, [change("track", 100, 10, genre=("", label + "X"))])
        library.tracks.rows[100]["genre"] = "Old"
        result = candidate(library, 100, "genre-labels", {"label": "Old", "replacements": [label]})
        self.assertEqual(result["after"]["genre"], label)
        with self.assertRaises(LibraryError):
            plan_save(library, [change("track", 100, 10, genres=(["Old"], [label + "X"]))])


class LargePlaylistTests(unittest.TestCase):
    def setUp(self):
        self.library = lib()
        self.library.playlists = decode_table({"1": {"name": "Large", "type": "playlist", "tracks": [100, 101] * 10001}})
        self.library.playlists_loaded = True
        self.studio = SimpleNamespace(library=self.library, library_user="account", playback_session="session",
                                      client=object(), save_lock=threading.Lock(), lock=threading.RLock())
        self.studio._require_client = lambda: self.studio.client
        self.studio._current = lambda *args, **kwargs: (self.library, "memory")
        self.studio._library = lambda: (self.library, self.studio.library_user)
        self.collections = Collections(self.studio)

    def test_large_playlist_has_bounded_page_rows_ids_and_account_scoped_snapshot(self):
        page = self.collections.playlists(playlist_id="1", offset="10000")
        self.assertEqual(page["total"], 20002)
        self.assertTrue(page["large"])
        self.assertEqual(len(page["rows"]), 100)
        self.assertEqual(len(page["tracks"]), 100)
        self.assertEqual(page["rows"][0]["position"], 10000)
        self.assertEqual(page["before"], [])
        self.assertEqual(len(page["before_token"]), 64)
        body = {"playlist": 1, "before_token": page["before_token"], "before_name": "Large"}
        self.collections.check_playlist_before(self.library.playlists[1], body)
        for attribute in ("playback_session", "library_user"):
            old = getattr(self.studio, attribute)
            setattr(self.studio, attribute, "other")
            with self.subTest(attribute=attribute), self.assertRaises(ConflictError):
                self.collections.check_playlist_before(self.library.playlists[1], body)
            setattr(self.studio, attribute, old)
        self.library.playlists.rows[1]["tracks"].append(104)
        with self.assertRaises(ConflictError):
            self.collections.check_playlist_before(self.library.playlists[1], body)

    def test_compact_snapshot_does_not_allow_full_replacement_or_other_playlist(self):
        page = self.collections.playlists(playlist_id="1")
        body = {"playlist": 1, "before_token": page["before_token"], "before_name": "Large"}
        with self.assertRaises(ConflictError):
            self.collections.check_playlist_before(self.library.playlists[1], {**body, "playlist": 2})
        with self.assertRaisesRegex(LibraryError, "10,000"):
            self.collections.save_playlist({**body, "action": "replace", "tracks": [100], "name": "Large"})
