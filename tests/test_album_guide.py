"""The listening guide only compares local album metadata, on explicit request."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tagcast import client
from tagcast.album_guide import (
    CATALOGUE,
    AlbumGuide,
    guide_catalogue,
    guide_key,
    guide_title,
    match_guide,
)
from tagcast.library import ConflictError, Library, LibraryError


def guide_library():
    return Library({"status": {"lastmodified": "version-1"}, "combine_sets": False,
                    "library": {
                        "artists": {"map": {"name": 0}, "1": ["Frank Sinatra"]},
                        "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2},
                                   "1": ["In the Wee Small Hours (2011 Remaster)", 1, [1]],
                                   "2": ["In the Wee Small Hours", 1, [2]],
                                   "3": ["In the Wee Small Hours", 1, [3]]},
                        "tracks": {"map": {"album_id": 0, "trashed": 1},
                                   "1": [1, False], "2": [2, False], "3": [3, True]}}})


class GuideTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.studio = client.Studio(self.tmp.name)
        self.studio.client = Mock()
        self.studio.library_user = "account-a"
        self.studio.library = guide_library()

    def test_catalogue_is_complete_clean_and_corrections_are_traceable(self):
        entries, revision = guide_catalogue()
        self.assertEqual([e["id"] for e in entries], list(range(1, 1002)))
        self.assertEqual(len({(e["artist"], e["album"]) for e in entries}), 1001)
        self.assertEqual(len(revision), 64)
        for entry in entries:
            self.assertTrue(1955 <= entry["year"] <= 2007)
            for field in ("artist", "album"):
                self.assertTrue(entry[field].strip())
                self.assertFalse(any(c in entry[field] for c in ("_", "Ã", "Â", "�")))
        self.assertEqual(entries[336]["album"], "The Köln Concert")
        self.assertEqual(entries[965]["artist"], "Björk")
        self.assertEqual(entries[965]["album"], "Medúlla")
        corrections = json.loads(CATALOGUE.read_text(encoding="utf-8"))["corrections"]
        self.assertEqual(len(corrections), 200)
        self.assertEqual(len({c["id"] for c in corrections}), 168)
        self.assertEqual(len({(c["id"], c["field"]) for c in corrections}), len(corrections))
        for correction in corrections:
            self.assertEqual(entries[correction["id"] - 1][correction["field"]], correction["after"])
            self.assertNotEqual(correction["before"], correction["after"])

    def test_reference_repairs_swapped_columns_and_release_years_at_stable_ids(self):
        entries, _ = guide_catalogue()
        expected = {
            118: ("The Sounds of India", "Ravi Shankar", 1958),
            248: ("White Light", "Gene Clark", 1971),
            285: ("Manassas", "Stephen Stills", 1972),
            402: ("Vento De Maio", "Elis Regina", 1983),
            417: ("Crossing the Red Sea with the Adverts", "The Adverts", 1978),
            594: ("Spy Vs Spy", "John Zorn", 1989),
            608: ("The New Tango", "Astor Piazzolla & Gary Burton", 1987),
            693: ("Haut de gamme / Koweït, rive gauche", "Koffi Olomide", 1992),
            753: ("Whatever", "Aimee Mann", 1993),
            895: ("São Paulo Confessions", "Suba", 1999),
        }
        for entry_id, values in expected.items():
            with self.subTest(entry_id=entry_id):
                entry = entries[entry_id - 1]
                self.assertEqual(entry["id"], entry_id)
                self.assertEqual((entry["album"], entry["artist"], entry["year"]), values)
        # CSV line numbers are not catalogue IDs: the adjacent album must stay intact.
        self.assertEqual(entries[283]["artist"], "Lynyrd Skynyrd")
        self.assertEqual(entries[40]["year"], 1963)
        self.assertEqual(entries[205]["year"], 1970)
        self.assertEqual(entries[245]["year"], 1971)

    def test_normalisation_keeps_recording_distinctions(self):
        self.assertEqual(guide_key("The B-52’s", True), guide_key("B52s", True))
        self.assertEqual(guide_key("Björk"), guide_key("Bjork"))
        self.assertEqual(guide_title("Here's Little Richard [Deluxe Edition]"),
                         guide_title("Here’s Little Richard"))
        for suffix in (" (Live)", " (Acoustic)", " (Taylor's Version)", " - Remix",
                       " (A Different Subtitle)", " (Live - Remastered)"):
            with self.subTest(suffix=suffix):
                self.assertNotEqual(guide_title("Album" + suffix), guide_title("Album"))
        self.assertNotEqual(guide_title("Album II"), guide_title("Album"))
        for suffix in (" (Collector's Edition)", " (With Bonus Selections)",
                       " (Remastered Original Album)", " (US Internet Release)"):
            self.assertEqual(guide_title("Album" + suffix), guide_title("Album"))

    def test_similar_titles_cannot_suggest_a_different_numbered_volume(self):
        for title, other in (("Led Zeppelin I", "Led Zeppelin II"),
                             ("Led Zeppelin I", "Led Zeppelin IV"),
                             ("Getz/Gilberto", "Getz/Gilberto #2")):
            rows = match_guide([{"id": 1, "artist": "Artist", "album": title}],
                               [{"id": "1", "artist": "Artist", "name": other}])
            self.assertEqual(rows[0]["status"], "missing")

    def test_matching_counts_list_entries_and_keeps_all_editions(self):
        entries = [{"id": 1, "artist": "Björk", "album": "Debut", "year": 1993},
                   {"id": 2, "artist": "Other artist", "album": "Debut", "year": 1993},
                   {"id": 3, "artist": "Björk", "album": "Vespertine", "year": 2001}]
        albums = [{"id": "a", "artist": "Bjork", "name": "Debut (2011 Remaster)", "year": 2011},
                  {"id": "b", "artist": "Björk", "name": "Debut"},
                  {"id": "c", "artist": "Björk", "name": "Vespertin"}]
        rows = match_guide(entries, albums)
        self.assertEqual(rows[0], {"id": 1, "status": "found", "album_ids": ["a", "b"]})
        self.assertEqual(rows[1]["status"], "missing")
        self.assertEqual(rows[2], {"id": 3, "status": "possible", "album_ids": ["c"]})

    def test_all_1001_reference_albums_match_but_near_artists_are_only_possible(self):
        entries, _ = guide_catalogue()
        albums = [{"id": str(e["id"]), "name": e["album"], "artist": e["artist"]}
                  for e in entries]
        self.assertTrue(all(row["status"] == "found" for row in match_guide(entries, albums)))
        row = match_guide([{"id": 1, "album": "Blue Lines", "artist": "Massive Attack"}],
                          [{"id": "a", "name": "Blue Lines", "artist": "Massive Atack"}])[0]
        self.assertEqual(row["status"], "possible")

    def test_disabled_by_default_and_enabling_does_not_analyse(self):
        self.assertFalse(self.studio.settings()["album_guide"])
        self.assertEqual(self.studio.album_guide.view()["state"], "disabled")
        with self.assertRaises(LibraryError):
            self.studio.album_guide.analyse()
        with patch("tagcast.album_guide.match_guide") as match:
            self.studio.save_settings({"album_guide": True})
            self.assertEqual(self.studio.album_guide.view()["state"], "empty")
            match.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()
        self.assertFalse(Path(self.tmp.name, "album-guide.json").exists())
        with self.assertRaises(client.ApiError):
            self.studio.save_settings({"album_guide": "true"})

    def test_matching_display_survives_restart_without_enabling_or_analysing(self):
        self.assertIsNone(self.studio.settings()["guide_matching_details"])
        with patch("tagcast.album_guide.match_guide") as match:
            saved = self.studio.save_settings({"guide_matching_details": False})
            self.assertFalse(saved["guide_matching_details"])
            self.assertFalse(saved["album_guide"])
            self.assertFalse(client.Studio(self.tmp.name).settings()["guide_matching_details"])
            self.studio.save_settings({"guide_matching_details": True})
            self.assertTrue(client.Studio(self.tmp.name).settings()["guide_matching_details"])
            match.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()
        self.assertFalse(Path(self.tmp.name, "album-guide.json").exists())
        for invalid in ("false", 0, None, []):
            with self.subTest(value=invalid), self.assertRaises(client.ApiError):
                self.studio.save_settings({"guide_matching_details": invalid})
        self.assertTrue(self.studio.settings()["guide_matching_details"])

    def test_analysis_is_local_persistent_and_account_scoped(self):
        self.studio.save_settings({"album_guide": True})
        with patch.object(self.studio, "_current", side_effect=AssertionError("No downloads")):
            result = self.studio.album_guide.analyse()
            self.assertEqual(result["state"], "ready")
            self.assertEqual(result["counts"]["found"], 1)
            self.assertEqual(result["entries"][0]["album_ids"], ["1", "2"])
            self.assertEqual(sum(result["counts"].values()), 1001)
            restored = AlbumGuide(self.studio)
            self.assertEqual(restored.view(), result)
            self.studio.library_user = "account-b"
            self.assertEqual(restored.view()["state"], "empty")
            self.assertNotIn("entries", restored.view())
            self.studio.library_user = "account-a"
            self.studio.library.lastmodified = "version-2"
            self.assertEqual(restored.view()["state"], "stale")
            self.assertNotIn("entries", restored.view())
        self.studio.client._jsonrequest.assert_not_called()
        persisted = json.loads(Path(self.tmp.name, "album-guide.json").read_text())
        self.assertEqual(set(persisted), {"user_id", "stamp", "analysed_at", "rows"})
        self.studio.save_settings({"album_guide": False})
        self.assertEqual(restored.view()["state"], "disabled")

    def test_unknown_library_version_is_not_reused_after_restart(self):
        self.studio.config["album_guide"] = True
        self.studio.library.lastmodified = ""
        self.assertEqual(self.studio.album_guide.analyse()["state"], "ready")
        self.assertEqual(AlbumGuide(self.studio).view()["state"], "stale")

    def test_changing_account_during_analysis_cannot_save_another_accounts_report(self):
        self.studio.config["album_guide"] = True

        def changed(*args):
            self.studio.library_user = "account-b"
            return []

        with patch("tagcast.album_guide.match_guide", side_effect=changed), self.assertRaises(LibraryError):
            self.studio.album_guide.analyse()
        self.assertFalse(Path(self.tmp.name, "album-guide.json").exists())

    def test_corrupt_or_changed_catalogue_and_disc_settings_require_new_analysis(self):
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        self.studio.library.combine_sets = True
        self.assertEqual(self.studio.album_guide.view()["state"], "stale")
        self.studio.library.combine_sets = False
        report = self.studio.album_guide.report
        report["rows"] = []
        self.assertEqual(self.studio.album_guide.view()["state"], "empty")
        self.studio.client = None
        self.assertEqual(self.studio.album_guide.view()["state"], "unavailable")

    def link_body(self, entry_id=2, ids=None, before=None):
        view = self.studio.album_guide.view()
        return {"entry_id": entry_id, "album_ids": ids if ids is not None else ["1"],
                "before": before or [], "revision": view.get("revision"),
                "lastmodified": self.studio.library.lastmodified}

    def test_manual_link_is_local_reversible_and_survives_restart_and_reanalysis(self):
        self.studio.config["album_guide"] = True
        initial = self.studio.album_guide.analyse()
        # Use a possible candidate, then verify undo restores that original result.
        row = self.studio.album_guide.report["rows"][1]
        row.update(status="possible", album_ids=["2"])
        with patch.object(self.studio, "_current", side_effect=AssertionError("No download")):
            linked = self.studio.album_guide.link(self.link_body())
            self.assertEqual(linked["counts"]["found"], initial["counts"]["found"] + 1)
            self.assertEqual(linked["entries"][1]["album_ids"], ["1"])
            self.assertTrue(linked["entries"][1]["manual"])
            undone = self.studio.album_guide.link(self.link_body(ids=[], before=["1"]))
            self.assertEqual(undone["entries"][1]["status"], "possible")
            self.assertEqual(undone["entries"][1]["album_ids"], ["2"])
            self.assertFalse(undone["entries"][1]["manual"])
            self.studio.album_guide.link(self.link_body())
            self.assertTrue(AlbumGuide(self.studio).view()["entries"][1]["manual"])
            self.studio.config["album_guide"] = False
            self.assertEqual(self.studio.album_guide.view()["state"], "disabled")
            self.studio.config["album_guide"] = True
            self.studio.library = guide_library()
            self.studio.library.lastmodified = "version-2"
            self.assertEqual(self.studio.album_guide.view()["state"], "stale")
            fresh = self.studio.album_guide.analyse()
            self.assertTrue(fresh["entries"][1]["manual"])
            self.assertEqual(fresh["entries"][1]["status"], "found")
        self.studio.client._jsonrequest.assert_not_called()

    def test_manual_links_are_isolated_between_accounts_without_erasing_previous_links(self):
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        self.studio.album_guide.link(self.link_body())
        self.studio.library_user = "account-b"
        self.assertEqual(self.studio.album_guide.view()["state"], "empty")
        self.assertFalse(self.studio.album_guide.analyse()["entries"][1]["manual"])
        self.studio.album_guide.link(self.link_body(entry_id=3, ids=["2"]))
        self.studio.library_user = "account-a"
        entries = self.studio.album_guide.analyse()["entries"]
        self.assertTrue(entries[1]["manual"])
        self.assertFalse(entries[2]["manual"])
        saved = json.loads(Path(self.tmp.name, "album-guide-links.json").read_text())
        self.assertEqual(set(saved["accounts"]), {"account-a", "account-b"})
        self.assertNotIn("accounts", self.studio.album_guide.view())

    def test_catalogue_corrections_require_reanalysis_but_keep_manual_links(self):
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        self.studio.album_guide.link(self.link_body())
        entries, _ = guide_catalogue()
        corrected = [dict(entry) for entry in entries]
        corrected[1].update(album="Corrected reference title", artist="Corrected artist", year=1957)
        with patch("tagcast.album_guide.guide_catalogue", return_value=(corrected, "new-revision")):
            self.assertEqual(self.studio.album_guide.view()["state"], "stale")
            result = self.studio.album_guide.analyse()
            entry = result["entries"][1]
            self.assertEqual(entry["album"], "Corrected reference title")
            self.assertEqual(entry["year"], 1957)
            self.assertEqual(entry["status"], "found")
            self.assertTrue(entry["manual"])
            self.assertEqual(entry["manual_ids"], ["1"])
        self.studio.client._jsonrequest.assert_not_called()

    def test_manual_link_rejects_invalid_stale_and_unavailable_choices(self):
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        for changes in ({"entry_id": True}, {"entry_id": 1002}, {"album_ids": ["01"]},
                        {"album_ids": ["١"]}, {"album_ids": [0]}, {"album_ids": ["0"]},
                        {"album_ids": ["1", "1"]}, {"album_ids": ["1"] * 101},
                        {"album_ids": ["3"]}, {"album_ids": ["999999"]},
                        {"album_ids": ["1", "2"]}, {"revision": "old"},
                        {"lastmodified": "old"}, {"before": ["2"]}):
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.studio.album_guide.link({**self.link_body(), **changes})
        self.assertFalse(Path(self.tmp.name, "album-guide-links.json").exists())
        self.studio.album_guide.link(self.link_body())
        with self.assertRaises(ConflictError):
            self.studio.album_guide.link(self.link_body(ids=["2"]))
        self.assertEqual(self.studio.album_guide.view()["entries"][1]["album_ids"], ["1"])

    def test_manual_set_link_and_unavailable_album_after_reanalysis(self):
        raw = guide_library().to_cache()
        albums = raw["library"]["albums"]
        albums["map"]["disc"] = 3
        albums["1"] = ["Same set", 1, [1], 1]
        albums["2"] = ["Same set", 1, [2], 2]
        self.studio.library = Library(raw)
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        linked = self.studio.album_guide.link(self.link_body(ids=["1", "2"]))
        self.assertEqual(linked["entries"][1]["album_ids"], ["1", "2"])
        self.assertEqual(linked["counts"]["found"], 1)
        raw["library"]["tracks"]["1"][1] = True
        raw["library"]["tracks"]["2"][1] = True
        self.studio.library = Library(raw)
        self.studio.library.lastmodified = "version-2"
        unavailable = self.studio.album_guide.analyse()["entries"][1]
        self.assertEqual(unavailable["status"], "missing")
        self.assertTrue(unavailable["manual"])
        self.assertEqual(unavailable["album_ids"], [])
        self.assertEqual(unavailable["manual_ids"], ["1", "2"])

    def test_account_replacement_during_link_cannot_persist_it(self):
        self.studio.config["album_guide"] = True
        self.studio.album_guide.analyse()
        original = self.studio.album_guide._links
        body = self.link_body()
        calls = 0

        def switched(user):
            nonlocal calls
            calls += 1
            result = original(user)
            if calls == 2:
                self.studio.library_user = "account-b"
            return result

        with patch.object(self.studio.album_guide, "_links", side_effect=switched), \
                self.assertRaises(LibraryError):
            self.studio.album_guide.link(body)
        self.assertFalse(Path(self.tmp.name, "album-guide-links.json").exists())


if __name__ == "__main__":
    unittest.main()
