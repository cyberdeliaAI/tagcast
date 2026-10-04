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

    def test_save_writes_and_reads_back(self):
        studio = self.connect()
        studio.load_library()
        before = studio.album_details(["74"])[0]["tracks"][0]
        downloads = mock_ibroadcast.STATE["downloads"]
        result = studio.save([edit("track", 904, 74, genre=(before["genre"], "Psychedelic Rock"),
                                   track=(before["track"], 5))])
        self.assertEqual([r["status"] for r in result["results"]], ["saved"])
        self.assertEqual(mock_ibroadcast.STATE["writes"][-1]["tracks"],
                         [{"file_id": 904, "genre": "Psychedelic Rock", "track_no": 5}])
        # unchanged since loading: no download before writing, one to read back
        self.assertEqual(mock_ibroadcast.STATE["downloads"], downloads + 1)
        album = next(a for a in result["albums"] if a["id"] == "74")
        self.assertEqual(album["genres"], ["Psychedelic Rock"])
        self.assertNotIn("tracks", album)

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


if __name__ == "__main__":
    unittest.main()
