"""The isolated listening build can read audio, but cannot write to iBroadcast."""

import json
import os
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from tagcast.app import Handler
from tagcast.client import ApiError, Studio


class PlaybackValidationTests(unittest.TestCase):
    def test_validation_overrides_old_recording_preferences_and_rejects_reenable(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"TAGCAST_PLAYBACK_VALIDATION": "1"}):
            Path(home, "config.json").write_text(json.dumps({"record_plays": True, "queue_sync": True}))
            studio = Studio(home)
            self.assertTrue(studio.playback_validation)
            self.assertTrue(studio.status()["playback_validation"])
            self.assertFalse(studio.settings()["record_plays"])
            self.assertFalse(studio.settings()["queue_sync"])
            before = studio.config.copy()
            for field in ("record_plays", "queue_sync"):
                with self.assertRaises(ApiError):
                    studio.save_settings({field: True, "stream_quality": "orig"})
                self.assertEqual(studio.config, before)
            result = studio.save_settings({"stream_quality": "orig", "record_plays": False, "queue_sync": False})
            self.assertEqual(result["stream_quality"], "orig")
            self.assertFalse(result["record_plays"])
            self.assertFalse(result["queue_sync"])

    def test_normal_studio_does_not_acquire_validation_mode(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"TAGCAST_PLAYBACK_VALIDATION": ""}):
            studio = Studio(home)
            self.assertFalse(studio.playback_validation)
            self.assertNotIn("playback_validation", studio.status())
            self.assertNotIn("playback_validation", studio.settings())
            self.assertTrue(studio.save_settings({"record_plays": True})["record_plays"])

    def test_validation_http_gate_blocks_writes_before_handlers_and_keeps_security(self):
        # test_client reloads client.py during collection; align only this HTTP fixture.
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"TAGCAST_PLAYBACK_VALIDATION": "1"}), mock.patch("tagcast.app.ApiError", ApiError):
            studio = Studio(home)
            cls = type("ValidationHandler", (Handler,), {"studio": studio, "port": 0})
            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(cls, directory=home))
            cls.port = server.server_port
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path, body=None, header=True, method="POST"):
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                headers = {"X-Tagcast": "1"} if header else {}
                connection.request(method, path, json.dumps(body or {}), headers)
                response = connection.getresponse()
                status, data = response.status, json.loads(response.read())
                connection.close()
                return status, data

            try:
                with mock.patch.object(studio, "save", side_effect=AssertionError("Never write")) as save:
                    for route in ("/api/save", "/api/play", "/api/favourite", "/api/artwork", "/api/lyrics/save",
                                  "/api/tags/save", "/api/playlist", "/api/trash", "/api/queue/action",
                                  "/api/future-write", "/api/save?anything=1"):
                        self.assertEqual(request(route)[0], 403, route)
                    save.assert_not_called()
                self.assertEqual(request("/api/settings", {"stream_quality": "orig"})[0], 200)
                self.assertEqual(request("/api/settings", {"queue_sync": True})[0], 400)
                self.assertEqual(request("/api/settings", {}, header=False)[0], 403)
                self.assertTrue(request("/api/status", method="GET")[1]["playback_validation"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
