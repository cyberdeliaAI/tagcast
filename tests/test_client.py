"""Client tests against the in-process fake iBroadcast in mock_ibroadcast.py."""

import importlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import mock_ibroadcast  # noqa: E402

SERVER = ThreadingHTTPServer(("127.0.0.1", 0), mock_ibroadcast.H)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
os.environ["LIBRARY_STUDIO_IBROADCAST_BASE"] = f"http://127.0.0.1:{SERVER.server_port}"
os.environ.pop("IBROADCAST_CLIENT_ID", None)

from ibroadcast_editor import client  # noqa: E402
from ibroadcast_editor.library import ConflictError  # noqa: E402

client = importlib.reload(client)  # pick up the test base URL even if imported earlier


def edit(kind, item_id, album_id, **fields):
    return {"kind": kind, "id": str(item_id), "albumId": str(album_id), "label": "x",
            "fields": {k: {"before": b, "after": a} for k, (b, a) in fields.items()}}


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        mock_ibroadcast.STATE["polls"] = 0
        mock_ibroadcast.STATE["downloads"] = 0
        mock_ibroadcast.STATE["writes"].clear()
        mock_ibroadcast.STATE["uploads"].clear()
        mock_ibroadcast.STATE["combine_sets"] = False
        mock_ibroadcast.STATE["busy"] = 0

    def connect(self):
        studio = client.Studio(self.home)
        studio.set_client_id("test")
        studio.start_device()
        for _ in range(100):
            if studio.status()["connected"]:
                return studio
            time.sleep(0.1)
        self.fail(f"device login did not finish: {studio.device}")

    def test_device_login_persists_private_tokens(self):
        studio = self.connect()
        self.assertEqual(studio.status()["account"], "wilfred")
        tokens = Path(self.home, "tokens.json")
        self.assertEqual(tokens.stat().st_mode & 0o777, 0o600)
        self.assertTrue(client.Studio(self.home).status()["connected"])

    def wait_for_cache(self, studio):
        with studio.cache_lock:  # the cache is written in the background
            pass
        for _ in range(50):
            if Path(self.home, client.CACHE_FILE).exists():
                return
            time.sleep(0.05)
        self.fail("cache was not written")

    def wait_job(self, studio, job_id):
        for _ in range(100):
            job = studio.job(job_id)
            if job["state"] != "checking":
                return job
            time.sleep(0.05)
        self.fail("read-back did not finish")

    def test_save_writes_and_reads_back(self):
        studio = self.connect()
        studio.load_library()
        before = studio.album_details(["74"])[0]["tracks"][0]
        downloads = mock_ibroadcast.STATE["downloads"]
        result = studio.save([edit("track", 904, 74, genre=(before["genre"], "Psychedelic Rock"),
                                   track=(before["track"], 5))])
        self.assertEqual([r["status"] for r in result["results"]], ["sent"])
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1]["tracks"],
                         [{"file_id": 904, "genre": "Psychedelic Rock", "track_no": 5}])
        job = self.wait_job(studio, result["job"])
        self.assertEqual([r["status"] for r in job["results"]], ["saved"])
        # unchanged since loading: no download before writing, one to read back
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads + 1)
        album = next(a for a in job["albums"] if a["id"] == "74")
        self.assertEqual(album["genres"], ["Psychedelic Rock"])
        self.assertNotIn("tracks", album)

    def test_next_save_waits_for_the_read_back_instead_of_downloading_again(self):
        studio = self.connect()
        before = studio.album_details(["73"])[0]
        first = studio.save([edit("album", 73, 73, disc=(before["disc"], before["disc"] + 1))])
        second = studio.save([edit("album", 73, 73, disc=(before["disc"] + 1, before["disc"]))])
        self.assertEqual([r["status"] for r in second["results"]], ["sent"])
        self.wait_job(studio, first["job"])
        self.wait_job(studio, second["job"])
        # initial load, read-back of the first save (reused by the second), read-back of the second
        self.assertEqual(mock_ibroadcast.STATE["downloads"], 3)

    def test_library_is_downloaded_only_when_ibroadcast_changed(self):
        studio = self.connect()
        first = studio.load_library()
        self.assertEqual((first["source"], mock_ibroadcast.STATE["downloads"]), ("download", 1))
        self.assertEqual(studio.load_library()["source"], "memory")
        self.wait_for_cache(studio)

        restarted = client.Studio(self.home)
        self.assertEqual(restarted.load_library()["source"], "cache")
        self.assertEqual(mock_ibroadcast.STATE["downloads"], 1)

        import urllib.request
        urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{SERVER.server_port}/_edit_elsewhere", data=b"", method="POST"))
        self.assertEqual(restarted.load_library()["source"], "download")
        self.assertEqual(restarted.load_library(refresh=True)["source"], "download")
        self.assertEqual(mock_ibroadcast.STATE["downloads"], 3)

    def test_cache_is_private_and_keeps_no_account_secrets(self):
        studio = self.connect()
        studio.load_library()
        self.wait_for_cache(studio)
        path = Path(self.home, client.CACHE_FILE)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        import gzip
        data = gzip.decompress(path.read_bytes()).decode()
        self.assertNotIn("secret-lastfm-session", data)
        self.assertNotIn("lastfm", data)
        studio.logout()
        self.assertFalse(path.exists())

    def test_conflict_from_another_app_is_caught_with_a_cached_library(self):
        studio = self.connect()
        year = studio.album_details(["73"])[0]["year"]
        import urllib.request
        urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{SERVER.server_port}/_edit_elsewhere", data=b"", method="POST"))
        with self.assertRaises(ConflictError):
            studio.save([edit("album", 73, 73, year=(year, 1990))])
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_conflict_writes_nothing(self):
        studio = self.connect()
        with self.assertRaises(ConflictError):
            studio.save([edit("album", 74, 74, name=("Not the current name", "X"))])
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_expired_token_is_refreshed(self):
        studio = self.connect()
        Path(self.home, "tokens.json").write_text(json.dumps({"client_id": "test", "token_set": {
            "access_token": "stale", "refresh_token": "refresh-1", "expires_at": 0}}))
        restored = client.Studio(self.home)
        self.assertTrue(restored.load_library())
        saved = json.loads(Path(self.home, "tokens.json").read_text())
        self.assertEqual(saved["token_set"]["access_token"], mock_ibroadcast.TOKEN)
        del studio

    def test_album_cover_is_uploaded_applied_checked_and_undone(self):
        studio = self.connect()
        album = studio.album_details(["72"])[0]
        before = {"tracks": {t["id"]: t["artwork_id"] for t in album["tracks"]}}
        result = studio.change_artwork({
            "target": "album", "id": "72", "label": "Hounds of Love", "before": before,
            "source": {"url": f"http://127.0.0.1:{SERVER.server_port}/image.png"}})
        new_id = result["artwork_id"]
        self.assertIn(b'filename="image.png"', mock_ibroadcast.STATE["uploads"][-1])
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1],
                         {**mock_ibroadcast.STATE["writes"][-1], "mode": "set_artwork",
                          "tracks": [900, 901], "artwork_id": new_id})
        job = self.wait_job(studio, result["job"])
        self.assertEqual(job["results"][0]["status"], "saved")
        self.assertEqual(result["previous"], before)

        undo = studio.undo_artwork({"target": "album", "id": "72", "label": "x",
                                    "before": {"tracks": {"900": new_id, "901": new_id}},
                                    "previous": result["previous"]})
        self.assertEqual(self.wait_job(studio, undo["job"])["results"][0]["status"], "saved")
        restored = studio.album_details(["72"])[0]["tracks"]
        self.assertEqual({t["id"]: t["artwork_id"] for t in restored}, before["tracks"])

    def test_artist_image_from_an_uploaded_file(self):
        studio = self.connect()
        import base64
        data = "data:image/png;base64," + base64.b64encode(mock_ibroadcast.PNG).decode()
        current = studio.album_details(["74"])[0]["artist_artwork_id"]
        result = studio.change_artwork({"target": "artist", "id": "42", "label": "Pink Floyd",
                                        "before": {"artwork_id": current},
                                        "source": {"data": data, "name": "floyd.png"}})
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1]["mode"], "set_artist_artwork")
        self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
        self.assertEqual(studio.album_details(["74"])[0]["artist_artwork_id"], result["artwork_id"])

    def test_artwork_conflict_and_bad_images_write_nothing(self):
        studio = self.connect()
        with self.assertRaises(ConflictError):
            studio.change_artwork({"target": "artist", "id": "42", "before": {"artwork_id": 1},
                                   "source": {"artwork_id": 77}})
        current = studio.album_details(["74"])[0]["artist_artwork_id"]
        from ibroadcast_editor.artwork import ArtworkError
        with self.assertRaises(ArtworkError):
            studio.change_artwork({"target": "artist", "id": "42", "before": {"artwork_id": current},
                                   "source": {"data": "data:image/png;base64,bm90IGFuIGltYWdl"}})
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_related_artwork_lists_images_ibroadcast_already_has(self):
        studio = self.connect()
        art = studio.related_artwork(album_id="72")["artwork"]
        self.assertEqual([a["artwork_id"] for a in art], [77, 78])
        self.assertTrue(art[0]["thumb"].endswith("/artwork/77-150"))

    def test_stream_passes_ranges_through_with_the_token_kept_server_side(self):
        studio = self.connect()
        studio.load_library()
        response, _mime = studio.stream("903", "bytes=10-19")
        with response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, mock_ibroadcast.AUDIO[10:20])
        from ibroadcast_editor.library import LibraryError
        with self.assertRaises(LibraryError):
            studio.stream("902")  # trashed

    def test_source_keys_are_saved_privately_and_never_returned(self):
        studio = self.connect()
        settings = studio.save_settings({"discogs_token": "abc123", "auto_lookup": False})
        discogs = next(s for s in settings["sources"] if s["name"] == "discogs")
        self.assertTrue(discogs["enabled"])
        self.assertNotIn("abc123", json.dumps(settings))
        self.assertFalse(settings["auto_lookup"])
        self.assertEqual(Path(self.home, "config.json").stat().st_mode & 0o777, 0o600)
        studio.save_settings({"discogs_token": ""})
        self.assertNotIn("discogs_token", json.loads(Path(self.home, "config.json").read_text()))

    def test_album_changes_wait_while_combine_sets_is_on_but_tracks_are_saved(self):
        mock_ibroadcast.STATE["combine_sets"] = True
        studio = self.connect()
        album = studio.album_details(["74"])[0]
        track = album["tracks"][0]
        result = studio.save([edit("album", 74, 74, year=(album["year"], album["year"] + 1)),
                              edit("track", track["id"], 74, genre=(track["genre"], track["genre"] + "!"))])
        self.assertEqual({r["kind"]: r["status"] for r in result["results"]},
                         {"album": "blocked", "track": "sent"})
        self.assertIn("Combine Multi-Disc Album Sets", result["error"])
        self.assertEqual([w["mode"] for w in mock_ibroadcast.STATE["writes"]], ["update_track"])
        job = self.wait_job(studio, result["job"])
        self.assertEqual({r["kind"]: r["status"] for r in job["results"]},
                         {"album": "blocked", "track": "saved"})
        self.assertTrue(studio.status()["combine_sets"])

    def test_a_busy_ibroadcast_is_retried(self):
        studio = self.connect()
        track = studio.album_details(["74"])[0]["tracks"][0]
        mock_ibroadcast.STATE["busy"] = 2
        original = client.RETRY_DELAYS
        client.RETRY_DELAYS = (0, 0)
        try:
            result = studio.save([edit("track", track["id"], 74, genre=(track["genre"], "Retried"))])
        finally:
            client.RETRY_DELAYS = original
        self.assertEqual([r["status"] for r in result["results"]], ["sent"])
        self.assertEqual(len(mock_ibroadcast.STATE["writes"]), 1)


if __name__ == "__main__":
    unittest.main()
