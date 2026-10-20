"""Public playlist adapters use bounded, credential-free reads and ordinary import drafts."""

import copy
import json
import unittest
from unittest.mock import Mock, patch

import requests
import test_playlist_import as import_tests

from tagcast.library import ConflictError, LibraryError
from tagcast.playlist_import import PlaylistImport
from tagcast.playlist_sources import PLAYLIST_EXTENSION, PlaylistSources, identify, source_url

MBID = 'b7b80e46-8390-4ec7-8310-ef1707c9fafe'
LB_URL = 'https://listenbrainz.org/playlist/' + MBID
DZ_URL = 'https://www.deezer.com/nl/playlist/123?utm_source=share'


class Response:
    def __init__(self, data=None, *, status=200, content_type='application/json', location='', raw=None):
        self.status_code = status
        self.headers = {'Content-Type': content_type, 'Location': location}
        self.body = raw if raw is not None else json.dumps(data).encode()
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def iter_content(self, size):
        for i in range(0, len(self.body), size):
            yield self.body[i:i + size]


class Session:
    def __init__(self, responses):
        self.responses, self.calls, self.headers, self.closed = list(responses), [], {}, False

    def get(self, url, **options):
        self.calls.append((url, options))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def close(self):
        self.closed = True


def deezer_meta(**fields):
    return {'id': 123, 'public': True, 'nb_tracks': 1, 'title': 'My playlist', 'checksum': 'one', **fields}


def deezer_track(**fields):
    return {'id': 7, 'type': 'track', 'title': 'Cloudbusting', 'artist': {'name': 'Kate Bush'},
            'album': {'title': 'Hounds of Love'}, 'duration': 310, **fields}


def listenbrainz(**fields):
    return {'playlist': {'identifier': LB_URL, 'title': 'Test list',
                         'extension': {PLAYLIST_EXTENSION: {'public': True}},
                         'track': [{'title': 'Cloudbusting', 'creator': 'Kate Bush', 'album': 'Hounds of Love', 'duration': 310000}], **fields}}


