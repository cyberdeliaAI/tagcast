"""Read-back lifecycle and memory ownership, without a network or live library."""

import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from tagcast.client import ApiError, Studio, UncertainWrite


class ReadbackRetentionTests(unittest.TestCase):
    def studio(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        return Studio(home.name)

    def wait(self, studio, job):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            with studio.lock:
                if studio.jobs.get(job, {}).get('state') != 'checking':
                    return
            time.sleep(.002)
        self.fail('Read-back did not complete')

    def test_summary_payload_is_delivered_once_and_released_from_stored_job(self):
        studio = self.studio()
        snapshot = Mock()
        snapshot.album_index.return_value = [{'name': 'Large summary', 'id': '1'}]
        snapshot.editor_names.return_value = {'artists': ['Artist']}
        studio.client, studio.library = object(), snapshot
        with patch.object(studio, '_current', return_value=(snapshot, None)), \
                patch.object(studio.collections, 'playlist_count', return_value=1):
            job = studio._check_later(studio.client, 0, lambda after: [{'status': 'saved'}])
            self.wait(studio, job)
        first = studio.job(job)
        self.assertIn('albums', first)
        self.assertIn('editor_names', first)
        self.assertNotIn('albums', studio.jobs[job])
        self.assertNotIn('editor_names', studio.jobs[job])
        self.assertEqual(studio.job(job)['results'], first['results'])
        self.assertIn('albums', first, 'Returning the payload must not mutate a response being serialized')

    def test_sent_trash_write_gets_an_unverified_receipt_after_session_replacement(self):
        for confirmed in (True, False):
            with self.subTest(confirmed=confirmed):
                studio = self.studio()
                old, replacement = Mock(), Mock()
                library = Mock(combine_sets=False)
                library.tracks = {1: {"trashed": True, "title": "Old track", "album_id": 1}}
                library.albums = {1: {"name": "Old album"}}
                library.artist_name.return_value = "Old artist"
                studio.client, studio.library = old, library
                studio.library_user, studio.playback_session = "old", "old-session"

                def replace_session(*args, **kwargs):
                    studio._disconnect()
                    with studio.lock:
                        studio.client, studio.library = replacement, Mock()
                        studio.library_user, studio.playback_session = "new", "new-session"
                    if not confirmed:
                        raise UncertainWrite("The write response was lost.")
                    return {"result": True}

                old._jsonrequest.side_effect = replace_session
                with patch.object(studio, "_current", return_value=(library, "memory")) as current:
                    body = {"session": studio.playback_session}
                    review = studio.trash_emptying.review(body)
                    receipt = studio.trash_emptying.save({
                        **body, "review": review["review"], "approved": True, "acknowledged": True,
                    })
                    self.assertEqual(current.call_count, 2, "No read-back under the new owner")
                old._jsonrequest.assert_called_once_with("empty_trash", _retry=False, tracks=[1])
                replacement._jsonrequest.assert_not_called()
                self.assertEqual(receipt["count"], 1)
                job = studio.job(receipt["job"])
                self.assertEqual(set(job), {"state", "error"})
                self.assertEqual(job["state"], "error")
                self.assertIn("write outcome is unknown", job["error"])
                self.assertNotIn("Old", job["error"])
                self.assertFalse(studio.readbacks)

    def test_checking_jobs_are_not_pruned_and_disconnect_prevents_reinsertion(self):
        studio = self.studio()
        entered, release = threading.Event(), threading.Event()
        def current(*args, **kwargs):
            entered.set()
            release.wait(3)
            return Mock(), None
        with patch.object(studio, '_current', side_effect=current), \
                patch.object(studio.collections, 'playlist_count', return_value=0):
            job = studio._check_later(None, 0, lambda after: [], include_albums=False)
            self.assertTrue(entered.wait(3))
            with studio.lock:
                studio.jobs.update({f'old-{i}': {'state': 'done'} for i in range(25)})
            other = studio._check_later(None, 0, lambda after: [], include_albums=False)
            self.assertIn(job, studio.jobs)
            studio._disconnect()
            release.set()
            self.wait(studio, other)
            time.sleep(.02)
        self.assertFalse(studio.jobs)
        with self.assertRaises(ApiError):
            studio.job(job)
