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
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import mock_ibroadcast  # noqa: E402

SERVER = ThreadingHTTPServer(("127.0.0.1", 0), mock_ibroadcast.H)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
os.environ["TAGCAST_IBROADCAST_BASE"] = f"http://127.0.0.1:{SERVER.server_port}"
os.environ.pop("IBROADCAST_CLIENT_ID", None)

from tagcast import client  # noqa: E402
from tagcast.library import ConflictError  # noqa: E402

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
        mock_ibroadcast.STATE["frozen"] = False
        mock_ibroadcast.STATE["tracks"][901]["artwork_id"] = 601

    def assertPrivate(self, path):
        if sys.platform != "win32":  # Windows has no owner-only file mode bits
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

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
        self.assertPrivate(tokens)
        self.assertTrue(client.Studio(self.home).status()["connected"])

    def local_connection(self):
        studio = client.Studio(self.home)
        studio.set_client_id("test")
        studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, "refresh-1", 0))
        return studio

    def run_paused(self, operation, helper, result, during):
        started, resume = threading.Event(), threading.Event()
        errors = []

        def paused(*args):
            started.set()
            if not resume.wait(5):
                raise TimeoutError("Test did not resume the request")
            return result

        def run():
            try:
                operation()
            except Exception as error:
                errors.append(error)

        with patch.object(client.auth, helper, side_effect=paused):
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            try:
                self.assertTrue(started.wait(5))
                during()
            finally:
                resume.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        return errors

    def test_late_refresh_after_logout_cannot_restore_tokens(self):
        studio = self.local_connection()
        tokens = client.oauth.TokenSet(mock_ibroadcast.TOKEN, "late-refresh", time.time() + 3600)
        errors = self.run_paused(studio.load_library, "refresh_access_token", tokens, studio.logout)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], client.NotConnected)
        self.assertIsNone(studio.client)
        self.assertFalse(Path(self.home, "tokens.json").exists())
        self.assertIsNone(client.Studio(self.home).client)

    def test_old_connection_refresh_cannot_overwrite_new_connection_tokens(self):
        studio = self.local_connection()
        old = studio.client
        tokens = client.oauth.TokenSet("late-access", "late-refresh", time.time() + 3600)
        replacement = client.oauth.TokenSet("new-access", "new-refresh", time.time() + 3600)
        self.assertEqual(self.run_paused(old._refresh, "refresh_access_token", tokens,
                                        lambda: studio._connect(replacement)), [])
        self.assertEqual(studio._read("tokens.json")["token_set"], replacement.to_dict())

    def test_disconnect_cancels_pending_browser_sign_in(self):
        studio = self.local_connection()
        url = studio.browser_url("http://127.0.0.1/callback")
        state = parse_qs(urlparse(url).query)["state"][0]
        studio.logout()
        with patch.object(client.auth, "exchange_auth_code") as exchange:
            with self.assertRaises(client.ApiError):
                studio.finish_browser("code", state)
            exchange.assert_not_called()

    def test_disconnect_during_browser_exchange_cannot_reconnect(self):
        studio = self.local_connection()
        url = studio.browser_url("http://127.0.0.1/callback")
        state = parse_qs(urlparse(url).query)["state"][0]
        tokens = client.oauth.TokenSet("late-access", "late-refresh", time.time() + 3600)
        errors = self.run_paused(lambda: studio.finish_browser("code", state),
                                 "exchange_auth_code", tokens, studio.logout)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], client.ApiError)
        self.assertIsNone(studio.client)
        self.assertFalse(Path(self.home, "tokens.json").exists())

    def test_browser_sign_in_is_one_use_and_persists_tokens(self):
        studio = self.local_connection()
        url = studio.browser_url("http://127.0.0.1/callback")
        state = parse_qs(urlparse(url).query)["state"][0]
        tokens = client.oauth.TokenSet("new-access", "new-refresh", time.time() + 3600)
        with patch.object(client.auth, "exchange_auth_code", return_value=tokens):
            studio.finish_browser("code", state)
            self.assertEqual(studio._read("tokens.json")["token_set"], tokens.to_dict())
            with self.assertRaises(client.ApiError):
                studio.finish_browser("code", state)

    def test_disconnect_during_device_code_request_cancels_sign_in(self):
        studio = self.local_connection()
        errors = self.run_paused(studio.start_device, "device_code_request",
                                 {"device_code": "test", "user_code": "test"}, studio.logout)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], client.ApiError)
        self.assertIsNone(studio.device)

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
        self.assertPrivate(path)
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
            "access_token": "stale", "refresh_token": "refresh-1", "expires_at": 0}}), encoding="utf-8")
        restored = client.Studio(self.home)
        self.assertTrue(restored.load_library())
        saved = json.loads(Path(self.home, "tokens.json").read_text(encoding="utf-8"))
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
        from tagcast.artwork import ArtworkError
        with self.assertRaises(ArtworkError):
            studio.change_artwork({"target": "artist", "id": "42", "before": {"artwork_id": current},
                                   "source": {"data": "data:image/png;base64,bm90IGFuIGltYWdl"}})
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_related_artwork_lists_images_ibroadcast_already_has(self):
        studio = self.connect()
        art = studio.related_artwork(album_id="72")["artwork"]
        self.assertEqual([a["artwork_id"] for a in art], [77, 78])
        self.assertTrue(art[0]["thumb"].endswith("/artwork/77-150"))
        studio.related_artwork(artist_id="42")  # asks with one of the artist's own tracks
        self.assertEqual(mock_ibroadcast.STATE["last_get_artwork"], {"track_id": 904, "artist_id": 42})

    def test_stream_passes_ranges_through_with_the_token_kept_server_side(self):
        studio = self.connect()
        studio.load_library()
        response, _mime = studio.stream("903", "bytes=10-19")
        with response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, mock_ibroadcast.AUDIO[10:20])
        from tagcast.library import LibraryError
        with self.assertRaises(LibraryError):
            studio.stream("902")  # trashed

    def test_source_keys_are_saved_privately_and_never_returned(self):
        studio = self.connect()
        settings = studio.save_settings({"discogs_token": "abc123", "auto_lookup": False})
        discogs = next(s for s in settings["sources"] if s["name"] == "discogs")
        self.assertTrue(discogs["enabled"])
        self.assertNotIn("abc123", json.dumps(settings))
        self.assertFalse(settings["auto_lookup"])
        self.assertPrivate(Path(self.home, "config.json"))
        studio.save_settings({"discogs_token": ""})
        self.assertNotIn("discogs_token", json.loads(Path(self.home, "config.json").read_text(encoding="utf-8")))

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

    def test_switching_combine_sets_downloads_the_library_again(self):
        studio = self.connect()
        self.assertEqual(studio.load_library()["source"], "download")
        self.wait_for_cache(studio)
        mock_ibroadcast.STATE["combine_sets"] = True  # lastmodified stays the same
        self.assertEqual(studio.load_library()["source"], "download")
        import gzip
        for _ in range(100):  # the cache is rewritten in the background
            cached = json.loads(gzip.decompress(Path(self.home, client.CACHE_FILE).read_bytes()))
            if cached.get("combine_sets") is True:
                break
            time.sleep(0.05)
        self.assertEqual(client.Studio(self.home).load_library()["source"], "cache")
        mock_ibroadcast.STATE["combine_sets"] = False
        self.assertEqual(client.Studio(self.home).load_library()["source"], "download")

    def test_read_back_downloads_even_when_lastmodified_did_not_change(self):
        studio = self.connect()
        track = studio.album_details(["74"])[0]["tracks"][0]
        downloads = mock_ibroadcast.STATE["downloads"]
        mock_ibroadcast.STATE["frozen"] = True
        result = studio.save([edit("track", track["id"], 74, genre=(track["genre"], track["genre"] + "?"))])
        job = self.wait_job(studio, result["job"])
        self.assertEqual([r["status"] for r in job["results"]], ["saved"])
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads + 1)

    def test_a_download_finishing_after_disconnect_is_thrown_away(self):
        studio = self.connect()
        old_client = studio.client
        studio.logout()
        from tagcast.client import NotConnected
        with self.assertRaises(NotConnected):
            studio._current(old_client, refresh=True)  # the download that was still running
        time.sleep(0.3)
        self.assertIsNone(studio.library)
        self.assertFalse(Path(self.home, client.CACHE_FILE).exists())

    def test_undo_restores_covers_and_explains_tracks_that_had_none(self):
        mock_ibroadcast.STATE["tracks"][901]["artwork_id"] = 0
        studio = self.connect()
        album = studio.album_details(["72"])[0]
        before = {"tracks": {t["id"]: t["artwork_id"] for t in album["tracks"]}}
        changed = studio.change_artwork({"target": "album", "id": "72", "label": "x", "before": before,
                                         "source": {"artwork_id": 77}})
        self.wait_job(studio, changed["job"])
        undo = studio.undo_artwork({"target": "album", "id": "72", "label": "x",
                                    "before": {"tracks": {"900": 77, "901": 77}},
                                    "previous": changed["previous"]})
        self.assertIn("1 track had no cover before", undo["note"])
        self.assertEqual(self.wait_job(studio, undo["job"])["results"][0]["status"], "saved")
        restored = {t["id"]: t["artwork_id"] for t in studio.album_details(["72"])[0]["tracks"]}
        self.assertEqual(restored, {"900": before["tracks"]["900"], "901": 77})

    def test_genres_round_trip_through_genres_additional(self):
        studio = self.connect()
        track = studio.album_details(["73"])[0]["tracks"][0]
        result = studio.save([edit("track", track["id"], 73, genres=(track["genres"], ["Art Pop", "Art Rock"]))])
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1]["tracks"],
                         [{"file_id": int(track["id"]), "genre": "Art Pop", "genres_additional": ["Art Rock"]}])
        self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
        self.assertEqual(studio.album_details(["73"])[0]["tracks"][0]["genres"], ["Art Pop", "Art Rock"])
        undo = studio.save([edit("track", track["id"], 73, genres=(["Art Pop", "Art Rock"], track["genres"]))])
        self.wait_job(studio, undo["job"])

    def test_album_only_artist_marked_trashed_still_gets_an_image(self):
        studio = self.connect()  # Pink Floyd (42) is marked trashed in the mock library
        current = studio.album_details(["74"])[0]["artist_artwork_id"]
        result = studio.change_artwork({"target": "artist", "id": "42", "label": "Pink Floyd",
                                        "before": {"artwork_id": current}, "source": {"artwork_id": 77}})
        self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
        self.assertIn("Pink Floyd", studio.load_library()["artists"])

    def test_composers_are_saved_next_to_other_extra_artists(self):
        mock_ibroadcast.STATE["tracks"][904]["additional"] = [[41, None, "artist"]]
        studio = self.connect()
        track = studio.album_details(["74"])[0]["tracks"][0]
        self.assertEqual(track["composers"], [])
        result = studio.save([edit("track", 904, 74, composers=([], ["Roger Waters", "Kate Bush"]))])
        self.assertEqual(result["created_artists"], ["Roger Waters"])
        new_id = mock_ibroadcast.STATE["next_artist"]
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1]["tracks"], [{"file_id": 904, "artists_additional": [
            {"artist_id": 41, "type": "artist"}, {"artist_id": new_id, "type": "composer"},
            {"artist_id": 41, "type": "composer"}]}])
        self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
        self.assertEqual(studio.album_details(["74"])[0]["tracks"][0]["composers"], ["Roger Waters", "Kate Bush"])
        mock_ibroadcast.STATE["tracks"][904]["additional"] = []


if __name__ == "__main__":
    unittest.main()
