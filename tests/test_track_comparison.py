"""Read-only edition lookup: canned public data, no remote iBroadcast requests."""

import copy
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from test_library import lib
from test_sources import FakeHttp

from tagcast.library import ConflictError, LibraryError
from tagcast.sources import Lookup, MusicBrainz, SourceError
from tagcast.track_comparison import MAX_TRACKS, release, search, view

RID = '12345678-1234-1234-1234-123456789abc'
OTHER = '87654321-4321-4321-4321-cba987654321'


def raw_release():
    return {'id': RID, 'title': 'Album (Deluxe)', 'artist-credit': [{'name': 'Artist'}],
            'date': '1995-03-20', 'country': 'DE', 'status': 'Official', 'barcode': '123456',
            'label-info': [{'label': {'name': 'Label'}, 'catalog-number': 'CAT-1'}],
            'media': [{'position': 1, 'format': 'CD', 'track-count': 2, 'tracks': [
                {'position': 1, 'number': '1', 'title': 'Version (Live)', 'length': 180001},
                {'position': 2, 'number': '2', 'title': 'Version (Live)', 'length': None}]},
                {'position': 2, 'format': 'CD', 'track-count': 1, 'tracks': [
                    {'position': 1, 'number': 'A1', 'title': 'Bonus', 'length': 240000}]}],
            'private': 'not returned', 'relations': [{'url': 'https://evil.invalid'}]}


