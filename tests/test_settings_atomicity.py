"""Rejected or unwritable local preferences never change active service gates."""

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tagcast import client


class AtomicSettingsTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.studio = client.Studio(self.home.name)
        self.studio.save_settings({"discogs_token": "original", "stream_quality": "128",
                                   "queue_sync": True, "music_uploads": True,
                                   "artist_biographies": True, "album_information": True})
        self.before = copy.deepcopy(self.studio.config)
        self.disk = Path(self.home.name, "config.json").read_bytes()
        self.scopes = self.studio.scopes
        self.revisions = (self.studio.artist_bios.revision, self.studio.album_info.revision)

    def assert_unchanged(self):
        self.assertEqual(self.studio.config, self.before)
        self.assertEqual(Path(self.home.name, "config.json").read_bytes(), self.disk)
        self.assertEqual(self.studio.scopes, self.scopes)
        self.assertEqual((self.studio.artist_bios.revision, self.studio.album_info.revision), self.revisions)

    def test_invalid_keys_do_not_apply_earlier_keys_preferences_or_disable_services(self):
        for key in ("lastfm_api_key", "discogs_token", "fanart_api_key"):
            for value in ("invalid key", "x" * 201):
                with self.subTest(key=key, value=value), \
                        patch.object(self.studio.queue_sync, "disconnect") as disconnect, \
                        patch.object(self.studio.music_uploads, "close") as close:
                    with self.assertRaises(client.ApiError):
                        self.studio.save_settings({"stream_quality": "320", "queue_sync": False,
                            "music_uploads": False, "artist_biographies": False,
                            "album_information": False, "lastfm_api_key": "valid-first-key", key: value})
                    self.assert_unchanged()
                    disconnect.assert_not_called()
                    close.assert_not_called()
        self.studio.save_settings({"auto_updates": False})
        restored = client.Studio(self.home.name)
        self.assertEqual(restored.config, {**self.before, "auto_updates": False})

    def test_invalid_enable_submission_keeps_oauth_scopes_and_runtime_gates_disabled(self):
        self.studio.save_settings({"queue_sync": False, "music_uploads": False})
        before, scopes = copy.deepcopy(self.studio.config), self.studio.scopes
        with self.assertRaises(client.ApiError):
            self.studio.save_settings({"queue_sync": True, "music_uploads": True,
                                       "lastfm_api_key": "invalid key"})
        self.assertEqual(self.studio.config, before)
        self.assertEqual(self.studio.scopes, scopes)

    def test_persistence_failure_preserves_disk_memory_revisions_and_running_services(self):
        with patch("tagcast.client.os.replace", side_effect=OSError("disk unavailable")), \
                patch.object(self.studio.queue_sync, "disconnect") as disconnect, \
                patch.object(self.studio.music_uploads, "close") as close:
            with self.assertRaises(OSError):
                self.studio.save_settings({"stream_quality": "320", "queue_sync": False,
                    "music_uploads": False, "artist_biographies": False, "album_information": False,
                    "discogs_token": "replacement"})
            self.assert_unchanged()
            disconnect.assert_not_called()
            close.assert_not_called()
            with self.assertRaises(OSError):
                self.studio.save_interface_language({"language": "nl"})
            self.assert_unchanged()

    def test_partial_submissions_preserve_omitted_values_and_commit_before_service_cleanup(self):
        def closed():
            self.assertFalse(self.studio.config["music_uploads"])
            self.assertEqual(client.Studio(self.home.name).config, self.studio.config)
        with patch.object(self.studio.music_uploads, "close", side_effect=closed) as close:
            self.studio.save_settings({"music_uploads": False})
        close.assert_called_once()
        self.assertEqual(self.studio.config, {**self.before, "music_uploads": False})
        self.assertEqual((self.studio.artist_bios.revision, self.studio.album_info.revision), self.revisions)
        current = copy.deepcopy(self.studio.config)
        with self.assertRaises(client.ApiError):
            self.studio.save_settings({"stream_quality": "orig", "auto_lookup": "false"})
        self.assertEqual(self.studio.config, current)
