"""Session isolation, explicit review and synthetic audio downloads; no real music."""

import io
import json
import tempfile
import threading
import time
import unittest
from functools import partial
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from test_download_engine import service_zip

from tagcast import download_engine as engine
from tagcast.app import STATIC, Handler, Server
from tagcast.client import Studio, StudioClient
from tagcast.downloads import AudioDownloads, DownloadLibrary, DownloadSession
from tagcast.library import ConflictError, Library, LibraryError


def fixture():
    return {"library": {"expires": "private-expiry", "artists": {"1": {"name": "Artist"}},
        "albums": {"10": {"name": "Live / Album", "artist_id": 1, "disc": 1, "year": 2001,
                          "tracks": [1, 2]},
                   "11": {"name": "Live / Album", "artist_id": 1, "disc": 2, "year": 2001,
                          "tracks": [3]},
                   "12": {"name": "Trash", "artist_id": 1, "tracks": [4], "trashed": True}},
        "tracks": {"1": {"album_id": 10, "title": "One", "track": 1, "artist_id": 1,
                         "type": "audio/flac", "file": "/orig/private-one"},
                   "2": {"album_id": 10, "title": "Two", "track": 2, "artist_id": 1,
                         "type": "audio/flac", "file": "/orig/private-two"},
                   "3": {"album_id": 999, "title": "Three", "track": 1, "artist_id": 1,
                         "type": "audio/flac", "file": "/orig/private-three"},
                   "4": {"album_id": 12, "title": "Trash", "file": "/orig/trash"},
                   "5": {"album_id": 10, "title": "Unlisted", "file": "/orig/unlisted"}}}}


class Raw(io.BytesIO):
    def read(self, size=-1, decode_content=True):
        return super().read(size)


def response(body, mime="application/zip", status=200):
    r = requests.Response()
    r.status_code = status
    r.headers.update({"Content-Type": mime, "Content-Length": str(len(body))})
    r.raw = Raw(body)
    return r


class DownloadsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.studio = Studio(self.root / "settings")
        self.studio.client = Mock()
        self.studio.library = Library(fixture())
        self.studio.library_user, self.studio.playback_session = "test-user", "session-one"
        self.studio.premium = True
        self.downloads = self.studio.audio_downloads
        self.addCleanup(self.downloads.close)
        self.studio.client.open_download.side_effect = lambda *a: response(service_zip(b"synthetic-audio"))
        self.studio.client.open_stream.side_effect = lambda *a, **kw: response(b"uploaded-audio", "audio/flac")
        for method in ("_current", "_remote_state", "save", "load_library", "album_details"):
            setattr(self.studio, method, Mock(side_effect=AssertionError("No library fetch or writes")))

    def body(self, **kw):
        return {"session": "session-one", **kw}

    def select(self, ids=None):
        return self.downloads.add(self.body(albums=ids or ["10", "11"]))

    def prepare(self, **kw):
        self.downloads.prepare(self.body(out=str(self.root / "music"), **kw))
        self.wait(lambda: not self.downloads.view("session-one")["preparing"])
        result = self.downloads.view("session-one")
        self.assertFalse(result["error"], result)
        return result["review"]

    def wait(self, predicate):
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if predicate():
                return
            time.sleep(.005)
        self.fail("Local download task did not finish")

    def start(self, review):
        self.downloads.start(self.body(id=review["id"]))
        self.downloads.thread.join(5)
        self.assertFalse(self.downloads.thread.is_alive())
        self.assertIsNone(self.downloads.transfer.lib)
        self.assertIsNone(self.downloads.transfer.session)
        return self.downloads.view("session-one")["transfer"]

    def test_add_and_review_are_read_only_and_never_touch_playback_or_audio(self):
        self.select()
        review = self.prepare()
        self.assertEqual((review["discs"], review["tracks"]), (2, 3))
        self.assertTrue(any("2-01 Three.flac" in p for p in review["examples"]))
        self.assertFalse((self.root / "music").exists())
        self.studio.client.open_download.assert_not_called()
        self.studio.client.open_stream.assert_not_called()
        visible = json.dumps(self.downloads.view("session-one"))
        self.assertNotIn("private-one", visible)
        self.assertNotIn("private-expiry", visible)
        self.assertNotIn("test-user", visible)
        self.assertEqual(self.studio.playback_session, "session-one")

    def test_explicit_start_saves_only_selected_tracks_and_reuses_completed_files(self):
        self.select()
        self.assertEqual(self.start(self.prepare())["ok"], 3)
        files = list((self.root / "music").rglob("*.flac"))
        self.assertEqual(len(files), 3)
        self.assertTrue(all(p.read_bytes() == b"synthetic-audio" for p in files))
        self.assertEqual(self.start(self.prepare())["skip"], 3)
        self.assertEqual(self.studio.client.open_download.call_count, 3)
        self.studio.client.open_stream.assert_not_called()
        self.assertEqual(self.studio.library.album_ids(), [10, 11])

    def test_review_is_single_use_and_rejects_changed_library_or_selection(self):
        self.select()
        review = self.prepare()
        self.downloads.remove(self.body(album="10"))
        with self.assertRaises(ConflictError):
            self.downloads.start(self.body(id=review["id"]))
        review = self.prepare()
        self.studio.library = Library(fixture())
        with self.assertRaises(ConflictError):
            self.downloads.start(self.body(id=review["id"]))
        review = self.prepare()
        self.start(review)
        with self.assertRaises(ConflictError):
            self.downloads.start(self.body(id=review["id"]))

    def test_old_browser_cannot_read_queue_start_stop_or_pick_folder(self):
        self.select()
        for call in (lambda: self.downloads.view("old"),
                     lambda: self.downloads.add({"session": "old", "albums": [10]}),
                     lambda: self.downloads.cancel({"session": "old"}),
                     lambda: self.downloads.folder({"session": "old"})):
            with self.assertRaises(ConflictError):
                call()
        self.studio.playback_session = "session-two"
        view = self.downloads.view("session-two")
        self.assertEqual(view["albums"], [])
        self.assertIsNone(view["transfer"])

    def test_disconnected_and_demo_cannot_download(self):
        self.studio.client = None
        with self.assertRaises(ConflictError):
            self.select()
        self.assertFalse((self.root / "music").exists())

    def test_bad_selection_and_free_quality_rejected_without_audio(self):
        for ids in ([True], ["-1"], ["999"], ["12"], [], list(range(201))):
            with self.subTest(ids=ids), self.assertRaises(LibraryError):
                self.downloads.add(self.body(albums=ids))
        self.studio.premium = False
        self.select(["10"])
        self.assertEqual(self.downloads.view("session-one")["options"]["quality"], "128")
        with self.assertRaises(LibraryError):
            self.downloads.prepare(self.body(out=str(self.root / "music"), quality="orig"))
        result = self.start(self.prepare(quality="128"))
        self.assertEqual(result["ok"], 2)
        self.studio.client.open_download.assert_not_called()
        self.assertTrue(all(p.suffix == ".mp3" for p in (self.root / "music").rglob("*kbps*")))

    def test_options_validate_layout_quality_parallelism_and_work_folder(self):
        for options in ({"workers": True}, {"workers": 0}, {"workers": 5}, {"quality": "1000"},
                        {"verify": "yes"}, {"layout": "../{title}"}, {"layout": "{unknown}"},
                        {"source": "https://elsewhere"}, {"out": "\0bad"},
                        {"work": str(self.root / "music" / "work")}):
            with self.subTest(options=options), self.assertRaises((LibraryError, ValueError)):
                self.downloads.prepare(self.body(out=str(self.root / "music")) | options)

    def test_options_persist_but_queue_review_and_running_tasks_do_not(self):
        self.select()
        self.start(self.prepare(workers=2, source="stream", verify=True))
        other = AudioDownloads(self.studio)
        self.addCleanup(other.close)
        view = other.view("session-one")
        self.assertEqual(view["options"]["workers"], 2)
        self.assertTrue(view["options"]["verify"])
        self.assertEqual(view["albums"], [])
        self.assertIsNone(view["transfer"])
        self.assertNotIn("session-one", (self.studio.home / "download-options.json").read_text())

    def test_service_failure_is_visible_as_original_upload_fallback(self):
        self.select(["10"])
        self.studio.client.open_download.side_effect = lambda *a: response(b"not a zip", status=400)
        result = self.start(self.prepare())
        self.assertEqual(result["ok"], 2)
        self.assertEqual(result["notes_count"], 2)
        self.assertTrue(all("Fallback:" in n["note"] for n in result["notes"]))
        self.assertTrue(all(p.read_bytes() == b"uploaded-audio" for p in (self.root / "music").rglob("*.flac")))

    def test_changed_connection_blocks_transport_before_request_and_after_headers(self):
        context = self.downloads._context("session-one")
        transport = DownloadSession(self.studio, context)
        self.addCleanup(transport.close)
        self.studio.playback_session = "new"
        with self.assertRaises(Exception):
            transport.download(1, "test-user")
        self.studio.client.open_download.assert_not_called()
        self.studio.playback_session = "session-one"
        r = response(service_zip())
        def changed(*_):
            self.studio.playback_session = "new"
            return r
        self.studio.client.open_download.side_effect = changed
        with self.assertRaises(Exception):
            transport.download(1, "test-user")
        self.assertTrue(r.raw.closed)

    def test_stop_closes_registered_readers_and_preserves_existing_files(self):
        transport = DownloadSession(self.studio, self.downloads._context("session-one"))
        opened = transport.download(1, "test-user")
        self.assertEqual(len(transport.responses), 1)
        transport.close()
        self.assertTrue(opened.response.raw.closed)
        self.assertFalse(transport.responses)
        with self.assertRaises(Exception):
            opened.read(1)

    def test_network_error_does_not_expose_stream_url_or_token(self):
        transport = DownloadSession(self.studio, self.downloads._context("session-one"))
        self.addCleanup(transport.close)
        self.studio.client.open_stream.side_effect = requests.ConnectionError("https://bad/?token=SECRET")
        with self.assertRaises(OSError) as caught:
            transport.stream("/orig/private-one", 1, "test-user", "expires")
        self.assertNotIn("SECRET", str(caught.exception))
        self.assertNotIn("https://", str(caught.exception))

    def test_rejected_session_stops_batch_without_retry_or_stream_fallback(self):
        from tagcast.client import NotConnected
        self.select()
        review = self.prepare()
        self.studio.client.open_download.side_effect = NotConnected("Connect again.")
        result = self.start(review)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["fail"], 1)
        self.assertEqual(self.studio.client.open_download.call_count, 1)
        self.studio.client.open_stream.assert_not_called()
        self.assertIn("Connect again", result["failures"][0]["note"])

    def test_tls_failure_is_terminal_but_a_timeout_remains_retryable(self):
        from tagcast.client import ConnectionSecurityError, ConnectionUnavailable
        transport = DownloadSession(self.studio, self.downloads._context("session-one"))
        self.addCleanup(transport.close)
        for error in (ConnectionSecurityError("secure connection failed"), requests.exceptions.SSLError("SECRET")):
            self.studio.client.open_stream.side_effect = error
            with self.assertRaises(engine.TerminalTransferError) as caught:
                transport.stream("/orig/private-one", 1, "test-user", "expires")
            self.assertNotIn("SECRET", str(caught.exception))
        self.studio.client.open_stream.side_effect = ConnectionUnavailable("private")
        with self.assertRaises(OSError) as caught:
            transport.stream("/orig/private-one", 1, "test-user", "expires")
        self.assertIsNone(caught.exception.errno)

    def test_combined_native_membership_and_orphans_are_handled_conservatively(self):
        adapted = DownloadLibrary(self.studio.library, "test-user", True, threading.Event())
        self.assertTrue(adapted.active(3))
        self.assertEqual(adapted.tracks.get(3, "album_id"), 11)
        self.assertFalse(adapted.active(4))
        self.assertFalse(adapted.active(5))
        self.studio.library.albums[10]["tracks"].append(3)
        with self.assertRaises(engine.Fail):
            DownloadLibrary(self.studio.library, "test-user", True, threading.Event())

    def test_http_endpoints_require_same_origin_header_and_current_session(self):
        handler = type("DownloadTestHandler", (Handler,), {"studio": self.studio, "port": 0})
        server = Server(("127.0.0.1", 0), partial(handler, directory=str(STATIC)))
        handler.port = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            body = json.dumps(self.body(albums=["10"]))
            connection.request("POST", "/api/downloads/add", body, {"Content-Type": "application/json"})
            reply = connection.getresponse()
            self.assertEqual(reply.status, 403)
            reply.read()
            self.assertFalse(self.downloads.queue)
            connection.request("POST", "/api/downloads/add", body,
                {"Content-Type": "application/json", "X-Tagcast": "1"})
            reply = connection.getresponse()
            self.assertEqual(reply.status, 200)
            self.assertEqual(json.loads(reply.read())["tracks"], 2)
            connection.request("GET", "/api/downloads?session=session-one", headers={"Sec-Fetch-Site": "cross-site"})
            reply = connection.getresponse()
            self.assertEqual(reply.status, 403)
            reply.read()
            connection.request("GET", "/api/downloads?session=old")
            reply = connection.getresponse()
            self.assertEqual(reply.status, 409)
            reply.read()
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_worker_setup_failure_finishes_and_releases_the_snapshot(self):
        self.select()
        review = self.prepare()
        with patch.object(engine.Transfer, "run", side_effect=RuntimeError("private-secret")):
            result = self.start(review)
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["fail"], 1)
        self.assertNotIn("private-secret", json.dumps(result))

    def test_preparation_refreshes_queued_labels_from_the_reviewed_snapshot(self):
        self.select(["10"])
        raw = fixture()
        raw["library"]["albums"]["10"].update(name="Changed title", year=1958)
        self.studio.library = Library(raw)
        review = self.prepare()
        self.assertEqual(self.downloads.view("session-one")["albums"][0]["title"], "Changed title")
        self.assertTrue(all("Changed title (1958)" in p for p in review["examples"]))

    def test_unknown_stream_paths_cannot_mislabel_original_bytes_as_mp3(self):
        self.select(["10"])
        raw = fixture()
        raw["library"]["tracks"]["1"]["file"] = "/unrecognized/path"
        self.studio.library = Library(raw)
        self.downloads.prepare(self.body(out=str(self.root / "music"), quality="128"))
        self.wait(lambda: not self.downloads.view("session-one")["preparing"])
        view = self.downloads.view("session-one")
        self.assertIsNone(view["review"])
        self.assertIn("does not support selecting quality", view["error"])
        self.studio.client.open_download.assert_not_called()
        self.studio.client.open_stream.assert_not_called()


