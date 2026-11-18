import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from tagcast import client
from tagcast.library import ConflictError, Library


def fixture():
    titles = [
        ("Song A (feat. Guest)", []),
        ("Song B [featuring Guest]", []),
        ("Song C ft. Guest", []),
        ("Already credited (feat. Guest)", [{"artist_id": 2, "type": "artist"}]),
        ("Alternate spelling (feat. Guest)", [{"artist_id": 3, "type": "artist"}]),
        ("Other role (feat. Guest)", [{"artist_id": 2, "type": "composer"}]),
        ("Both credited (feat. Guest & Friend)", [{"artist_id": 2}, {"artist_id": 4}]),
        ("In combined credit (feat. Guest)", [{"artist_id": 5}]),
        ("Ambiguous (feat. Dupe)", []),
        ("Unknown (feat. Unknown)", []),
        ("Trashed artist (feat. Archived)", []),
        ("Trashed track (feat. Guest)", []),
        ("10 ft Guest", []),
        ("Remixed (feat. Guest) (Radio Edit)", []),
        ("Wrong bracket (feat. Guest]", []),
        ("(feat. Guest)", []),
    ]
    names = ["Main", "Guest", "Guést", "Friend", "Guest & Friend", "Dupe", "DUPE ", "Archived"]
    return {"library": {
        "artists": {str(i): {"name": name, "trashed": name == "Archived"} for i, name in enumerate(names, 1)},
        "albums": {"10": {"name": "Alpha", "artist_id": 1, "tracks": list(range(1, 17))}},
        "tracks": {str(i): {"title": title, "artist_id": 1, "album_id": 10,
                            "artists_additional": credits, "trashed": i == 12}
                   for i, (title, credits) in enumerate(titles, 1)},
    }}


class ArtistCleanupTests(unittest.TestCase):
    def test_only_clear_missing_credits_in_active_tracks(self):
        library = Library(fixture())
        rows = library.guest_credit_rows
        self.assertEqual([row["track"]["id"] for row in rows], ["1", "2", "3"])
        self.assertEqual([row["track"]["guest"] for row in rows], ["Guest"] * 3)

    def test_current_snapshot_only_and_bounded_album_groups(self):
        raw = fixture()
        for i in range(50, 151):
            raw["library"]["albums"]["10"]["tracks"].append(i)
            raw["library"]["tracks"][str(i)] = {"title": f"Song {i} (feat. Guest)", "artist_id": 1, "album_id": 10}
        with self.subTest("loaded snapshot"), self._studio(raw) as studio:
            page = studio.artist_cleanup()
            self.assertEqual((page["total_tracks"], page["total_albums"], page["offset"]), (104, 1, 0))
            self.assertEqual(len(page["albums"][0]["tracks"]), 50)
            last = studio.artist_cleanup("999")
            self.assertEqual(last["offset"], 100)
            self.assertEqual([row["id"] for row in last["albums"][0]["tracks"]], ["147", "148", "149", "150"])
            studio.library = None
            with self.assertRaisesRegex(client.ApiError, "Load the library"):
                studio.artist_cleanup()

    def test_account_change_while_scanning_discards_the_result(self):
        with self._studio(fixture()) as studio:
            def replace_library(rows, offset):
                studio.playback_session = "new-session"
                return {}

            with patch("tagcast.client.guest_credit_page", side_effect=replace_library), self.assertRaises(ConflictError):
                studio.artist_cleanup()

    @staticmethod
    @contextmanager
    def _studio(raw):
        with TemporaryDirectory() as directory:
            studio = client.Studio(Path(directory))
            studio.client = object()
            studio.library, studio.library_user = Library(raw), "owner"
            with patch.object(studio, "_current", side_effect=AssertionError("No remote reads")):
                yield studio
