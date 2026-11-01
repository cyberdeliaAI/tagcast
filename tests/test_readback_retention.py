"""Read-back lifecycle and memory ownership, without a network or live library."""

import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from tagcast.client import ApiError, Studio


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
        with patch.object(studio, '_current', return_value=(snapshot, None)), \
                patch.object(studio.collections, 'playlist_count', return_value=1):
            job = studio._check_later(None, 0, lambda after: [{'status': 'saved'}])
            self.wait(studio, job)
        first = studio.job(job)
        self.assertIn('albums', first)
        self.assertIn('editor_names', first)
        self.assertNotIn('albums', studio.jobs[job])
        self.assertNotIn('editor_names', studio.jobs[job])
        self.assertEqual(studio.job(job)['results'], first['results'])
        self.assertIn('albums', first, 'Returning the payload must not mutate a response being serialized')

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
