"""App integration of uploads, with synthetic files and no real iBroadcast requests."""

import json
import tempfile
import threading
import time
import unittest
from functools import partial
from http.client import HTTPConnection
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tagcast import uploads as engine
from tagcast.app import STATIC, Handler, Server
from tagcast.client import ApiError, Studio
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.music_uploads import MAX_FILES, MusicUploads, upload_authorized


class MusicUploadsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.studio = Studio(self.root / "settings")
        self.studio.client = Mock()
        self.studio.client.token_set = SimpleNamespace(scope=["user.upload"], access_token="private-token")
        self.studio.client._jsonrequest.return_value = {"supported": [{"extension": "flac"}]}
        self.studio.library = Library({"library": {"artists": {}, "albums": {}, "tracks": {}}})
        self.studio.library_user, self.studio.playback_session = "test-user", "upload-session"
        self.studio.config["music_uploads"] = True
        self.uploads = self.studio.music_uploads
        self.addCleanup(self.uploads.close)
        self.service = Mock()
        self.service.remote_md5s.return_value = frozenset()
        self.service.upload.side_effect = self.send
        self.factory = patch("tagcast.music_uploads.engine.UploadService", return_value=self.service)
        self.factory.start()
        self.addCleanup(self.factory.stop)
        self.sent = []
        for name in ("load_library", "_current", "_remote_state", "save", "album_details"):
            setattr(self.studio, name, Mock(side_effect=AssertionError("No library reads or metadata writes")))

    def send(self, item, transfer, **kwargs):
        transfer.begin()
        self.sent.append(item.label)
        return str(len(self.sent))

    def body(self, **kwargs):
        return {"session": "upload-session", **kwargs}

    def file(self, name="one.flac", data=b"synthetic-audio"):
        path = self.root / "music" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return path

    def wait(self, condition):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.005)
        self.fail("Synthetic upload task did not settle")

    def prepare(self, paths=None):
        self.uploads.prepare(self.body(paths=[str(p) for p in (paths or [self.file()])]))
        self.wait(lambda: not self.uploads.preparing)
        view = self.uploads.view("upload-session")
        self.assertFalse(view["error"], view)
        return view

    def test_disabled_by_default_and_upload_scope_is_opt_in_and_persisted(self):
        studio = Studio(self.root / "other-settings")
        self.assertFalse(studio.settings()["music_uploads"])
        self.assertNotIn("user.upload", studio.scopes)
        studio.save_settings({"music_uploads": True})
        self.assertIn("user.upload", studio.scopes)
        self.assertFalse(studio.settings()["music_uploads_authorized"])
        self.assertTrue(Studio(studio.home).settings()["music_uploads"])
        for value in (1, "true", None, []):
            with self.assertRaises(ApiError):
                studio.save_settings({"music_uploads": value})

    def test_preparation_requires_enabled_setting_granted_scope_and_current_session(self):
        self.assertTrue(upload_authorized(self.studio.client))
        for flag, scope, session in ((False, ["user.upload"], "upload-session"),
                                    (True, [], "upload-session"),
                                    (True, ["user.upload"], "old-session")):
            self.studio.config["music_uploads"] = flag
            self.studio.client.token_set.scope = scope
            with self.assertRaises(LibraryError):
                self.uploads.prepare({"paths": [str(self.file())], "session": session})
        self.studio.client._jsonrequest.assert_not_called()
        self.service.remote_md5s.assert_not_called()

    def test_opening_page_reads_no_paths_network_or_music(self):
        view = self.uploads.view("upload-session")
        self.assertEqual(view["items"], [])
        self.studio.client._jsonrequest.assert_not_called()
        self.service.remote_md5s.assert_not_called()
        self.assertEqual(self.sent, [])

    def test_prepare_reads_only_chosen_files_and_never_uploads(self):
        chosen = self.file()
        self.file("not-chosen.flac", b"other-audio")
        view = self.prepare([chosen])
        self.assertEqual(view["summary"]["counts"], {"new": 1})
        self.assertEqual(view["items"][0]["label"], "music/one.flac")
        self.assertNotIn(str(self.root), json.dumps(view))
        self.service.upload.assert_not_called()
        self.assertTrue((self.studio.home / engine.HASH_FILE).exists())
        self.assertFalse((chosen.parent / ".ibsync").exists())
        self.assertEqual(chosen.read_bytes(), b"synthetic-audio")

    def test_preparation_explicitly_requests_supported_types_like_the_live_service(self):
        # The live status response omits supported unless explicitly requested.
        def status(mode, **kwargs):
            self.assertEqual(mode, "status")
            return {"result": True, **({"supported": [{"extension": "flac"}]}
                                     if kwargs.get("supported_types") is True else {})}
        self.studio.client._jsonrequest.side_effect = status
        view = self.prepare([self.file()])
        self.studio.client._jsonrequest.assert_called_once_with("status", supported_types=True)
        self.assertEqual(view["summary"]["counts"], {"new": 1})
        self.service.upload.assert_not_called()

    def test_folder_and_overlapping_unicode_file_selection_are_not_counted_twice(self):
        chosen = self.file("01 - I’d Want U 🅴.flac")
        self.file("02 - Other.flac", b"second-file")
        view = self.prepare([chosen.parent, chosen])
        self.assertEqual(view["summary"]["files"], 2)
        self.assertEqual(view["summary"]["counts"], {"new": 2})
        self.assertEqual(sum(row["label"].endswith(chosen.name) for row in view["items"]), 1)
        self.service.upload.assert_not_called()

    def test_preparation_errors_identify_the_failed_step_without_private_details(self):
        chosen = self.file()
        cases = (
            (self.studio.client, "_jsonrequest", RuntimeError, "supported file types"),
            (self.service, "remote_md5s", engine.UploadError, "list of uploaded files"),
            (engine, "scan", engine.UploadError, "could not be scanned"),
            (engine, "plan_uploads", OSError, "could not be checked"),
            (self.service, "remote_md5s", engine.AuthRejected, "upload permission"),
        )
        for owner, method, error, expected in cases:
            with self.subTest(method=method, error=error.__name__), patch.object(
                    owner, method, side_effect=error("private-token https://private.example/file")):
                self.uploads.prepare(self.body(paths=[str(chosen)]))
                self.wait(lambda: not self.uploads.preparing)
                view = self.uploads.view("upload-session")
                self.assertIn(expected, view["error"])
                self.assertEqual(view["phase"], "Preparation stopped. No files were uploaded.")
                self.assertIsNone(view["review"])
                self.assertNotIn("private-token", json.dumps(view))
                self.assertNotIn("private.example", json.dumps(view))
        self.service.upload.assert_not_called()

    def test_only_reviewed_new_files_are_sent_once_and_plan_is_consumed(self):
        view = self.prepare([self.file(), self.file("same.flac"), self.file("two.flac", b"second")])
        self.assertEqual(view["summary"]["counts"], {"new": 2, "duplicate": 1})
        self.uploads.start(self.body(review=view["review"]))
        self.wait(lambda: self.uploads.job.state == "done")
        self.assertEqual(self.sent, ["music/one.flac", "music/two.flac"])
        with self.assertRaises(ConflictError):
            self.uploads.start(self.body(review=view["review"]))

    def test_review_is_rejected_after_library_replacement_or_expiry_or_wrong_id(self):
        for problem in ("library", "expired", "token"):
            view = self.prepare([self.file()])
            if problem == "library":
                self.studio.library = Library({"library": {"artists": {}, "albums": {}, "tracks": {}}})
            elif problem == "expired":
                self.uploads.review = (view["review"], time.monotonic() - 1)
            with self.assertRaises(ConflictError):
                self.uploads.start(self.body(review="wrong" if problem == "token" else view["review"]))
        self.service.upload.assert_not_called()

    def test_invalid_paths_are_rejected_without_network_requests(self):
        for paths in ([], ["relative.flac"], ["/a\nb"], [None], ["/file"] * 101):
            with self.assertRaises(LibraryError):
                self.uploads.prepare(self.body(paths=paths))
        self.studio.client._jsonrequest.assert_not_called()

    def test_failed_preparation_is_terminal_sanitized_and_sends_nothing(self):
        self.studio.client._jsonrequest.side_effect = RuntimeError("private-token https://secret.example/token")
        self.uploads.prepare(self.body(paths=[str(self.file())]))
        self.wait(lambda: not self.uploads.preparing)
        data = self.uploads.view("upload-session")
        self.assertTrue(data["error"])
        self.assertNotIn("private-token", json.dumps(data))
        self.assertIsNone(data["review"])
        self.assertIsNone(self.uploads.library)
        self.assertEqual(self.sent, [])

    def test_missing_supported_types_fails_closed(self):
        self.studio.client._jsonrequest.return_value = {"supported": "invalid"}
        self.uploads.prepare(self.body(paths=[str(self.file())]))
        self.wait(lambda: not self.uploads.preparing)
        self.assertTrue(self.uploads.view("upload-session")["error"])
        self.service.remote_md5s.assert_not_called()

    def test_stop_during_preparation_discards_late_result(self):
        entered, release = threading.Event(), threading.Event()
        def listing(*args):
            entered.set()
            release.wait(3)
            return frozenset()
        self.service.remote_md5s.side_effect = listing
        self.uploads.prepare(self.body(paths=[str(self.file())]))
        self.assertTrue(entered.wait(1))
        self.uploads.control("stop", self.body())
        release.set()
        self.wait(lambda: not self.uploads.preparing)
        self.assertIsNone(self.uploads.view("upload-session")["review"])
        self.assertEqual(self.sent, [])

    def test_disabling_uploads_invalidates_review_without_removing_token_or_other_settings(self):
        self.prepare()
        client = self.studio.client
        self.studio.config["stream_quality"] = "orig"
        self.studio.save_settings({"music_uploads": False})
        self.assertIs(self.studio.client, client)
        self.assertEqual(self.studio.config["stream_quality"], "orig")
        self.assertIsNone(self.uploads.review)
        self.assertIsNone(self.uploads.owner)
        self.assertNotIn("user.upload", self.studio.scopes)

    def test_session_change_stops_before_the_next_file_and_never_rebinds_to_new_account(self):
        view = self.prepare([self.file(), self.file("two.flac", b"two")])
        def send_then_replace(item, transfer, **kwargs):
            result = self.send(item, transfer, **kwargs)
            self.studio.playback_session = "other-session"
            return result
        self.service.upload.side_effect = send_then_replace
        self.uploads.start(self.body(review=view["review"]))
        self.wait(lambda: self.uploads.job.state == "stopped")
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.uploads.job.items[1].status, engine.NOT_SENT)

    def test_stop_and_pause_resume_are_bound_to_the_current_session(self):
        self.prepare()
        job = self.uploads.job = Mock(state="running")
        job.view.return_value = {"items": [], "message": "", "counts": {}, "state": "running"}
        for action in ("pause", "resume", "stop"):
            with self.assertRaises(ConflictError):
                self.uploads.control(action, {"session": "other"})
        self.uploads.control("pause", self.body())
        self.uploads.control("resume", self.body())
        job.pause.assert_called_once()
        job.resume.assert_called_once()
        self.uploads.control("stop", self.body())
        self.wait(lambda: job.stop.called)

    def test_visible_results_are_paginated_and_tokens_and_service_urls_are_redacted(self):
        self.uploads.view("upload-session")
        self.uploads.items = [engine.UploadItem(Path("/private/file.flac"), f"file-{i}.flac", 1,
            note="private-token https://upload.example/?token=private-token") for i in range(123)]
        view = self.uploads.view("upload-session", 1)
        self.assertEqual(len(view["items"]), 50)
        self.assertEqual(view["items"][0]["label"], "file-50.flac")
        self.assertEqual(view["pages"], 3)
        self.assertNotIn("private-token", json.dumps(view))
        self.assertNotIn("https://", json.dumps(view))
        self.assertNotIn("/private/", json.dumps(view))
        self.assertEqual(self.uploads.view("upload-session", 500)["page"], 2)

    def test_corrupt_hash_index_is_treated_as_empty_and_scan_limit_is_enforced(self):
        self.studio._write(engine.HASH_FILE, {"version": 1, "files": ["invalid"]})
        self.prepare()
        self.uploads.control("clear", self.body())
        with patch("tagcast.music_uploads.engine.scan", side_effect=engine.UploadError("Too many")) as scan:
            self.uploads.prepare(self.body(paths=[str(self.file())]))
            self.wait(lambda: not self.uploads.preparing)
            self.assertEqual(scan.call_args.kwargs["limit"], MAX_FILES)
            self.assertIsNone(self.uploads.review)

    def test_new_wrapper_does_not_restore_plans_or_start_transfers(self):
        self.prepare()
        other = MusicUploads(self.studio)
        self.addCleanup(other.close)
        self.assertEqual(other.view("upload-session")["items"], [])
        self.service.upload.assert_not_called()

    def test_http_upload_routes_preserve_host_fetch_metadata_and_post_header_guards(self):
        handler = type("UploadTestHandler", (Handler,), {"studio": self.studio, "port": 0})
        server = Server(("127.0.0.1", 0), partial(handler, directory=str(STATIC)))
        handler.port = server.server_port
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            body = json.dumps(self.body(paths=[str(self.file())]))
            for headers in ({}, {"X-Tagcast": "1", "Host": "foreign.example"}):
                connection.request("POST", "/api/uploads/prepare", body,
                                   {"Content-Type": "application/json", **headers})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
            self.service.remote_md5s.assert_not_called()
            connection.request("GET", "/api/uploads?session=upload-session&page=0",
                               headers={"Sec-Fetch-Site": "cross-site"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
            connection.request("POST", "/api/uploads/prepare", body,
                               {"Content-Type": "application/json", "X-Tagcast": "1"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
            self.wait(lambda: not self.uploads.preparing)
            connection.request("GET", "/api/uploads?session=upload-session&page=0")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            review = json.loads(response.read())["review"]
            for action in ("pause", "resume"):
                connection.request("POST", f"/api/uploads/{action}", json.dumps(self.body()),
                                   {"Content-Type": "application/json", "X-Tagcast": "1"})
                response = connection.getresponse()
                self.assertEqual(response.status, 400)  # no job was started
                response.read()
            self.assertIsNotNone(review)
            self.service.upload.assert_not_called()
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            worker.join(3)