class DownloadTransportTests(unittest.TestCase):
    def test_download_request_uses_shared_refresh_and_fixed_service_without_redirects(self):
        client = object.__new__(StudioClient)
        client._user_agent = "Tagcast-test"
        client._with_fresh_token = Mock(side_effect=lambda send: send("secret-token"))
        r = response(service_zip())
        with patch("tagcast.client.requests.post", return_value=r) as post:
            self.assertIs(client.open_download(55, "test-user"), r)
        client._with_fresh_token.assert_called_once()
        args = post.call_args.kwargs
        self.assertFalse(args["allow_redirects"])
        self.assertTrue(args["stream"])
        self.assertEqual(args["data"], {"_user_id": "test-user", "_token": "secret-token",
            "mode": "downloadlibrary", "container_type": "track", "ids": "55", "end_marker": "1"})
        r.close()

    def test_json_authentication_rejection_uses_the_shared_generation_aware_refresh(self):
        client = object.__new__(StudioClient)
        client._user_agent = "Tagcast-test"
        client._refresh_token, client._client_id = "refresh", "public-client"
        client._request_token = Mock(return_value=("old-token", 7))
        client._refresh_or_fail = Mock()
        client._token_snapshot = Mock(return_value=("new-token", 8))
        refused = response(b'{"authenticated": false, "message":"private"}', "application/json")
        accepted = response(service_zip())
        with patch("tagcast.client.requests.post", side_effect=[refused, accepted]) as post:
            self.assertIs(client.open_download(1, "test-user"), accepted)
        client._refresh_or_fail.assert_called_once_with(7)
        self.assertEqual([c.kwargs["data"]["_token"] for c in post.call_args_list], ["old-token", "new-token"])
        self.assertTrue(refused.raw.closed)
        accepted.close()
