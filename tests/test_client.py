"""Client tests against the in-process fake iBroadcast in mock_ibroadcast.py."""

import copy
import importlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
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
        mock_ibroadcast.STATE["play_requests"].clear()
        mock_ibroadcast.STATE["recent_tracks"].clear()
        mock_ibroadcast.STATE["uploads"].clear()
        mock_ibroadcast.STATE["combine_sets"] = False
        mock_ibroadcast.STATE["busy"] = 0
        mock_ibroadcast.STATE["frozen"] = False
        mock_ibroadcast.STATE["tracks"][901]["artwork_id"] = 601
        mock_ibroadcast.STATE["tracks"][901]["trashed"] = False
        for track in mock_ibroadcast.STATE["tracks"].values():
            track["rating"] = 0

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

    def test_fresh_settings_use_public_client_without_configuration(self):
        studio = client.Studio(self.home)
        self.assertEqual(studio.client_id, client.DEFAULT_CLIENT_ID)
        self.assertTrue(studio.status()["configured"])
        self.assertTrue(studio.status()["using_default_client"])
        self.assertFalse(studio.status()["connected"])
        self.assertFalse(Path(self.home, "config.json").exists())
        code = {"device_code": "test-device", "user_code": "TEST-CODE"}
        for queue in (False, True):
            with self.subTest(queue=queue):
                studio.config["queue_sync"] = queue
                with patch.object(client.auth, "device_code_request", return_value=code) as request, \
                        patch.object(client.threading.Thread, "start"):
                    studio.start_device()
                request.assert_called_once_with(client.DEFAULT_CLIENT_ID,
                                                 client.SCOPES + (client.QUEUE_SCOPES if queue else []))
        self.assertFalse(Path(self.home, "tokens.json").exists())

    def test_existing_client_and_session_are_not_migrated(self):
        self.connect()
        config = Path(self.home, "config.json").read_bytes()
        tokens = Path(self.home, "tokens.json").read_bytes()
        studio = client.Studio(self.home)
        self.assertEqual(studio.client_id, "test")
        self.assertTrue(studio.status()["connected"])
        self.assertFalse(studio.status()["using_default_client"])
        self.assertEqual(Path(self.home, "config.json").read_bytes(), config)
        self.assertEqual(Path(self.home, "tokens.json").read_bytes(), tokens)

    def test_environment_client_still_overrides_saved_client(self):
        studio = client.Studio(self.home)
        studio.set_client_id("saved-client")
        config = Path(self.home, "config.json").read_bytes()
        with patch.dict(os.environ, {"IBROADCAST_CLIENT_ID": "environment-client"}):
            studio = client.Studio(self.home)
            self.assertEqual(studio.client_id, "environment-client")
            self.assertTrue(studio.status()["client_id_from_env"])
            self.assertFalse(studio.status()["using_default_client"])
        self.assertEqual(Path(self.home, "config.json").read_bytes(), config)

    def test_public_client_tokens_resume_without_a_saved_client_override(self):
        studio = client.Studio(self.home)
        studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, "refresh-1", time.time() + 3600))
        tokens = Path(self.home, "tokens.json").read_bytes()
        restored = client.Studio(self.home)
        self.assertTrue(restored.status()["connected"])
        self.assertTrue(restored.status()["using_default_client"])
        self.assertEqual(restored.client._client_id, client.DEFAULT_CLIENT_ID)
        self.assertEqual(Path(self.home, "tokens.json").read_bytes(), tokens)
        self.assertFalse(Path(self.home, "config.json").exists())

    def test_switch_to_public_client_requires_disconnect_and_preserves_preferences(self):
        studio = self.connect()
        tokens = Path(self.home, "tokens.json").read_bytes()
        with self.assertRaisesRegex(client.ApiError, "Disconnect"):
            studio.use_default_client()
        self.assertEqual(studio.client_id, "test")
        self.assertEqual(Path(self.home, "tokens.json").read_bytes(), tokens)
        studio.config["record_plays"] = True
        studio.logout()
        studio.device = {"state": "pending"}
        studio.use_default_client()
        self.assertIsNone(studio.device)
        self.assertEqual(studio.client_id, client.DEFAULT_CLIENT_ID)
        self.assertNotIn("client_id", studio._read("config.json"))
        self.assertTrue(studio._read("config.json")["record_plays"])
        self.assertFalse(Path(self.home, "tokens.json").exists())
        self.assertTrue(client.Studio(self.home).status()["using_default_client"])

    def test_switch_to_public_client_cannot_override_environment(self):
        studio = client.Studio(self.home)
        studio.set_client_id("saved-client")
        config = Path(self.home, "config.json").read_bytes()
        with patch.dict(os.environ, {"IBROADCAST_CLIENT_ID": "environment-client"}):
            with self.assertRaisesRegex(client.ApiError, "IBROADCAST_CLIENT_ID"):
                studio.use_default_client()
        self.assertEqual(Path(self.home, "config.json").read_bytes(), config)

    def local_connection(self):
        studio = client.Studio(self.home)
        studio.set_client_id("test")
        studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, "refresh-1", 0))
        return studio

    def test_album_artist_cleanup_round_trips_native_album_credits_over_http(self):
        with patch.dict(mock_ibroadcast.STATE, copy.deepcopy(mock_ibroadcast.STATE)):
            remote = mock_ibroadcast.STATE
            remote["artists"][44] = "Kate Bush;Pink Floyd"
            remote["albums"][73].update(artist_id=44, additional=[[43, "with", "band"]])
            before_tracks = copy.deepcopy(remote["tracks"])
            studio = self.connect()
            preview = studio.cleanup.prepare("album-artists")
            self.assertEqual((preview["albums"], preview["tracks"]), (1, 1))
            self.assertEqual(remote["writes"], [])
            studio.cleanup.start(preview["id"], [])
            for _ in range(500):
                if not studio.cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.cleanup.running)
            self.assertEqual(studio.cleanup.view()["counts"], {"confirmed": 1})
            self.assertEqual([w["mode"] for w in remote["writes"]], ["update_album"])
            self.assertEqual(remote["writes"][0]["albums"], [{
                "album_id": 73, "artist_id": 41, "artists_additional": [
                    {"artist_id": 43, "type": "band", "phrase": "with"}]}])
            self.assertEqual(remote["tracks"], before_tracks)
            details = studio.album_details(["73"])[0]
            self.assertEqual([a["id"] for a in details["album_artists"]], ["41", "43"])
            self.assertPrivate(Path(self.home, "cleanup.json"))

    def test_cleanup_uses_checked_native_genres_and_credits_over_http(self):
        original = copy.deepcopy(mock_ibroadcast.STATE)
        try:
            # Earlier save tests change this shared server's genre; use an exact
            # removal fixture so this flow does not depend on test order.
            mock_ibroadcast.STATE["tracks"][904]["genre"] = "Rock"
            mock_ibroadcast.STATE["tracks"][904]["genres_additional"] = []
            mock_ibroadcast.STATE["version"] += 1
            studio = self.local_connection()
            preview = studio.cleanup.prepare("genres")
            self.assertEqual(mock_ibroadcast.STATE["writes"], [])
            studio.cleanup.start(preview["id"], [])
            for _ in range(300):
                if not studio.cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.cleanup.running)
            self.assertEqual(studio.cleanup.view()["state"], "done")
            self.assertEqual(mock_ibroadcast.STATE["tracks"][903]["genres_additional"], ["New Wave"])
            self.assertPrivate(Path(self.home, "cleanup.json"))
            preview = studio.cleanup.prepare("genre-labels", "New Wave", ["Synth Pop", "Films/Games"])
            writes = len(mock_ibroadcast.STATE["writes"])
            self.assertEqual(preview["tracks"], 1)
            studio.cleanup.start(preview["id"], [])
            for _ in range(300):
                if not studio.cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.cleanup.running)
            self.assertEqual(studio.cleanup.view()["counts"], {"confirmed": 1})
            self.assertEqual(len(mock_ibroadcast.STATE["writes"]), writes + 1)
            self.assertEqual(mock_ibroadcast.STATE["tracks"][903]["genre"], "Art Pop")
            self.assertEqual(mock_ibroadcast.STATE["tracks"][903]["genres_additional"], ["Synth Pop", "Films/Games"])
            preview = studio.cleanup.prepare("genre-labels", "Rock", [], remove=True)
            studio.cleanup.start(preview["id"], [])
            for _ in range(300):
                if not studio.cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.cleanup.running)
            self.assertEqual(studio.cleanup.view()["counts"], {"confirmed": 1})
            self.assertEqual(mock_ibroadcast.STATE["tracks"][904]["genre"], "")
            self.assertEqual(mock_ibroadcast.STATE["tracks"][904]["genres_additional"], [])
            mock_ibroadcast.STATE["artists"][99] = "SBB;10cc"
            mock_ibroadcast.STATE["tracks"][900]["artist_id"] = 99
            mock_ibroadcast.STATE["version"] += 1
            preview = studio.cleanup.prepare("track-artists")
            studio.cleanup.start(preview["id"], [])
            for _ in range(300):
                if not studio.cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.cleanup.running)
            self.assertEqual(studio.cleanup.view()["counts"], {"confirmed": 1})
            library, _ = studio._library()
            self.assertEqual([p["name"] for p in library.track_view(900)["performers"]], ["SBB", "10cc"])
            self.wait_for_cache(studio)
        finally:
            mock_ibroadcast.STATE.clear()
            mock_ibroadcast.STATE.update(original)

    def test_browse_is_read_only_and_validates_group_paging(self):
        studio = self.local_connection()
        groups = studio.browse("track-artists")
        self.assertEqual(groups["count"], 2)
        self.assertEqual(studio.browse("decades", key="1980")["album_ids"], ["72", "73"])
        self.assertEqual(studio.browse("track-artists", key="41")["album_ids"], ["72", "73"])
        self.assertEqual(studio.browse("genres", query="Art")["groups"][0]["label"], "Art Pop;New Wave")
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        for kwargs in ({"kind": "bad"}, {"kind": "genres", "offset": "-1"},
                       {"kind": "genres", "limit": "999"}, {"kind": "genres", "limit": "bad"},
                       {"kind": "genres", "query": "x" * 201}, {"kind": "genres", "sort": "bad"}):
            with self.assertRaises(client.ApiError):
                studio.browse(**kwargs)
        studio.logout()
        with self.assertRaises(client.ApiError):
            studio.browse("track-artists")

    def test_favourites_write_one_native_rating_and_read_back_even_with_frozen_timestamp(self):
        studio = self.local_connection()
        mock_ibroadcast.STATE["tracks"][903]["rating"] = 3
        studio.load_library()
        mock_ibroadcast.STATE["frozen"] = True
        result = studio.favourite({"track_id": "900", "before": 0, "rating": 5})
        self.assertEqual(result["status"], "sent")
        job = self.wait_job(studio, result["job"])
        self.assertEqual(job["results"], [{"id": "900", "rating": 5, "status": "saved"}])
        self.assertNotIn("albums", job)  # rating read-back does not send all album summaries
        write = mock_ibroadcast.STATE["writes"][-1]
        self.assertEqual((write["mode"], write["track_id"], write["rating"]), ("ratetrack", [900], 5))
        self.assertEqual(mock_ibroadcast.STATE["tracks"][903]["rating"], 3)
        self.assertEqual([t["id"] for t in studio.favourites()["tracks"]], ["900"])
        removed = studio.favourite({"track_id": "900", "before": 5, "rating": 0})
        self.assertEqual(self.wait_job(studio, removed["job"])["results"][0]["status"], "saved")
        self.assertEqual(studio.favourites()["count"], 0)
        self.wait_for_cache(studio)
        restored = client.Studio(self.home)
        self.assertEqual(restored.album_details([72])[0]["tracks"][0]["rating"], 0)

    def test_favourite_detects_changed_rating_before_writing_and_excludes_trash(self):
        studio = self.local_connection()
        studio.load_library()
        mock_ibroadcast.STATE["tracks"][900]["rating"] = 2
        mock_ibroadcast.STATE["version"] += 1
        with self.assertRaises(ConflictError):
            studio.favourite({"track_id": "900", "before": 0, "rating": 5})
        for body in [{"track_id": "902", "before": 0, "rating": 5},
                     {"track_id": "900", "before": 2, "rating": 4},
                     {"track_id": "900", "before": True, "rating": 5}]:
            with self.subTest(body=body), self.assertRaises((client.ApiError, client.LibraryError)):
                studio.favourite(body)
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_favourite_requires_connection_and_surfaces_refused_write(self):
        studio = client.Studio(self.home)
        with self.assertRaises(client.NotConnected):
            studio.favourites()
        with self.assertRaises(client.NotConnected):
            studio.favourite({"track_id": "900", "before": 0, "rating": 5})
        studio = self.local_connection()
        mock_ibroadcast.STATE["reject"].add("ratetrack")
        try:
            with self.assertRaises(client.ApiError):
                studio.favourite({"track_id": "900", "before": 0, "rating": 5})
            self.assertEqual(mock_ibroadcast.STATE["tracks"][900]["rating"], 0)
            self.assertFalse(studio.jobs)
        finally:
            mock_ibroadcast.STATE["reject"].discard("ratetrack")

    def test_favourite_read_back_does_not_claim_success_for_an_unchanged_rating(self):
        studio = self.local_connection()
        studio.load_library()
        with patch.object(studio.client, "_jsonrequest", wraps=studio.client._jsonrequest) as request:
            original = request._mock_wraps
            request.side_effect = lambda mode, **body: {"result": True} if mode == "ratetrack" else original(mode, **body)
            result = studio.favourite({"track_id": "900", "before": 0, "rating": 5})
            job = self.wait_job(studio, result["job"])
        self.assertEqual(job["results"], [{"id": "900", "rating": 0, "status": "unverified"}])

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

    def test_concurrent_library_status_and_stream_refresh_once_over_http(self):
        studio = self.local_connection()
        transport = studio.client
        begin = threading.Barrier(3)
        errors, results = [], []

        def run(kind):
            try:
                begin.wait(5)
                if kind == "library":
                    results.append((kind, transport.fetch_library().artist_name(41)))
                elif kind == "status":
                    results.append((kind, transport._jsonrequest("status")["user"]["id"]))
                else:
                    with transport.open_stream("/128/abc/903", 903, "7", 1999999999, "bytes=10-19") as stream:
                        results.append((kind, (stream.status_code, stream.headers["Content-Range"], stream.content)))
            except Exception as error:
                errors.append(error)

        with patch.object(client.auth, "refresh_access_token", wraps=client.auth.refresh_access_token) as refresh:
            workers = [threading.Thread(target=run, args=(kind,), daemon=True)
                       for kind in ("library", "status", "stream")]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(5)
            self.assertFalse(any(worker.is_alive() for worker in workers))
            self.assertEqual(errors, [])
            refresh.assert_called_once_with("test", "refresh-1")
        result = dict(results)
        self.assertEqual(result["library"], "Kate Bush")
        self.assertEqual(str(result["status"]), "7")
        self.assertEqual(result["stream"], (206, f"bytes 10-19/{len(mock_ibroadcast.AUDIO)}", mock_ibroadcast.AUDIO[10:20]))
        self.assertEqual(studio._read("tokens.json")["token_set"], transport.token_set.to_dict())
        self.assertPrivate(Path(self.home, "tokens.json"))

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
        undo = studio.undo_artwork({"target": "artist", "id": "42", "label": "Pink Floyd",
                                    "before": {"artwork_id": result["artwork_id"]},
                                    "previous": result["previous"]})
        self.assertEqual(self.wait_job(studio, undo["job"])["results"][0]["status"], "saved")
        self.assertEqual(studio.album_details(["74"])[0]["artist_artwork_id"], current)

    def test_artist_undo_without_a_previous_image_is_rejected_without_a_write(self):
        studio = self.connect()
        current = studio.album_details(["72"])[0]["artist_artwork_id"]
        result = studio.change_artwork({"target": "artist", "id": "41", "label": "Kate Bush",
                                        "before": {"artwork_id": current},
                                        "source": {"artwork_id": 77}})
        self.wait_job(studio, result["job"])
        writes = len(mock_ibroadcast.STATE["writes"])
        try:
            with self.assertRaisesRegex(client.ApiError, "no artist image before"):
                studio.undo_artwork({"target": "artist", "id": "41", "label": "Kate Bush",
                                     "before": {"artwork_id": result["artwork_id"]},
                                     "previous": {"artwork_id": 0}})
            self.assertEqual(len(mock_ibroadcast.STATE["writes"]), writes)
            self.assertEqual(studio.album_details(["72"])[0]["artist_artwork_id"], 77)
        finally:
            mock_ibroadcast.STATE["artist_art"][41] = current

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

    def test_update_preferences_persist_without_an_account_and_never_remove_source_keys(self):
        studio = client.Studio(self.home)
        self.assertTrue(studio.settings()["auto_updates"])
        studio.save_settings({"discogs_token": "keep-this-key", "auto_updates": False})
        self.assertFalse(client.Studio(self.home).settings()["auto_updates"])
        self.assertPrivate(Path(self.home, "config.json"))
        self.assertEqual(studio.config["discogs_token"], "keep-this-key")
        with patch.object(studio.updates, "check", return_value={"state": "disabled"}) as check:
            studio.check_updates()
            check.assert_called_once_with(enabled=False, manual=False)
        for bad in ("false", 0, None):
            with self.assertRaises(client.ApiError):
                studio.save_settings({"auto_updates": bad})

    def test_source_selection_persists_without_account_preserving_keys_and_other_settings(self):
        studio = client.Studio(self.home)
        settings = studio.save_settings({"discogs_token": "keep-source-key", "auto_lookup": False,
                                         "disabled_sources": ["deezer", "itunes", "discogs"]})
        rows = {row["name"]: row for row in settings["sources"]}
        for name in ("deezer", "itunes", "discogs"):
            self.assertFalse(rows[name]["enabled"])
            self.assertFalse(rows[name]["selected"])
        self.assertTrue(rows["discogs"]["available"])
        self.assertNotIn("keep-source-key", json.dumps(settings))
        restarted = client.Studio(self.home)
        self.assertEqual(restarted.disabled_sources(), ["deezer", "itunes", "discogs"])
        restarted.save_settings({"auto_updates": False})
        self.assertEqual(restarted.disabled_sources(), ["deezer", "itunes", "discogs"])
        with patch.object(restarted.lookup.http, "json", side_effect=AssertionError("No provider read")):
            from tagcast.sources import SourceError
            with self.assertRaisesRegex(SourceError, "disabled"):
                restarted.lookup_album("deezer", artist="Artist", album="Album")
            with self.assertRaisesRegex(SourceError, "disabled"):
                restarted.lookup_artist("discogs", "Artist")
        restored = restarted.save_settings({"disabled_sources": []})
        self.assertTrue(next(s for s in restored["sources"] if s["name"] == "discogs")["enabled"])
        self.assertEqual(restarted.config["discogs_token"], "keep-source-key")
        self.assertFalse(restored["auto_lookup"])
        self.assertPrivate(Path(self.home, "config.json"))
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_invalid_source_preferences_do_not_partially_change_or_persist_settings(self):
        studio = client.Studio(self.home)
        studio.save_settings({"disabled_sources": ["deezer"]})
        original = Path(self.home, "config.json").read_bytes()
        for bad in (None, "deezer", {}, ["unknown"], ["deezer", "deezer"], [False], [{}],
                    ["deezer"] * 8):
            with self.subTest(value=bad), self.assertRaises(client.ApiError):
                studio.save_settings({"disabled_sources": bad, "stream_quality": "orig",
                                      "discogs_token": "not-saved"})
            self.assertEqual(studio.config, {"disabled_sources": ["deezer"]})
            self.assertEqual(Path(self.home, "config.json").read_bytes(), original)

    def play_event(self, studio, **patch):
        return {"track_id": "903", "event_id": "play-event-1234567890",
                "session": studio.playback_session,
                "played_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "listened": 10.5, **patch}

    def test_recently_played_is_disabled_without_network_and_reads_the_native_list_on_demand(self):
        studio = client.Studio(self.home)
        with patch.object(studio, "_current", side_effect=AssertionError("No network when disabled")):
            self.assertFalse(studio.recently_played()["enabled"])
        studio = self.connect()
        studio.save_settings({"record_plays": True})
        mock_ibroadcast.STATE["recent_tracks"] = [904, 900, 902]
        found = studio.recently_played()
        self.assertEqual([t["id"] for t in found["tracks"]], ["904", "900"])
        downloads = mock_ibroadcast.STATE["downloads"]
        self.assertEqual(studio.recently_played("wish")["total"], 1)
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads)
        studio.record_play(self.play_event(studio))
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads, "Reporting does not reload the library")
        self.assertEqual(studio.recently_played()["tracks"][0]["id"], "903")
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        for args in [("", "-1", "50"), ("", "0", "500"), ("x" * 201, "0", "50")]:
            with self.assertRaises(client.ApiError):
                studio.recently_played(*args)

    def test_recently_played_upgrades_old_cache_once_and_can_refresh_frozen_remote_state(self):
        studio = self.connect()
        studio.save_settings({"record_plays": True})
        studio.load_library()
        old = studio.library.to_cache()
        old.pop("recently_played")
        old["library"].pop("playlists", None)
        studio.library = client.Library(old)
        mock_ibroadcast.STATE["recent_tracks"] = [904]
        downloads = mock_ibroadcast.STATE["downloads"]
        self.assertEqual(studio.recently_played()["tracks"][0]["id"], "904")
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads + 1)
        mock_ibroadcast.STATE["recent_tracks"] = [900]
        self.assertEqual(studio.recently_played()["tracks"][0]["id"], "904")
        self.assertEqual(studio.recently_played(refresh=True)["tracks"][0]["id"], "900")
        studio.save_settings({"record_plays": False})
        with patch.object(studio, "_current", side_effect=AssertionError("No fetch")):
            self.assertEqual(studio.recently_played()["tracks"], [])

    def test_recently_played_discards_a_result_after_disconnect_or_preference_change(self):
        studio = self.connect()
        studio.save_settings({"record_plays": True})
        library = client.Library(mock_ibroadcast.library())
        def disconnect(*args, **kwargs):
            studio._disconnect()
            return library, "download"
        with patch.object(studio, "_current", side_effect=disconnect):
            with self.assertRaises(client.NotConnected):
                studio.recently_played()
        studio = self.connect()
        studio.save_settings({"record_plays": True})
        def disable(*args, **kwargs):
            studio.config["record_plays"] = False
            return library, "download"
        with patch.object(studio, "_current", side_effect=disable):
            self.assertEqual(studio.recently_played()["tracks"], [])

    def test_play_recording_is_off_by_default_and_preference_persists(self):
        studio = client.Studio(self.home)
        self.assertFalse(studio.settings()["record_plays"])
        with patch.object(client.requests, "post") as post:
            self.assertEqual(studio.record_play(self.play_event(studio)), {"status": "disabled"})
            post.assert_not_called()
        studio.save_settings({"discogs_token": "keep-key", "record_plays": True})
        self.assertTrue(client.Studio(self.home).settings()["record_plays"])
        self.assertEqual(studio.config["discogs_token"], "keep-key")
        self.assertPrivate(Path(self.home, "config.json"))
        for bad in ("true", 1, None):
            with self.assertRaises(client.ApiError):
                studio.save_settings({"record_plays": bad})

    def test_play_events_send_documented_history_once_without_library_downloads(self):
        studio = self.connect()
        studio.load_library()
        studio.save_settings({"record_plays": True})
        body = self.play_event(studio)
        downloads = mock_ibroadcast.STATE["downloads"]
        self.assertEqual(studio.record_play(body), {"status": "sent"})
        self.assertEqual(studio.record_play(body), {"status": "sent"})
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads)
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        self.assertEqual(len(mock_ibroadcast.STATE["play_requests"]), 1)
        self.assertEqual(mock_ibroadcast.STATE["play_requests"][0]["history"], [{
            "day": body["played_at"][:10], "plays": {"903": 1},
            "detail": {"903": [{"event": "play", "ts": body["played_at"][:19].replace("T", " ")}]}}])
        with self.assertRaises(client.ApiError):
            studio.record_play({**body, "track_id": "904"})
        studio.save_settings({"record_plays": False})
        self.assertEqual(studio.record_play({**body, "event_id": "another-play-12345678"}), {"status": "disabled"})
        self.assertEqual(len(mock_ibroadcast.STATE["play_requests"]), 1)

    def test_play_rejects_short_invalid_trashed_or_stale_session_events(self):
        from tagcast.library import LibraryError
        studio = self.connect()
        studio.load_library()
        studio.save_settings({"record_plays": True})
        for patch_values in ({"listened": 10}, {"listened": True}, {"listened": float("nan")},
                             {"listened": float("inf")}, {"played_at": "invalid"},
                             {"played_at": "2026-01-01T00:00:00"}, {"played_at": "2000-01-01T00:00:00Z"},
                             {"played_at": "2999-01-01T00:00:00Z"}, {"event_id": "short"},
                             {"session": "old-session"}):
            with self.subTest(values=patch_values), self.assertRaises(client.ApiError):
                studio.record_play(self.play_event(studio, **patch_values))
        with self.assertRaises(LibraryError):
            studio.record_play(self.play_event(studio, track_id="902"))
        old_event = self.play_event(studio)
        studio._connect(studio.client.token_set)
        with self.assertRaises(client.NotConnected):
            studio.record_play(old_event)
        self.assertEqual(mock_ibroadcast.STATE["play_requests"], [])

    def test_play_count_requests_are_not_retried_after_503_or_network_timeout(self):
        studio = self.connect()
        studio.load_library()
        studio.save_settings({"record_plays": True})
        body = self.play_event(studio)
        mock_ibroadcast.STATE["busy"] = 1
        with patch.object(client.time, "sleep") as sleep, self.assertRaises(client.ApiError):
            studio.record_play(body)
        self.assertEqual(len(mock_ibroadcast.STATE["play_requests"]), 1)
        self.assertEqual(sleep.call_args_list, [unittest.mock.call(0)])
        self.assertEqual(studio.record_play(body), {"status": "unconfirmed"})
        another = self.play_event(studio, event_id="timeout-play-12345678")
        with patch.object(client.requests, "post", side_effect=client.requests.Timeout) as post:
            with self.assertRaises(client.ApiError):
                studio.record_play(another)
            self.assertEqual(studio.record_play(another), {"status": "unconfirmed"})
            self.assertEqual(post.call_count, 1)

    def test_concurrent_repeated_play_requests_do_not_double_count(self):
        studio = self.connect()
        studio.load_library()
        studio.save_settings({"record_plays": True})
        body = self.play_event(studio)
        results = []
        threads = [threading.Thread(target=lambda: results.append(studio.record_play(body))) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertEqual(results, [{"status": "sent"}, {"status": "sent"}])
        self.assertEqual(len(mock_ibroadcast.STATE["play_requests"]), 1)

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

    def test_a_busy_metadata_write_is_checked_without_automatic_replay(self):
        studio = self.connect()
        track = studio.album_details(["74"])[0]["tracks"][0]
        mock_ibroadcast.STATE["busy"] = 2
        original = client.RETRY_DELAYS
        client.RETRY_DELAYS = (0, 0)
        try:
            result = studio.save([edit("track", track["id"], 74, genre=(track["genre"], "Retried"))])
            self.assertEqual(mock_ibroadcast.STATE["busy"], 1)
            job = self.wait_job(studio, result["job"])
        finally:
            client.RETRY_DELAYS = original
            mock_ibroadcast.STATE["busy"] = 0
        self.assertEqual([r["status"] for r in result["results"]], ["sent"])
        self.assertEqual(len(mock_ibroadcast.STATE["writes"]), 0)
        self.assertEqual(job["results"][0]["status"], "unverified")

    def test_switching_combine_sets_downloads_the_library_again(self):
        studio = self.connect()
        self.assertEqual(studio.load_library()["source"], "download")
        self.wait_for_cache(studio)
        mock_ibroadcast.STATE["combine_sets"] = True  # lastmodified stays the same
        self.assertEqual(studio.load_library()["source"], "download")
        import gzip
        for _ in range(100):  # the cache is rewritten in the background
            # Windows cannot replace an open file; do not race the background writer.
            with studio.cache_lock:
                cached = json.loads(gzip.decompress(Path(self.home, client.CACHE_FILE).read_bytes()))
            if cached.get("combine_sets") is True:
                break
            time.sleep(0.05)
        else:
            self.fail("cache was not rewritten after switching combine_sets")
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

    def test_tracks_go_to_the_trash_after_a_check_and_are_read_back(self):
        studio = self.connect()
        with self.assertRaises(client.ApiError):
            studio.trash_tracks({"tracks": []})
        with self.assertRaises(ConflictError):  # not a track of that album
            studio.trash_tracks({"tracks": [{"id": "901", "album_id": "73", "title": "Hounds of Love"}]})
        with self.assertRaises(ConflictError):  # already in the trash
            studio.trash_tracks({"tracks": [{"id": "902", "album_id": "72", "title": "Old deleted"}]})
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        result = studio.trash_tracks({"tracks": [{"id": "901", "album_id": "72", "title": "Hounds of Love"}]})
        self.assertEqual([(w["mode"], w["tracks"]) for w in mock_ibroadcast.STATE["writes"]], [("trash", [901])])
        self.assertEqual([(r["label"], r["status"]) for r in result["results"]], [("Hounds of Love", "sent")])
        job = self.wait_job(studio, result["job"])
        self.assertEqual([(r["id"], r["status"]) for r in job["results"]], [("901", "saved")])
        self.assertEqual(next(a for a in job["albums"] if a["id"] == "72")["track_count"], 1)

    def test_bulk_duplicate_trash_uses_native_requests_fresh_checks_and_private_report(self):
        original = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            mock_ibroadcast.STATE["tracks"][900].update(type="audio/flac", uploaded_on="2022-01-01", length=180)
            mock_ibroadcast.STATE["tracks"][901].update(title="Running Up That Hill (Remaster)", track=1,
                type="audio/mpeg", uploaded_on="2026-01-01", uploaded_time="12:00:00", length=180)
            studio = self.connect()
            preview = studio.duplicate_cleanup.prepare()
            self.assertEqual(preview["selection"], [{"id": "901", "group": "72"}])
            self.assertEqual(mock_ibroadcast.STATE["writes"], [])
            studio.duplicate_cleanup.start(preview["id"], [], True)
            for _ in range(300):
                if not studio.duplicate_cleanup.running:
                    break
                time.sleep(.01)
            self.assertFalse(studio.duplicate_cleanup.running)
            report = studio.duplicate_cleanup.view()
            self.assertEqual((report["state"], report["counts"]), ("done", {"confirmed": 1}))
            self.assertEqual([(w["mode"], w["tracks"]) for w in mock_ibroadcast.STATE["writes"]], [("trash", [901])])
            self.assertFalse(mock_ibroadcast.STATE["tracks"][900]["trashed"])
            self.assertPrivate(Path(self.home, "duplicate-cleanup.json"))
            self.assertNotIn(mock_ibroadcast.TOKEN, json.dumps(report))
        finally:
            mock_ibroadcast.STATE["tracks"] = original

    def test_selected_complete_albums_require_review_and_fresh_membership(self):
        studio = self.connect()

        def selection(ids):
            return {"approved": True, "combine_sets": False, "albums": [
                {"id": a["id"], "name": a["name"], "artist": a["artist"],
                 "tracks": [{"id": t["id"], "title": t["title"]} for t in a["tracks"]]}
                for a in studio.album_details(ids)]}

        body = selection(["72", "73"])
        for mutate in [lambda b: b.update(approved=False),
                       lambda b: b["albums"][0]["tracks"].pop(),
                       lambda b: b["albums"][0].update(name="Old name"),
                       lambda b: b["albums"][0].update(artist="Old artist"),
                       lambda b: b["albums"][0]["tracks"][0].update(title="Old title"),
                       lambda b: b["albums"][0]["tracks"].append(b["albums"][0]["tracks"][0]),
                       lambda b: b.update(combine_sets=True)]:
            changed = copy.deepcopy(body)
            mutate(changed)
            with self.assertRaises((client.ApiError, ConflictError)):
                studio.trash_albums(changed)
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        original = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            result = studio.trash_albums(body)
            self.assertEqual([(w["mode"], w["tracks"]) for w in mock_ibroadcast.STATE["writes"]], [("trash", [900, 901, 903])])
            job = self.wait_job(studio, result["job"])
            self.assertTrue(all(r["status"] == "saved" for r in job["results"]))
            self.assertNotIn("72", {a["id"] for a in job["albums"]})
            self.assertNotIn("73", {a["id"] for a in job["albums"]})
            self.assertFalse(mock_ibroadcast.STATE["tracks"][904]["trashed"])
        finally:
            mock_ibroadcast.STATE["tracks"] = original

    def test_native_tag_create_assign_rename_delete_are_read_back_and_leave_music_unchanged(self):
        studio = self.connect()
        original = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        tags_before = copy.deepcopy(mock_ibroadcast.STATE["tags"])
        try:
            result = studio.tags.save({"approved": True, "action": "create", "name": "Listen later"})
            self.assertNotIn("albums", self.wait_job(studio, result["job"]))
            tag = studio.tags.catalogue()["tags"][0]
            selection = studio.tags.selection(["72"])
            result = studio.tags.save({"approved": True, "action": "change", "target": selection["target"],
                "before": selection["before"], "changes": [{"id": tag["id"], "before": tag["before"], "action": "add"}]})
            self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
            self.assertEqual(studio.browse("tags", tag["id"])["album_ids"], ["72"])
            self.assertEqual(studio.album_details(["72"])[0]["tracks"][0]["tags"][0]["name"], "Listen later")
            tag = studio.tags.catalogue(tag_id=tag["id"])
            result = studio.tags.save({"approved": True, "action": "rename", "id": tag["id"], "before": tag["before"], "name": "On Sunday"})
            self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
            tag = studio.tags.catalogue(tag_id=tag["id"])
            result = studio.tags.save({"approved": True, "action": "delete", "id": tag["id"], "before": tag["before"]})
            self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
            self.assertEqual(studio.tags.catalogue()["tags"], [])
            self.assertEqual(mock_ibroadcast.STATE["tracks"], original)
            self.assertEqual([w["mode"] for w in mock_ibroadcast.STATE["writes"]],
                             ["createtag", "tagtracks", "updatetag", "deletetags"])
        finally:
            mock_ibroadcast.STATE["tags"] = tags_before

    def test_selected_album_tags_read_back_across_artists_without_changing_music(self):
        studio = self.connect()
        tags_before = copy.deepcopy(mock_ibroadcast.STATE["tags"])
        tracks_before = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            result = studio.tags.save({"approved": True, "action": "create", "name": "Together"})
            self.assertEqual(self.wait_job(studio, result["job"])["results"][0]["status"], "saved")
            tag = studio.tags.catalogue()["tags"][0]
            selection = studio.tags.selection(["72", "74"], multiple=True)
            self.assertEqual({a["artist"] for a in selection["albums"]}, {"Kate Bush", "Pink Floyd"})
            self.assertEqual(selection["tracks"], 3)
            result = studio.tags.save({"approved": True, "action": "change", "target": selection["target"],
                "before": selection["before"], "changes": [{"id": tag["id"], "before": tag["before"], "action": "add"}]})
            self.assertEqual(self.wait_job(studio, result["job"])["results"], [{"id": tag["id"], "status": "saved"}])
            self.assertEqual(set(studio.browse("tags", tag["id"])["album_ids"]), {"72", "74"})
            self.assertEqual(mock_ibroadcast.STATE["tags"][int(tag["id"])]["tracks"], [900, 901, 904])
            self.assertEqual(mock_ibroadcast.STATE["tracks"], tracks_before)
            self.assertEqual([w["mode"] for w in mock_ibroadcast.STATE["writes"]], ["createtag", "tagtracks"])
        finally:
            mock_ibroadcast.STATE["tags"] = tags_before

    def test_selected_album_trash_accepts_different_artists_and_keeps_unselected_albums(self):
        studio = self.connect()
        body = {"approved": True, "combine_sets": False, "albums": [
            {"id": a["id"], "name": a["name"], "artist": a["artist"],
             "tracks": [{"id": t["id"], "title": t["title"]} for t in a["tracks"]]}
            for a in studio.album_details(["72", "74"])]}
        self.assertEqual({a["artist"] for a in body["albums"]}, {"Kate Bush", "Pink Floyd"})
        self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        original = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            result = studio.trash_albums(body)
            self.assertEqual([(w["mode"], w["tracks"]) for w in mock_ibroadcast.STATE["writes"]],
                             [("trash", [900, 901, 904])])
            job = self.wait_job(studio, result["job"])
            self.assertTrue(all(r["status"] == "saved" for r in job["results"]))
            self.assertEqual({a["id"] for a in job["albums"]}, {"73"})
            self.assertFalse(mock_ibroadcast.STATE["tracks"][903]["trashed"])
        finally:
            mock_ibroadcast.STATE["tracks"] = original

    def test_selected_album_trash_rejects_new_tracks_and_partial_merged_sets(self):
        studio = self.connect()
        album = studio.album_details(["72"])[0]
        body = {"approved": True, "combine_sets": False, "albums": [{"id": album["id"], "name": album["name"],
            "artist": album["artist"], "tracks": [{"id": t["id"], "title": t["title"]} for t in album["tracks"]]}]}
        original_albums = copy.deepcopy(mock_ibroadcast.STATE["albums"])
        original_tracks = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            mock_ibroadcast.STATE["tracks"][902]["trashed"] = False
            mock_ibroadcast.STATE["version"] += 1
            with self.assertRaises(ConflictError):
                studio.trash_albums(body)
            mock_ibroadcast.STATE["tracks"][902]["trashed"] = True
            mock_ibroadcast.STATE["albums"][73].update(name=album["name"], year=0, disc=2)
            mock_ibroadcast.STATE["version"] += 1
            with self.assertRaises(ConflictError):
                studio.trash_albums(body)
            self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        finally:
            mock_ibroadcast.STATE["albums"] = original_albums
            mock_ibroadcast.STATE["tracks"] = original_tracks

    def test_selected_album_trash_enforces_album_and_track_batch_limits(self):
        original_albums = copy.deepcopy(mock_ibroadcast.STATE["albums"])
        original_tracks = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
        try:
            for i in range(21):
                mock_ibroadcast.STATE["albums"][100 + i] = {"name": f"Album {i}", "artist_id": 41,
                    "year": 1985, "disc": 1, "tracks": [1000 + i]}
                mock_ibroadcast.STATE["tracks"][1000 + i] = {**original_tracks[900], "album_id": 100 + i}
            mock_ibroadcast.STATE["version"] += 1
            studio = self.connect()
            body = {"approved": True, "combine_sets": False, "albums": [{"id": a["id"], "name": a["name"],
                "artist": a["artist"], "tracks": [{"id": t["id"], "title": t["title"]} for t in a["tracks"]]}
                for a in studio.album_details([str(i + 100) for i in range(21)])]}
            with self.assertRaisesRegex(client.ApiError, "20 displayed albums"):
                studio.trash_albums(body)
            body["albums"] = body["albums"][:1]
            body["albums"][0]["tracks"] = [{"id": str(i + 10000), "title": "Track"} for i in range(501)]
            with self.assertRaisesRegex(client.ApiError, "500 tracks"):
                studio.trash_albums(body)
            self.assertEqual(mock_ibroadcast.STATE["writes"], [])
        finally:
            mock_ibroadcast.STATE["albums"] = original_albums
            mock_ibroadcast.STATE["tracks"] = original_tracks

    def test_track_search_finds_active_tracks_in_album_order(self):
        studio = self.connect()
        found = studio.search_tracks("kate bush")
        self.assertEqual([(t["id"], t["album"]) for t in found["tracks"]],
                         [("900", "Hounds of Love"), ("901", "Hounds of Love"), ("903", "The Dreaming")])
        self.assertEqual(studio.search_tracks("old deleted")["total"], 0)  # in the trash
        self.assertEqual(studio.search_tracks("")["tracks"], [])
        with self.assertRaises(client.ApiError):
            studio.search_tracks("x" * 201)

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

    def test_invalid_album_or_track_year_blocks_all_metadata_requests(self):
        studio = self.local_connection()
        studio.load_library()
        album = studio.album_details([74])[0]
        track = album["tracks"][0]
        for year in [1799, 2051]:
            for kind, item_id, before in [("album", 74, album["year"]),
                                          ("track", track["id"], track["year"])]:
                with self.subTest(kind=kind, year=year), self.assertRaises(ValueError):
                    studio.save([edit("album", 74, 74, name=(album["name"], "New title")),
                                 edit(kind, item_id, 74, year=(before, year))]
                                if kind == "track" else
                                [edit("album", 74, 74, name=(album["name"], "New title"),
                                      year=(before, year))])
                self.assertEqual(mock_ibroadcast.STATE["writes"], [])

    def test_various_artists_saves_only_album_artist_and_reads_back_track_credits(self):
        original = copy.deepcopy(mock_ibroadcast.STATE)
        try:
            mock_ibroadcast.STATE["tracks"][904]["additional"] = [[41, None, "artist"]]
            studio = self.local_connection()
            studio.load_library()
            album = studio.album_details([74])[0]
            tracks = copy.deepcopy(mock_ibroadcast.STATE["tracks"])
            result = studio.save([edit("album", 74, 74, artist_id=(album["artist_id"], 0))])
            self.assertEqual(result["created_artists"], [])
            self.assertEqual(len(mock_ibroadcast.STATE["writes"]), 1)
            write = mock_ibroadcast.STATE["writes"][0]
            self.assertEqual(write["mode"], "update_album")
            self.assertEqual(write["albums"], [{"album_id": 74, "artist_id": 0}])
            self.assertNotIn("tracks", write)
            self.assertEqual(mock_ibroadcast.STATE["tracks"], tracks)
            job = self.wait_job(studio, result["job"])
            self.assertEqual(job["results"][0]["status"], "saved")
            after = studio.album_details([74])[0]
            self.assertEqual((after["artist_id"], after["artist"]), (0, "Various Artists"))
            self.assertEqual(after["tracks"], album["tracks"])
        finally:
            mock_ibroadcast.STATE.clear()
            mock_ibroadcast.STATE.update(original)

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
        checked = self.wait_job(studio, result["job"])
        self.assertEqual(checked["results"][0]["status"], "saved")
        self.assertIn("Roger Waters", checked["editor_names"]["composers"])
        self.assertIn("Kate Bush", studio.load_library()["editor_names"]["composers"])
        self.assertEqual(studio.album_details(["74"])[0]["tracks"][0]["composers"], ["Roger Waters", "Kate Bush"])
        mock_ibroadcast.STATE["tracks"][904]["additional"] = []

    def test_reviewed_lyrics_save_uses_native_userdata_and_preserves_custom_fields(self):
        studio = self.connect()
        studio.load_library()
        previous = mock_ibroadcast.STATE["tracks"][900].get("userdata")
        previous_premium = mock_ibroadcast.STATE["premium"]
        mock_ibroadcast.STATE["premium"] = True
        rows = [{"type": "custom", "name": "Notes", "value": "Keep this"},
                {"type": "lyrics", "value": "Existing test verse"}]
        mock_ibroadcast.STATE["tracks"][900]["userdata"] = rows
        studio.premium = True
        try:
            track = studio.library.track_view(900)
            body = {"session": studio.playback_session, "track_id": "900",
                    "title": track["title"], "artist": track["artist"]}
            data = studio.lyrics.view(body)
            self.assertEqual(data["text"], "Existing test verse")
            self.assertEqual(mock_ibroadcast.STATE["writes"], [])
            review = studio.lyrics.prepare({**body, "before_token": data["before_token"],
                                           "lyrics": "Edited test verse"})
            result = studio.lyrics.save({"id": review["id"], "approved": True})
            self.assertEqual(result["status"], "saved")
            writes = mock_ibroadcast.STATE["writes"]
            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0]["mode"], "update_track")
            self.assertEqual(writes[0]["tracks"], [{"file_id": 900, "userdata": [
                rows[0], {"type": "lyrics", "value": "Edited test verse"}]}])
            self.assertEqual(studio.lyrics.view(body)["text"], "Edited test verse")
        finally:
            mock_ibroadcast.STATE["premium"] = previous_premium
            if previous is None:
                mock_ibroadcast.STATE["tracks"][900].pop("userdata", None)
            else:
                mock_ibroadcast.STATE["tracks"][900]["userdata"] = previous


if __name__ == "__main__":
    unittest.main()
