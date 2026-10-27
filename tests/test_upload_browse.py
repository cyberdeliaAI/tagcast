"""Upload groups use loaded metadata only, with exact, paginated track membership."""

import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

from test_library import raw

from tagcast.client import ApiError, Studio
from tagcast.library import ConflictError, Library, LibraryError, upload_group


def uploads():
    data = raw()
    rows = data["library"]["tracks"]
    rows["map"].update(path=8, uploaded_on=9, uploaded_time=10)
    for key, path, day in [("100", "/Music/One", "2026-10-27"),
                           ("101", "/Music/Two", "2026-10-26"),
                           ("102", r"C:\Music\One", "2026-10-27"),
                           ("103", "/Trashed only", "2026-10-28"),
                           ("104", "", "2026-02-30")]:
        rows[key].extend([path, day, "10:30:00"])
    return data


class UploadBrowseTests(unittest.TestCase):
    def test_exact_paths_are_distinct_and_cache_preserves_metadata(self):
        data = uploads()
        original = deepcopy(data)
        library = Library(data)
        groups = library.browse("upload-folders")["groups"]
        self.assertEqual({g["label"] for g in groups},
                         {"/Music/One", "/Music/Two", r"C:\Music\One", "Unknown upload folder"})
        self.assertEqual(groups[-1]["key"], "unknown")
        self.assertTrue(all(g["tracks"] == 1 for g in groups))
        self.assertEqual(Library(library.to_cache()).browse("upload-folders"), library.browse("upload-folders"))
        self.assertEqual(data, original)
        for path in ("/Music/One", "/music/One", r"\Music\One", r"\\NAS\Music\One",
                     "/Music/One/", "/" + "long#?&<é>" * 700, "\ud800"):
            key, label = upload_group("upload-folders", {"path": path})
            self.assertEqual(label, path)
            self.assertRegex(key, r"^[a-f0-9]{64}$")
        keys = {upload_group("upload-folders", {"path": p})[0]
                for p in ("/Music/One", "/music/One", "/Music/One/", r"\Music\One")}
        self.assertEqual(len(keys), 4)

    def test_group_does_not_include_other_tracks_from_the_same_album(self):
        library = Library(uploads())
        key = upload_group("upload-folders", library.tracks[100])[0]
        page = library.browse("upload-folders", key=key, sort="album")
        self.assertEqual([t["id"] for t in page["tracks"]], ["100"])
        self.assertNotIn("album_ids", page)
        self.assertEqual(page["tracks"][0]["uploaded_at"], "2026-10-27T10:30:00")
        self.assertNotIn("path", page["tracks"][0])
        self.assertNotIn("file", page["tracks"][0])
        self.assertEqual(library.browse("upload-folders", key=key, query="elsewhere")["total"], 0)
        self.assertEqual(library.browse("upload-folders", key=key, query="song artist a")["total"], 1)

    def test_dates_use_valid_stored_days_not_track_or_album_years(self):
        library = Library(uploads())
        groups = library.browse("uploaded", sort="za")["groups"]
        self.assertEqual([g["key"] for g in groups], ["2026-10-27", "2026-10-26", "unknown"])
        self.assertEqual(groups[0]["tracks"], 2)
        self.assertEqual([g["key"] for g in library.browse("uploaded", sort="az")["groups"]],
                         ["2026-10-26", "2026-10-27", "unknown"])
        self.assertEqual([t["id"] for t in library.browse("uploaded", key="2026-10-27")["tracks"]], ["102", "100"])
        self.assertEqual(library.browse("uploaded", key="unknown")["tracks"][0]["uploaded_at"], "")
        for value, expected in [("2026-10-27 23:55:00", "2026-10-27"),
                                ("2026-02-30", "unknown"), ("", "unknown"), ("0000-01-01", "unknown")]:
            self.assertEqual(upload_group("uploaded", {"uploaded_on": value})[0], expected)

    def test_bounded_pages_search_sort_and_unknown_data(self):
        data = uploads()
        for key in ("100", "101", "102", "104"):
            data["library"]["tracks"][key][8] = "/Together"
        library = Library(data)
        key = upload_group("upload-folders", library.tracks[100])[0]
        first = library.browse("upload-folders", key, offset=0, limit=2, sort="az")
        second = library.browse("upload-folders", key, offset=2, limit=2, sort="az")
        self.assertEqual(first["total"], 4)
        self.assertEqual(len(first["tracks"]), 2)
        self.assertFalse({t["id"] for t in first["tracks"]} & {t["id"] for t in second["tracks"]})
        self.assertEqual(library.browse("upload-folders", key, offset=9999, limit=2)["offset"], 2)
        self.assertEqual(library.browse("upload-folders", query="together")["total"], 1)
        self.assertEqual(library.browse("upload-folders", key, query="song one")["total"], 1)
        with self.assertRaises(LibraryError):
            library.browse("upload-folders", key="missing")
        for kind in ("upload-folders", "uploaded"):
            missing = Library(raw()).browse(kind)["groups"]
            self.assertEqual(len(missing), 1)
            self.assertEqual(missing[0]["key"], "unknown")
            self.assertEqual(missing[0]["tracks"], 4)

    def test_album_counts_match_merged_multi_disc_shelf(self):
        data = uploads()
        data["library"]["albums"]["12"] = ["Original", 4, [104], 1982, 2]
        for key in ("100", "101", "104"):
            data["library"]["tracks"][key][8:10] = ["/Together", "2026-10-27"]
        library = Library(data)
        groups = library.browse("upload-folders")["groups"]
        self.assertEqual(next(g for g in groups if g["label"] == "/Together")["albums"], 1)


class LoadedUploadBrowseTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.studio = Studio(self.home.name)
        self.studio.client = object()
        self.studio.library = Library(uploads())
        self.studio.library_user = "test-account"
        self.studio.playback_session = "test-session"

    def test_loaded_browsing_makes_no_remote_requests(self):
        with patch.object(self.studio, "_current", side_effect=AssertionError("No remote read")):
            groups = self.studio.browse("upload-folders")["groups"]
            self.studio.browse("upload-folders", groups[0]["key"], sort="album")
            self.studio.browse("uploaded", query="2026", offset="24", limit="24", sort="za")

    def test_invalid_parameters_and_unloaded_library_are_rejected(self):
        for options in ({"sort": "album"}, {"offset": "-1"}, {"limit": "10000"},
                        {"key": "x" * 501}, {"query": "x" * 201}, {"key": "unknown", "sort": "count"}):
            with self.subTest(options=options), self.assertRaises(ApiError):
                self.studio.browse("uploaded", **options)
        self.studio.library = None
        with patch.object(self.studio, "_current", side_effect=AssertionError("No implicit download")), self.assertRaises(ApiError):
            self.studio.browse("upload-folders")

    def test_replaced_library_or_session_cannot_publish_old_paths(self):
        library = self.studio.library
        original = library.browse
        for replace in (lambda: setattr(self.studio, "library", Library(uploads())),
                        lambda: setattr(self.studio, "playback_session", "changed")):
            self.studio.library = library
            self.studio.playback_session = "test-session"
            def raced(*args, **kwargs):
                result = original(*args, **kwargs)
                replace()
                return result
            with patch.object(library, "browse", side_effect=raced), self.assertRaises(ConflictError):
                self.studio.browse("upload-folders")