class PublicEditionTests(unittest.TestCase):
    def source(self, data):
        http = FakeHttp([('/release', data)])
        return MusicBrainz(http, {}), http

    def test_search_uses_specific_releases_with_literal_query_and_bounded_paging(self):
        source, http = self.source({'releases': [raw_release()], 'count': 300})
        result = search(source, 'Artist "X"', 'Album (Live)', '20')
        url, params, headers = http.calls[0]
        self.assertEqual(url, 'https://musicbrainz.org/ws/2/release')
        self.assertEqual(params, {'query': 'release:"Album (Live)" AND artist:"Artist \\"X\\""',
                                  'fmt': 'json', 'limit': 20, 'offset': 20})
        self.assertEqual(headers, {})
        self.assertTrue(result['more'])
        self.assertEqual(result['limit'], 200)
        candidate = result['releases'][0]
        self.assertEqual(candidate['labels'], [{'name': 'Label', 'catalogue': 'CAT-1'}])
        self.assertEqual(candidate['track_count'], 3)
        self.assertEqual(candidate['discs'], 2)
        self.assertNotIn('tracks', candidate)
        self.assertNotIn('private', candidate)
        self.assertFalse(search(source, 'Artist', 'Album', '180')['more'])

    def test_release_preserves_disc_and_position_order_repeats_version_text_and_unknowns(self):
        original = raw_release()
        source, http = self.source(original)
        result = release(source, RID)
        self.assertEqual(http.calls[0][1], {'inc': 'recordings artist-credits labels', 'fmt': 'json'})
        self.assertEqual([(t['disc'], t['number'], t['title']) for t in result['tracks']],
                         [(1, '1', 'Version (Live)'), (1, '2', 'Version (Live)'), (2, 'A1', 'Bonus')])
        self.assertEqual(result['tracks'][0]['length'], 180.001)
        self.assertIsNone(result['tracks'][1]['length'])
        self.assertFalse(result['incomplete'])
        self.assertEqual(original, raw_release(), 'Provider data stays unchanged')
        self.assertEqual(result['release']['url'], 'https://musicbrainz.org/release/' + RID)
        self.assertNotIn('relations', result['release'])

    def test_invalid_ids_searches_and_offsets_never_start_http(self):
        source, http = self.source({})
        for value in ['https://example.com', '../artist', RID + '?inc=secrets', '', None]:
            with self.subTest(value=value), self.assertRaises(LibraryError):
                release(source, value)
        for offset in ['-1', '1', '200', '1.0', '1' * 10000, 20, '２０']:
            with self.subTest(offset=offset), self.assertRaises(LibraryError):
                search(source, 'Artist', 'Album', offset)
        for artist, album in [('', 'Album'), ('Artist', ' '), ('x' * 201, 'Album')]:
            with self.assertRaises(LibraryError):
                search(source, artist, album, '0')
        self.assertEqual(http.calls, [])

    def test_missing_tracks_and_extra_sections_are_incomplete_not_confirmed_matches(self):
        for replacement in [{'tracks': []}, {'track-count': 3}, {'pregap': {'title': 'Hidden'}},
                            {'data-tracks': [{'title': 'Data'}]}, {'position': None}]:
            data = raw_release()
            data['media'][0].update(replacement)
            source, _ = self.source(data)
            self.assertTrue(release(source, RID)['incomplete'])
        source, _ = self.source({**raw_release(), 'media': []})
        self.assertTrue(release(source, RID)['incomplete'])

    def test_invalid_response_wrong_release_or_oversize_fails_without_followup_requests(self):
        for data in [None, [], {'id': OTHER}, {**raw_release(), 'media': [None]},
                     {**raw_release(), 'media': 'wrong'}]:
            source, http = self.source(data)
            with self.assertRaises(SourceError):
                release(source, RID)
            self.assertEqual(len(http.calls), 1)
        for invalid_search in [None, {'releases': [], 'count': -1}, {'releases': [], 'count': '2'}]:
            source, _ = self.source(invalid_search)
            with self.assertRaises(SourceError):
                search(source, 'Artist', 'Album', '0')
        data = raw_release()
        data['media'][0]['tracks'] *= MAX_TRACKS
        source, _ = self.source(data)
        with self.assertRaises(LibraryError):
            release(source, RID)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.studio = SimpleNamespace(lock=threading.RLock(), library=lib(), client=Mock(),
                                      library_user='one', playback_session='session', disabled_sources=[])
        self.studio._require_client = Mock(return_value=self.studio.client)
        self.studio.lookup = Lookup(lambda: {}, lambda: self.studio.disabled_sources)
        self.studio.lookup.http = FakeHttp([('/release', raw_release())])
        self.query = {'album_id': '10', 'session': 'session', 'id': RID}

    def test_loaded_library_is_read_only_and_no_library_or_status_call_is_made(self):
        before = copy.deepcopy(self.studio.library.album_view(10))
        result = view(self.studio, self.query, True)
        self.assertEqual(result['release']['id'], RID)
        self.assertEqual(before, self.studio.library.album_view(10))
        self.studio.client.assert_not_called()
        self.assertEqual(self.studio.client.method_calls, [])

    def test_stale_session_missing_library_and_disabled_source_block_before_http(self):
        for change in [lambda: setattr(self.studio, 'playback_session', 'two'),
                       lambda: setattr(self.studio, 'library', None),
                       lambda: self.studio.disabled_sources.append('musicbrainz')]:
            with self.subTest(change=change):
                self.setUp()
                change()
                with self.assertRaises((ConflictError, SourceError)):
                    view(self.studio, self.query, True)
                self.assertEqual(self.studio.lookup.http.calls, [])

    def test_oversized_loaded_album_is_rejected_before_public_io(self):
        self.studio.library.active_track_ids = Mock(return_value=list(range(1001)))
        with self.assertRaisesRegex(LibraryError, "1,000"):
            view(self.studio, self.query, True)
        self.assertEqual(self.studio.lookup.http.calls, [])

    def test_replacement_and_source_disable_during_io_reject_late_results_without_holding_lock(self):
        for field, value in [('client', Mock()), ('library', lib()), ('library_user', 'two'),
                             ('playback_session', 'two'), ('disabled_sources', ['musicbrainz']), ('album_title', 'Changed')]:
            self.setUp()
            entered, proceed = threading.Event(), threading.Event()
            original = self.studio.lookup.http.json
            errors = []

            def slow(*args, **kwargs):
                entered.set()
                self.assertTrue(proceed.wait(2))
                return original(*args, **kwargs)

            def run():
                try:
                    view(self.studio, self.query, True)
                except Exception as error:
                    errors.append(error)

            self.studio.lookup.http.json = slow
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertTrue(self.studio.lock.acquire(timeout=1), 'No library lock during public I/O')
                try:
                    if field == 'album_title':
                        self.studio.library.albums.rows[10][0] = value
                    else:
                        setattr(self.studio, field, value)
                finally:
                    self.studio.lock.release()
            finally:
                proceed.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], (ConflictError, SourceError))
            self.assertEqual(len(self.studio.lookup.http.calls), 1)
