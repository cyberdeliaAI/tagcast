"""Interface language: local storage of the choice, catalogs served fresh and coded errors."""

import json
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

from tagcast import app, client
from tagcast.errors import CodedError, error_payload
from tagcast.i18n import interface_languages, valid_interface_language
from tagcast.library import ConflictError, LibraryError

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "src" / "tagcast" / "static"


class CatalogTests(unittest.TestCase):
    def test_languages_come_from_the_bundled_manifest(self):
        self.assertEqual(interface_languages()[0], "en")
        self.assertIn("nl", interface_languages())
        for value in ("auto", "en", "nl"):
            self.assertTrue(valid_interface_language(value))
        for value in ("", "EN", "xx", None, 1, ["nl"], "nl;", "../en"):
            self.assertFalse(valid_interface_language(value), value)

    def test_the_generated_english_bundle_is_current(self):
        sys.path.insert(0, str(ROOT / "tools"))
        try:
            from build_i18n import build
        finally:
            sys.path.remove(str(ROOT / "tools"))
        self.assertEqual((STATIC / "i18n-en.js").read_text(encoding="utf-8"), build(),
                         "Run python3 tools/build_i18n.py")


class InterfaceLanguageSettingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_only_the_language_is_stored_locally_and_nothing_else_changes(self):
        config = {"auto_updates": False, "record_plays": True, "queue_sync": False, "music_uploads": False,
                  "stream_quality": "orig", "disabled_sources": ["deezer"], "client_id": "kept"}
        (self.home / "config.json").write_text(json.dumps(config))
        studio = client.Studio(self.home)
        self.assertIsNone(studio.settings()["interface_language"])
        with mock.patch.object(studio.queue_sync, "disconnect") as disconnect, \
                mock.patch.object(studio.music_uploads, "close") as close, \
                mock.patch("requests.Session.request", side_effect=AssertionError("no network")):
            self.assertEqual(studio.save_interface_language({"language": "nl"}), {"interface_language": "nl"})
        disconnect.assert_not_called()
        close.assert_not_called()
        saved = json.loads((self.home / "config.json").read_text())
        self.assertEqual(saved, {**config, "interface_language": "nl"})
        self.assertEqual(client.Studio(self.home).settings()["interface_language"], "nl")

    def test_unsupported_languages_are_rejected_with_a_code_and_leave_the_file_alone(self):
        studio = client.Studio(self.home)
        studio.save_interface_language({"language": "en"})
        before = (self.home / "config.json").read_bytes()
        for body in ({"language": "xx"}, {"language": None}, {}, {"language": ["nl"]}, None):
            with self.subTest(body=body), self.assertRaises(client.ApiError) as raised:
                studio.save_interface_language(body)
            self.assertEqual(raised.exception.code, "settings.invalid_language")
            self.assertEqual(str(raised.exception), "Choose a supported interface language.")
        self.assertEqual((self.home / "config.json").read_bytes(), before)

    def test_ordinary_settings_saves_keep_the_language(self):
        studio = client.Studio(self.home)
        studio.save_interface_language({"language": "nl"})
        studio.save_settings({"auto_updates": False})
        self.assertEqual(studio.settings()["interface_language"], "nl")


class CodedErrorTests(unittest.TestCase):
    def test_codes_are_optional_and_never_change_the_english_message(self):
        error = client.NotConnected("Your iBroadcast session expired. Connect again.", code="session.expired")
        self.assertEqual(str(error), "Your iBroadcast session expired. Connect again.")
        self.assertEqual(error_payload(error, connected=False), {
            "error": "Your iBroadcast session expired. Connect again.", "connected": False, "code": "session.expired"})
        self.assertEqual(error_payload(ConflictError("Changed."), conflict=True), {"error": "Changed.", "conflict": True})
        coded = LibraryError("Too many.", code="tags.too_many", params={"limit": 20, "secret": object()})
        self.assertEqual(error_payload(coded), {"error": "Too many.", "code": "tags.too_many", "params": {"limit": 20}})
        self.assertIsInstance(coded, ValueError)

    def test_invalid_codes_are_programming_errors(self):
        for code in ("Session", "a..b", "a b", "x" * 65, "<script>", 1):
            with self.subTest(code=code), self.assertRaises(ValueError):
                CodedError("text", code=code)

    def test_the_server_adds_codes_beside_existing_error_fields(self):
        handler = mock.Mock()
        app.Handler._run(handler, mock.Mock(side_effect=app.NotConnected("Connect your iBroadcast account first.",
                                                                             code="account.not_connected")))
        handler._json.assert_called_with(401, {"error": "Connect your iBroadcast account first.", "connected": False,
                                               "code": "account.not_connected"})
        app.Handler._run(handler, mock.Mock(side_effect=app.ApiError("Plain.")))
        handler._json.assert_called_with(400, {"error": "Plain."})


class CatalogServingTests(unittest.TestCase):
    def test_catalogs_are_never_reused_from_cache_while_reference_data_keeps_caching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "i18n").mkdir()
            (root / "i18n" / "nl.json").write_text("{}", encoding="utf-8")
            (root / "notes.json").write_text("{}", encoding="utf-8")
            handler = type("StaticHandler", (app.Handler,), {"port": 0})
            server = app.Server(("127.0.0.1", 0), partial(handler, directory=directory))
            handler.port = server.server_port
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path):
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                try:
                    connection.request("GET", path, headers={"If-Modified-Since": "Thu, 01 Jan 2037 00:00:00 GMT"})
                    response = connection.getresponse()
                    return response.status, {k.lower(): v for k, v in response.getheaders()}
                finally:
                    connection.close()
            try:
                status, headers = request("/i18n/nl.json")
                self.assertEqual((status, headers["cache-control"], headers["content-type"]),
                                 (200, "no-store", "application/json"))
                self.assertEqual(request("/notes.json")[0], 304)
            finally:
                server.shutdown()
                thread.join()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