class PlaylistSourcesTests(unittest.TestCase):
    def source(self, responses, check=None):
        session = Session(responses)
        source = PlaylistSources(Mock(), check or Mock(), session=session)
        return source, session

    def test_supported_links_normalize_ids_without_following_any_track_or_artwork_url(self):
        for url in (DZ_URL, 'https://deezer.com/playlist/123/', 'https://www.deezer.com/en-us/playlist/123'):
            self.assertEqual(identify(url), {'provider': 'deezer', 'id': '123'})
        self.assertEqual(identify(LB_URL.upper().replace('/PLAYLIST/', '/playlist/'))['id'], MBID)
        for url in ('http://deezer.com/playlist/123', 'https://deezer.com.evil.invalid/playlist/123',
                    'https://user:secret@deezer.com/playlist/123', 'https://deezer.com:8912/playlist/123',
                    'https://127.0.0.1/playlist/123', 'file:///music.csv', 'https://spotify.com/playlist/123',
                    'https://deezer.com/album/123', 'https://api.deezer.com/playlist/123', None, {},
                    'https://listenbrainz.org/playlist/not-a-uuid', 'https://deezer.com/playlist/0'):
            with self.subTest(url=url), self.assertRaises(LibraryError):
                identify(url)
        source, session = self.source([Response(deezer_meta()), Response({'total': 1, 'data': [deezer_track(link='https://private.invalid', preview='https://private.invalid/audio')]}), Response(deezer_meta())])
        result = source.fetch(DZ_URL)
        self.assertEqual(result['records'][0]['cells'][:4], ['Cloudbusting', 'Kate Bush', 'Hounds of Love', '310.0'])
        self.assertEqual(source_url(result['origin']), 'https://www.deezer.com/playlist/123')
        self.assertEqual(len(session.calls), 3)
        self.assertTrue(all(url.startswith('https://api.deezer.com/playlist/123') for url, _ in session.calls))
        self.assertTrue(all(options['allow_redirects'] is False and options['stream'] is True for _, options in session.calls))
        self.assertNotIn('Authorization', session.headers)
        self.assertTrue(session.closed)

    def test_pagination_preserves_order_repeats_versions_and_unavailable_positions(self):
        first = deezer_track(readable=False, title_version='(Live)')
        source, _ = self.source([Response(deezer_meta(nb_tracks=3)),
            Response({'total': 3, 'data': [first, first], 'next': 'https://api.deezer.com/playlist/123/tracks?index=2&limit=100'}),
            Response({'total': 3, 'data': [deezer_track(title='Last')]}), Response(deezer_meta(nb_tracks=3))])
        rows = source.fetch(DZ_URL)['records']
        self.assertEqual([row['cells'][0] for row in rows], ['Cloudbusting (Live)', 'Cloudbusting (Live)', 'Last'])
        self.assertEqual([row['line'] for row in rows], [2, 3, 4])

    def test_private_empty_oversized_partial_changed_or_hostile_deezer_lists_fail_entirely(self):
        cases = [[Response(deezer_meta(public=False))], [Response(deezer_meta(nb_tracks=0))],
                 [Response(deezer_meta(nb_tracks=10001))], [Response(deezer_meta(id=456))],
                 [Response(deezer_meta()), Response({'total': 1, 'data': []})],
                 [Response(deezer_meta()), Response({'total': 2, 'data': [deezer_track()]})],
                 [Response(deezer_meta(nb_tracks=2)), Response({'total': 2, 'data': [deezer_track()]})],
                 [Response(deezer_meta(nb_tracks=2)), Response({'total': 2, 'data': [deezer_track()], 'next': 'https://127.0.0.1/tracks?index=1'})],
                 [Response(deezer_meta(nb_tracks=2)), Response({'total': 2, 'data': [deezer_track()], 'next': 'https://api.deezer.com/playlist/123/tracks?index=0'})],
                 [Response(deezer_meta()), Response({'total': 1, 'data': [deezer_track()]}), Response(deezer_meta(checksum='changed'))]]
        for responses in cases:
            source, session = self.source(responses)
            with self.subTest(responses=responses), self.assertRaises(LibraryError):
                source.fetch(DZ_URL)
            self.assertTrue(session.closed)

    def test_short_links_resolve_only_to_supported_deezer_links_with_bounded_hops(self):
        source, session = self.source([Response(status=302, location=DZ_URL), Response(deezer_meta()),
            Response({'total': 1, 'data': [deezer_track()]}), Response(deezer_meta())])
        self.assertEqual(source.fetch('https://link.deezer.com/s/abc')['origin']['id'], '123')
        self.assertEqual(len(session.calls), 4)
        for location in ('http://deezer.com/playlist/123', 'https://127.0.0.1/private', 'https://evil.invalid/playlist/123'):
            source, session = self.source([Response(status=302, location=location)])
            with self.subTest(location=location), self.assertRaises(LibraryError):
                source.fetch('https://link.deezer.com/s/abc')
            self.assertEqual(len(session.calls), 1)
        source, session = self.source([Response(status=302, location='/s/again')] * 4)
        with self.assertRaises(LibraryError):
            source.fetch('https://link.deezer.com/s/abc')
        self.assertEqual(len(session.calls), 4)

    def test_listenbrainz_retains_missing_metadata_and_artist_credit_without_splitting_or_followups(self):
        payload = listenbrainz(track=[{'title': 'A; B', 'creator': 'Simon & Garfunkel', 'duration': 153880}, {}])
        source, session = self.source([Response(payload)])
        result = source.fetch(LB_URL)
        self.assertEqual(result['records'][0]['cells'], ['A; B', 'Simon & Garfunkel', '', '153.88', '', ''])
        self.assertEqual(result['records'][1]['cells'], [''] * 6)
        self.assertEqual(len(session.calls), 1)
        for mutation in ({'extension': {}}, {'extension': {PLAYLIST_EXTENSION: {'public': False}}},
                         {'track': []}, {'track': [None]}, {'identifier': 'https://evil.invalid/list'}):
            source, _ = self.source([Response(listenbrainz(**mutation))])
            with self.subTest(mutation=mutation), self.assertRaises(LibraryError):
                source.fetch(LB_URL)

    def test_network_json_size_deadline_and_disable_errors_never_return_partial_results(self):
        for response in (Response(status=403), Response(status=429), Response(raw=b'<html>Checking your browser</html>', content_type='text/html'),
                         Response(raw=b'invalid'), Response({'error': {'message': 'secret upstream details'}}),
                         Response([]), requests.Timeout()):
            source, session = self.source([response])
            with self.subTest(response=response), self.assertRaises(LibraryError):
                source.fetch(LB_URL)
            self.assertTrue(session.closed)
        source, _ = self.source([Response(listenbrainz())])
        with patch('tagcast.playlist_sources.MAX_PAGE_BYTES', 8), self.assertRaisesRegex(LibraryError, 'too large'):
            source.fetch(LB_URL)
        source, _ = self.source([Response(listenbrainz())])
        with patch('tagcast.playlist_sources.time.monotonic', return_value=source.deadline + 1), self.assertRaisesRegex(LibraryError, 'timed out'):
            source.fetch(LB_URL)
        source, session = self.source([], check=Mock(side_effect=ConflictError('Account changed')))
        with self.assertRaises(ConflictError):
            source.fetch(DZ_URL)
        self.assertEqual(session.calls, [])


