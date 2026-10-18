"""Lazy album background text: exact matching, local caching and stale-session guards."""

import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_library import lib
from test_sources import FakeHttp

from tagcast import client
from tagcast.album_info import AlbumInformation, AlbumInformationRetryError, album_information_key
from tagcast.library import ConflictError, LibraryError
from tagcast.sources import SourceError, TheAudioDB


class AlbumInformationSourceTests(unittest.TestCase):
    def source(self, rows):
        http = FakeHttp([('searchalbum.php', {'album': rows})])
        return TheAudioDB(http, {}), http

    def test_mambo_punctuation_is_preserved_when_an_album_has_no_english_description(self):
        source, http = self.source([{'idAlbum': '2309687', 'strArtist': 'Yma Sumac',
                                    'strAlbum': 'Mambo!', 'strDescription': None}])
        result = source.album_information('Yma Sumac', 'Mambo!')
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['url'], 'https://www.theaudiodb.com/album/2309687')
        self.assertEqual(result['description'], '')
        self.assertEqual(http.calls[0][1], {'s': 'Yma Sumac', 'a': 'Mambo!'})

    def test_exact_artist_and_full_title_are_required_and_only_public_text_is_returned(self):
        row = {'idAlbum': '2117780', 'strArtist': 'Camel', 'strAlbum': 'Mirage',
               'strDescription': 'An English album description.', 'strDescriptionES': 'Spanish text.',
               'strAlbumThumb': 'https://image.invalid/cover', 'private': 'excluded'}
        source, http = self.source([row])
        result = source.album_information('camel', 'MIRAGE')
        self.assertEqual(result, {'source': 'theaudiodb', 'language': 'en', 'status': 'ready',
                                 'artist': 'Camel', 'album': 'Mirage',
                                 'description': 'An English album description.',
                                 'url': 'https://www.theaudiodb.com/album/2117780'})
        self.assertEqual(http.calls[0][1], {'s': 'camel', 'a': 'MIRAGE'})
        for artist, album in [('The Camel', 'Mirage'), ('Camel', 'Mirage (Live)'),
                              ('Camel', 'Mirage [Deluxe]'), ('Camel', 'Mirage 2'),
                              ('Camel', 'Mirage!'), ('Cámel', 'Mirage')]:
            with self.subTest(artist=artist, album=album):
                self.assertEqual(source.album_information(artist, album)['status'], 'missing')

    def test_ambiguous_matches_missing_text_old_field_and_unicode_identity(self):
        row = {'idAlbum': '123', 'strArtist': 'Björk', 'strAlbum': 'Début', 'strDescriptionEN': 'Text.'}
        source, _ = self.source([row])
        self.assertEqual(source.album_information(' BJÖRK ', 'DÉBUT')['description'], 'Text.')
        source, _ = self.source([row, {**row, 'idAlbum': '124'}])
        self.assertEqual(source.album_information('Björk', 'Début')['status'], 'ambiguous')
        for value in ('', None, 123):
            source, _ = self.source([{**row, 'strDescriptionEN': value}])
            self.assertEqual(source.album_information('Björk', 'Début')['status'], 'unavailable')
        source, _ = self.source(None)
        self.assertEqual(source.album_information('Björk', 'Début')['status'], 'missing')

    def test_invalid_responses_and_ids_cannot_become_provider_links(self):
        row = {'strArtist': 'Camel', 'strAlbum': 'Mirage', 'strDescription': 'Text.'}
        for bad in ('//elsewhere', '１２３', '1' * 21, '', None):
            source, _ = self.source([{**row, 'idAlbum': bad}])
            with self.subTest(id=bad), self.assertRaises(SourceError):
                source.album_information('Camel', 'Mirage')
        for bad in ([1], 'bad', {'album': 'bad'}):
            source = TheAudioDB(FakeHttp([('searchalbum.php', bad)]), {})
            with self.subTest(response=bad), self.assertRaises(SourceError):
                source.album_information('Camel', 'Mirage')


class AlbumInformationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.studio = SimpleNamespace(
            home=Path(self.temp.name), lock=threading.RLock(), library=lib(),
            library_user='account-one', client=Mock(), playback_session='current-session',
            config={}, lookup=SimpleNamespace(http=Mock()))
        self.studio._require_client = lambda: self.studio.client
        self.info = AlbumInformation(self.studio)
        self.selection = {'album_id': '10', 'artist': 'Artist A', 'album': 'Original',
                          'session': 'current-session'}
        self.key = album_information_key('Artist A', 'Original')
        self.data = {'source': 'theaudiodb', 'language': 'en', 'status': 'ready',
                     'artist': 'Artist A', 'album': 'Original', 'description': 'Album background.',
                     'url': 'https://www.theaudiodb.com/album/123'}

    def enable(self):
        self.studio.config['album_information'] = True

    def test_off_by_default_and_cache_only_reads_never_contact_any_service(self):
        self.assertEqual(self.info.view({**self.selection, 'lookup': True}), {'enabled': False})
        self.assertFalse((self.studio.home / 'album-information.sqlite3').exists())
        self.enable()
        self.assertTrue(self.info.view(self.selection)['needs_lookup'])
        self.studio.lookup.http.json.assert_not_called()
        self.assertEqual(self.studio.client.mock_calls, [])

    def test_selection_rejects_stale_session_identity_and_inactive_albums(self):
        self.enable()
        for changes in ({'session': 'old'}, {'artist': 'Other'}, {'album': 'Old'},
                        {'album_id': '999'}, {'album_id': True}, {'lookup': 'true'}):
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.info.view({**self.selection, **changes, 'lookup': changes.get('lookup', True)})
        for track_id in (100, 101):
            self.studio.library.tracks.rows[track_id][6] = True
        with self.assertRaises(ConflictError):
            self.info.view(self.selection)
        self.studio.lookup.http.json.assert_not_called()

    def test_unnamed_and_various_artist_placeholders_are_not_searched(self):
        self.enable()
        for column, value in ((0, ''), (0, ' '), (1, 0)):
            self.studio.library = lib()
            self.studio.library.albums.rows[10][column] = value
            album = self.studio.library.album_summary(10)
            result = self.info.view({**self.selection, 'artist': album['artist'],
                                     'album': album['name'], 'lookup': True})
            self.assertEqual(result['reason'], 'missing_identity')
            self.assertFalse(result['needs_lookup'])
        self.studio.library = lib()
        self.studio.library.artists.rows[4][0] = ''
        self.assertEqual(self.info.view({**self.selection, 'artist': 'Unknown artist'})['reason'],
                         'missing_identity')
        self.studio.lookup.http.json.assert_not_called()
        self.assertFalse((self.studio.home / 'album-information.sqlite3').exists())

    def test_plain_public_text_persists_across_restarts_without_tokens_tracks_or_writes(self):
        self.enable()
        before = self.studio.library.to_cache()
        response = {**self.data, 'description': '<p>Music &amp; history.</p><script>bad()</script><p>Copyright source.</p>'}
        with patch.object(TheAudioDB, 'album_information', return_value=response) as fetch:
            result = self.info.view({**self.selection, 'lookup': True})
            self.assertEqual(result['description'], 'Music & history.\n\nCopyright source.')
            self.assertEqual(result['expires_at'] - result['fetched_at'], 30 * 86400)
            self.assertEqual(AlbumInformation(self.studio).view({**self.selection, 'lookup': True}), result)
            fetch.assert_called_once_with('Artist A', 'Original')
        self.assertEqual(self.studio.library.to_cache(), before)
        self.assertEqual(self.studio.client.mock_calls, [])
        with closing(sqlite3.connect(self.studio.home / 'album-information.sqlite3')) as db:
            [(data,)] = db.execute('SELECT data FROM albums').fetchall()
        self.assertEqual(set(json.loads(data)), {'source', 'language', 'status', 'artist', 'album', 'description', 'url'})

    def test_expired_text_returns_before_refresh_and_negative_matches_last_one_day(self):
        self.enable()
        with patch('tagcast.album_info.time.time', return_value=1000):
            self.info._write(self.key, self.data)
        with patch.object(TheAudioDB, 'album_information', return_value={**self.data, 'description': 'New text.'}) as fetch:
            old = self.info.view(self.selection)
            self.assertTrue(old['needs_lookup'])
            self.assertEqual(old['description'], self.data['description'])
            fetch.assert_not_called()
            self.assertEqual(self.info.view({**self.selection, 'lookup': True})['description'], 'New text.')
        for status in ('missing', 'ambiguous', 'unavailable'):
            self.info._write(self.key, {**self.data, 'description': '', 'status': status})
            with patch.object(TheAudioDB, 'album_information') as fetch:
                result = self.info.view({**self.selection, 'lookup': True})
                self.assertEqual(result['status'], status)
                self.assertEqual(result['expires_at'] - result['fetched_at'], 86400)
                fetch.assert_not_called()

    def test_late_results_after_session_settings_or_metadata_changes_are_discarded(self):
        for change in ('disable', 'library', 'account', 'client', 'session', 'revision', 'album', 'artist', 'trash'):
            with self.subTest(change=change):
                self.setUp()
                self.enable()

                def fetch(*_):
                    if change == 'disable':
                        self.studio.config['album_information'] = False
                    elif change == 'library':
                        self.studio.library = lib()
                    elif change == 'account':
                        self.studio.library_user = 'other'
                    elif change == 'client':
                        self.studio.client = Mock()
                    elif change == 'session':
                        self.studio.playback_session = 'other'
                    elif change == 'revision':
                        self.info.revision += 1
                    elif change == 'album':
                        self.studio.library.albums.rows[10][0] = 'Renamed'
                    elif change == 'artist':
                        self.studio.library.artists.rows[4][0] = 'Renamed'
                    else:
                        for i in (100, 101):
                            self.studio.library.tracks.rows[i][6] = True
                    return self.data.copy()

                with patch.object(TheAudioDB, 'album_information', side_effect=fetch), self.assertRaises(ConflictError):
                    self.info.view({**self.selection, 'lookup': True})
                self.assertIsNone(self.info._read(self.key))

    def test_provider_errors_keep_old_text_and_wait_for_explicit_retry_after_backoff(self):
        self.enable()
        with patch('tagcast.album_info.time.time', return_value=1000):
            self.info._write(self.key, self.data)
        with patch('tagcast.album_info.time.time', return_value=3_000_000), \
                patch.object(TheAudioDB, 'album_information', side_effect=SourceError('is busy')) as fetch:
            for _ in range(2):
                with self.assertRaises(AlbumInformationRetryError) as error:
                    self.info.view({**self.selection, 'lookup': True})
                self.assertEqual(error.exception.retry_after, 60)
            fetch.assert_called_once()
        with patch('tagcast.album_info.time.time', return_value=3_000_040.2), \
                patch.object(TheAudioDB, 'album_information', return_value=self.data.copy()) as fetch:
            self.assertEqual(self.info.view(self.selection)['description'], self.data['description'])
            with self.assertRaises(AlbumInformationRetryError) as error:
                self.info.view({**self.selection, 'lookup': True})
            self.assertEqual(error.exception.retry_after, 20)
            fetch.assert_not_called()
        with patch('tagcast.album_info.time.time', return_value=3_000_060), \
                patch.object(TheAudioDB, 'album_information', return_value=self.data.copy()) as fetch:
            self.assertEqual(self.info.view({**self.selection, 'lookup': True})['status'], 'ready')
            fetch.assert_called_once()
        self.assertEqual(self.info.failures, {})

    def test_simultaneous_visits_share_one_fetch_and_do_not_hold_the_session_lock(self):
        self.enable()
        entered, release = threading.Event(), threading.Event()

        def fetch(*_):
            entered.set()
            if not release.wait(3):
                raise AssertionError('Test did not release the provider request')
            return self.data.copy()

        with patch.object(TheAudioDB, 'album_information', side_effect=fetch) as lookup, \
                ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.info.view, {**self.selection, 'lookup': True}) for _ in range(4)]
            try:
                self.assertTrue(entered.wait(3))
                self.assertTrue(self.studio.lock.acquire(timeout=1))
                self.studio.lock.release()
            finally:
                release.set()
            for future in futures:
                self.assertEqual(future.result(timeout=3)['status'], 'ready')
            lookup.assert_called_once()

    def test_cache_is_bounded_and_damaged_data_is_not_overwritten(self):
        self.enable()
        with patch('tagcast.album_info.MAX_ENTRIES', 2):
            for i in range(5):
                self.info._write(album_information_key('Artist A', str(i)), {**self.data, 'album': str(i)})
        path = self.studio.home / 'album-information.sqlite3'
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM albums').fetchone()[0], 2)
        with patch('tagcast.album_info.MAX_BYTES', 400):
            for i in range(5):
                self.info._write(album_information_key('Artist A', str(i)), {**self.data, 'album': str(i)})
        with closing(sqlite3.connect(path)) as db:
            self.assertLessEqual(db.execute('SELECT sum(length(CAST(data AS BLOB))) FROM albums').fetchone()[0], 400)
        path.write_bytes(b'broken database')
        with self.assertRaisesRegex(LibraryError, 'local album information cache'):
            self.info.view(self.selection)
        self.assertEqual(path.read_bytes(), b'broken database')

    def test_wrong_cached_identity_urls_or_timestamps_are_rejected(self):
        self.enable()
        for changes in ({'album': 'Other'}, {'url': 'javascript:bad()'}, {'description': 'x' * 20001}):
            self.info._write(self.key, {**self.data, **changes})
            with self.subTest(changes=list(changes)), self.assertRaisesRegex(LibraryError, 'local album information cache'):
                self.info.view(self.selection)
        self.info._write(self.key, self.data)
        with closing(sqlite3.connect(self.studio.home / 'album-information.sqlite3')) as db, db:
            db.execute("UPDATE albums SET expires_at = 'invalid'")
        with self.assertRaises(LibraryError):
            self.info.view(self.selection)

    def test_settings_persist_independently_and_enabling_never_scans(self):
        studio = client.Studio(self.temp.name)
        self.assertFalse(studio.settings()['album_information'])
        with patch.object(studio.lookup.http, 'json') as fetch:
            result = studio.save_settings({'album_information': True})
            self.assertTrue(result['album_information'])
            self.assertEqual(result['album_information_revision'], 1)
            self.assertFalse(result['artist_biographies'])
            self.assertFalse(result['album_guide'])
            fetch.assert_not_called()
        self.assertFalse((studio.home / 'album-information.sqlite3').exists())
        self.assertTrue(client.Studio(self.temp.name).settings()['album_information'])
        for value in ('yes', 1, None, []):
            with self.subTest(value=value), self.assertRaises(client.ApiError):
                studio.save_settings({'album_information': value})
        self.assertEqual(studio.save_settings({'album_information': False})['album_information_revision'], 2)
