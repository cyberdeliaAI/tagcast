"""The normal candidate preserves native playback preferences without test restrictions."""
import os
import tempfile
import unittest
from unittest import mock

from tagcast import app, client


class ProductionPlaybackTests(unittest.TestCase):
    def test_normal_settings_survive_restart_and_ignore_the_old_validation_flag(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"TAGCAST_PLAYBACK_VALIDATION": "1"}):
            studio = client.Studio(home)
            self.assertFalse(hasattr(studio, "playback_validation"))
            self.assertFalse(hasattr(app, "VALIDATION_POSTS"))
            self.assertNotIn("playback_validation", studio.status())
            self.assertFalse(studio.settings()["record_plays"])
            self.assertFalse(studio.settings()["queue_sync"])
            saved = studio.save_settings({"stream_quality": "orig", "record_plays": True,
                                          "queue_sync": True, "auto_lookup": False})
            restarted = client.Studio(home).settings()
            for field in ("stream_quality", "record_plays", "queue_sync", "auto_lookup"):
                self.assertEqual(restarted[field], saved[field])
            self.assertTrue(restarted["record_plays"])
            self.assertTrue(restarted["queue_sync"])