class UrlImportTests(unittest.TestCase):
    setUp = import_tests.PlaylistImportTests.setUp
    body = import_tests.PlaylistImportTests.body

    def test_url_snapshot_uses_normal_matching_pause_resume_and_single_use_review(self):
        for origin in ({'provider': 'deezer', 'id': '123'}, {'provider': 'listenbrainz', 'id': MBID}):
            source, _ = PlaylistSourcesTests().source([Response(listenbrainz())])
            data = source.fetch(LB_URL)
            data['origin'] = origin
            with patch('tagcast.playlist_import.PlaylistSources') as adapter:
                adapter.return_value.fetch.return_value = data
                result = self.importer.read_url({'url': source_url(origin), 'session': 'session'})
                self.assertIsNone(result['mapping']['album'])
                self.assertEqual(result['mapping']['duration'], 3)
                matched = self.importer.match(self.body(result, mapping=result['mapping']))
                self.assertEqual(matched['rows'][0]['choice']['id'], '102')
                saved = self.importer.pause(self.body(matched, name=result['name']))['saved']
            self.importer = PlaylistImport(self.studio)
            with patch('tagcast.playlist_import.PlaylistSources') as adapter:
                resumed = self.importer.resume({'saved_id': saved['id'], 'saved_token': saved['token'], 'session': 'session'})
                self.assertEqual(resumed['file']['origin'], origin)
                self.assertEqual(resumed['file']['source_url'], source_url(origin))
                adapter.assert_not_called()
            review = self.importer.review(self.body(resumed['view'], name='Imported'))
            self.assertEqual(review['total'], 1)
            with self.assertRaises(LibraryError):
                self.importer.save(self.body(review, approved=False, review_token=review['review_token']))
        self.studio._current.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()

    def test_provider_disable_account_or_library_changes_and_concurrent_fetch_are_rejected(self):
        body = {'url': DZ_URL, 'session': 'session'}
        with patch('tagcast.playlist_import.PlaylistSources') as adapter:
            def disabled(url):
                self.studio.config['disabled_sources'] = ['deezer']
                adapter.call_args.args[1]('deezer')
            adapter.return_value.fetch.side_effect = disabled
            with self.assertRaisesRegex(LibraryError, 'disabled'):
                self.importer.read_url(body)
        self.assertEqual(self.importer.drafts, {})
        for change in ('library', 'account', 'session'):
            self.setUp()
            with patch('tagcast.playlist_import.PlaylistSources') as adapter:
                def replaced(url):
                    if change == 'library':
                        self.studio.library = copy.copy(self.studio.library)
                    elif change == 'account':
                        self.studio.library_user = 'other'
                    else:
                        self.studio.playback_session = 'other'
                    adapter.call_args.args[1]('deezer')
                adapter.return_value.fetch.side_effect = replaced
                with self.assertRaises(ConflictError):
                    self.importer.read_url(body)
            self.assertEqual(self.importer.drafts, {})
        self.setUp()
        self.importer.url_fetch_lock.acquire()
        with self.assertRaisesRegex(LibraryError, 'already'):
            self.importer.read_url(body)
        self.importer.url_fetch_lock.release()
