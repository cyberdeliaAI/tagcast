"""Overview: account details without secrets, and library statistics."""

import json
import unittest

from tagcast.client import account_view, mask_email
from tagcast.library import Library

STATUS = {
    "user": {
        "username": "listener", "email_address": "someone@example.com", "verified": True,
        "verified_on": "2021-11-28 19:00:00", "premium": True, "tester": False, "token": "SECRET-TOKEN",
        "preferences": {"bitratepref": "orig", "onequeue": "0", "combine_sets": "1"},
        "profiles": [{"settings": {"artistimages": True, "replaygain": False}}],
        "subscription": {"started_on": "2022-01-01", "due_on": "2027-01-01", "canceled": False,
                         "expired": False, "plan": {"name": "Premium", "frequency": "yearly"},
                         "payment_method": {"details": "Visa 4242", "name": "SECRET-CARD"}},
        "session": {"remote_addr": "203.0.113.9", "sessions": [{"remote_addr": "203.0.113.10"}]},
    },
    "status": {"plays": 253, "available": 4, "achievement_status": {"1": {}, "2": {}},
               "lastmodified": "2026-10-04 15:00:00"},
    "lastfm": {"linked": True, "user": "kaos", "sessionkey": "SECRET-LASTFM"},
    "dropbox": {"linked": False}, "googledrive": {"linked": True},
    "messages": [{"message": "SECRET-SUPPORT-MESSAGE"}],
}


class AccountTests(unittest.TestCase):
    def test_secrets_and_personal_details_are_left_out(self):
        text = json.dumps(account_view(STATUS))
        for secret in ("SECRET", "203.0.113", "someone@", "Visa"):
            self.assertNotIn(secret, text)

    def test_account_details(self):
        a = account_view(STATUS)
        self.assertEqual(a["email"], "s•••••@example.com")
        self.assertEqual((a["plays"], a["achievements"], a["verified_on"]), (253, 2, "2021-11-28"))
        self.assertEqual(a["preferences"], {"bitrate": "orig", "one_queue": False, "combine_sets": True,
                                            "artist_images": True, "replay_gain": False})
        self.assertEqual(a["linked"], {"lastfm": "kaos", "dropbox": False, "googledrive": True})
        self.assertEqual(a["subscription"]["name"], "Premium")

    def test_partial_answers_do_not_break(self):
        self.assertEqual(account_view({})["username"], "")
        self.assertEqual(mask_email("not-an-email"), "")


class StatsTests(unittest.TestCase):
    def library(self):
        tmap = {"title": 0, "album_id": 1, "artist_id": 2, "genre": 3, "trashed": 4, "artwork_id": 5,
                "size": 6, "length": 7, "type": 8, "uploaded_on": 9, "plays": 10, "rating": 11}
        return Library({"library": {
            "artists": {"map": {"name": 0, "artwork_id": 1}, "4": ["A", 9], "5": ["B", 0]},
            "albums": {"map": {"name": 0, "artist_id": 1, "tracks": 2, "year": 3},
                       "10": ["One", 4, [100, 101], 1990], "11": ["Two", 5, [102, 103], 0]},
            "tracks": {"map": tmap,
                       "100": ["a", 10, 4, "Rock", False, 1, 1000, 60, "audio/flac", "2022-01-02", 5, 0],
                       "101": ["b", 10, 4, "", False, 1, 1000, 60, "audio/flac", "2024-03-04", 0, 5],
                       "102": ["c", 11, 5, "Pop", False, 0, 500, 30, "audio/mpeg", "2022-05-06", 2, 0],
                       "103": ["gone", 11, 5, "", True, 0, 500, 30, "audio/mpeg", "2022-05-06", 9, 0]},
            "playlists": {"map": {}, "1": [], "2": []},
        }})

    def test_counts_sizes_and_health_skip_the_trash(self):
        s = self.library().stats()
        self.assertEqual((s["tracks"], s["albums"], s["playlists"], s["size"], s["length"]), (3, 2, 2, 2500, 150))
        self.assertEqual(s["health"]["genre"], {"missing": 1, "total": 3})
        self.assertEqual(s["health"]["year"], {"missing": 1, "total": 2})
        self.assertEqual(s["health"]["artist_image"], {"missing": 1, "total": 2})
        self.assertEqual(s["formats"][0], {"name": "FLAC", "tracks": 2, "size": 2000})
        self.assertEqual(s["uploads"], [{"year": 2022, "tracks": 2}, {"year": 2023, "tracks": 0},
                                        {"year": 2024, "tracks": 1}])

    def test_most_played(self):
        s = self.library().stats()
        self.assertEqual([t["title"] for t in s["top_tracks"]], ["a", "c"])
        self.assertEqual([a["album"] for a in s["top_albums"]], ["One", "Two"])
        self.assertEqual(s["top_artists"][0], {"plays": 5, "artist": "A"})
        self.assertEqual(s["rated"], 1)

    def test_playlist_count_survives_the_cache(self):
        library = self.library()
        self.assertEqual(Library(library.to_cache()).playlist_count, 2)


if __name__ == "__main__":
    unittest.main()
