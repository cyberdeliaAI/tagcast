"""Visited-album background identity works with discovery disabled, without an analysis."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from test_album_guide import guide_library

from tagcast import client
from tagcast.album_guide import guide_catalogue, guide_selection
from tagcast.library import ConflictError, LibraryError


class AlbumBackgroundTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.studio = client.Studio(self.temp.name)
        self.studio.client = Mock()
        self.studio.library_user = "account-a"
        self.studio.library = guide_library()
        self.studio.playback_session = "test-session"
        self.guide = self.studio.album_guide
        self.reference = guide_catalogue()[0][0]

    def match(self, album_id="1"):
        return self.guide.notes_for_album(album_id, self.studio.playback_session)["entries"]

    def links(self, values):
        self.studio._write(
            "album-guide-links.json",
            {"accounts": {"account-a": {"selection": guide_selection(), "links": values}}},
        )

    def test_disabled_discovery_needs_no_report_analysis_library_scan_or_network(self):
        self.assertFalse(self.studio.config.get("album_guide", False))
        with (
            patch.object(self.guide, "analyse", side_effect=AssertionError("No analysis")),
            patch.object(self.guide, "view", side_effect=AssertionError("No report")),
            patch.object(
                self.studio.library, "album_ids", side_effect=AssertionError("No library scan")
            ),
            patch.object(
                self.studio.library, "album_index", side_effect=AssertionError("No library scan")
            ),
            patch.object(self.studio.lookup.http, "json", side_effect=AssertionError("No network")),
            patch(
                "tagcast.album_guide.match_guide", side_effect=AssertionError("No fuzzy analysis")
            ),
            patch.object(self.studio, "_write") as write,
        ):
            self.assertEqual(
                self.match(), [{k: self.reference[k] for k in ("id", "album", "artist")}]
            )
            write.assert_not_called()
        self.assertEqual(self.studio.client.mock_calls, [])
        self.assertFalse((Path(self.temp.name) / "album-guide.json").exists())
        self.assertEqual(self.guide.view(), {"enabled": False, "state": "disabled"})
        with self.assertRaisesRegex(LibraryError, "Enable 1001"):
            self.guide.analyse()

    def test_enabled_setting_and_missing_or_stale_reports_do_not_change_direct_matches(self):
        for enabled in (False, True):
            self.studio.config["album_guide"] = enabled
            for report in (
                None,
                {"user_id": "another-account"},
                {"stamp": {"lastmodified": "old"}},
            ):
                with self.subTest(enabled=enabled, report=report):
                    if report is not None:
                        self.studio._write("album-guide.json", report)
                    self.assertEqual(self.match()[0]["id"], self.reference["id"])

    def test_live_recordings_other_volumes_and_near_spellings_do_not_receive_text(self):
        for title in (
            "In the Wee Small Hours (Live)",
            "In the Wee Small Hours II",
            "In the Wee Small Hour",
            "In the Wee Small Hours (Acoustic)",
            "",
            "   ",
        ):
            self.studio.library.albums.rows[1][0] = title
            with self.subTest(title=title):
                self.assertEqual(self.match(), [])
        self.studio.library.albums.rows[1][0] = self.reference["album"]
        for artist in ("Frank Sinattra", "", "Unknown artist", "..."):
            self.studio.library.artists.rows[1][0] = artist
            with self.subTest(artist=artist):
                self.assertEqual(self.match(), [])

    def test_ambiguous_normalized_reference_pairs_need_a_manual_choice(self):
        duplicate = {**self.reference, "id": 2, "album": self.reference["album"].upper()}
        with patch(
            "tagcast.album_guide.guide_catalogue",
            return_value=([self.reference, duplicate], "ambiguous"),
        ):
            self.assertEqual(self.match(), [])
            with patch.object(self.guide, "_links", return_value=({}, {"2": ["1"]})):
                self.assertEqual(
                    self.match(), [{k: duplicate[k] for k in ("id", "album", "artist")}]
                )

    def test_manual_links_work_while_disabled_survive_renaming_and_are_account_scoped(self):
        self.links({"1": ["2"]})
        self.assertEqual(self.match(), [], "A manual copy choice overrides automatic matching")
        self.studio.library.albums.rows[2][0] = "My alternate title"
        self.assertEqual(self.match("2")[0]["id"], 1)
        self.studio.library_user = "account-b"
        self.assertEqual(self.match("2"), [])
        self.studio.library_user = "account-a"
        self.assertEqual(self.match("2")[0]["id"], 1)
        self.studio._write(
            "album-guide-links.json",
            {"accounts": {"account-a": {"selection": "old-selection", "links": {"1": ["2"]}}}},
        )
        self.assertEqual(self.match("2"), [])

    def test_missing_linked_discs_do_not_fall_back_to_another_copy(self):
        self.links({"1": ["1", "3"]})  # disc 3 is already trashed in the fixture
        self.assertEqual(self.match(), [])
        self.links({"1": ["1", "999"]})
        self.assertEqual(self.match(), [])

    def test_session_active_album_and_identity_are_validated_without_creating_files(self):
        for album_id in (None, True, 0, "0", "01", "x", "1" * 33):
            with self.subTest(album_id=album_id), self.assertRaises(LibraryError):
                self.guide.notes_for_album(album_id, "test-session")
        for album_id in ("3", "999"):
            with self.subTest(album_id=album_id), self.assertRaises(ConflictError):
                self.match(album_id)
        with self.assertRaises(ConflictError):
            self.guide.notes_for_album("1", "old-session")
        with self.assertRaises(ConflictError):
            self.guide.notes_for_album("1", "")
        with self.assertRaises(ConflictError):
            self.guide.notes_for_album("1", "test-session", "An older title", "Frank Sinatra")
        with self.assertRaises(ConflictError):
            self.guide.notes_for_album("1", "test-session", None, "Another artist")

    def test_replaced_account_library_client_or_album_during_read_discards_the_result(self):
        for change in ("account", "library", "client", "session", "title", "artist", "trash"):
            with self.subTest(change=change):
                self.setUp()

                def changed(_user):
                    if change == "account":
                        self.studio.library_user = "account-b"
                    elif change == "library":
                        self.studio.library = guide_library()
                    elif change == "client":
                        self.studio.client = Mock()
                    elif change == "session":
                        self.studio.playback_session = "changed"
                    elif change == "title":
                        self.studio.library.albums.rows[1][0] = "Changed"
                    elif change == "artist":
                        self.studio.library.artists.rows[1][0] = "Changed"
                    else:
                        self.studio.library.tracks.rows[1][1] = True
                    return {}, {}

                with (
                    patch.object(self.guide, "_links", side_effect=changed),
                    self.assertRaises(ConflictError),
                ):
                    self.guide.notes_for_album("1", "test-session")
