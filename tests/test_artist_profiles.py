"""Artist hearts and opt-in cached biographies, without network or real account data."""

import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_library import lib
from test_sources import FakeHttp

from tagcast.artist_bios import ArtistBiographies
from tagcast.collections import Collections
from tagcast.library import ConflictError, LibraryError
from tagcast.sources import SourceError, TheAudioDB


class ArtistProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name)

        def read(name):
            try:
                return json.loads((home / name).read_text())
            except (OSError, ValueError):
                return None

        def write(name, data):
            tmp = home / (name + '.tmp')
            tmp.write_text(json.dumps(data))
            tmp.replace(home / name)

        self.studio = SimpleNamespace(
            home=home, lock=threading.RLock(), library=lib(), library_user='account-one',
            client=Mock(), playback_session='current-session', config={},
            lookup=SimpleNamespace(http=Mock()), _read=read, _write=Mock(side_effect=write))
        self.studio._require_client = lambda: self.studio.client
        self.studio.source_keys = lambda: {}
        self.studio.collections = Collections(self.studio)
        self.bios = ArtistBiographies(self.studio)
        self.selection = {'artists': ['4'], 'name': 'Artist A', 'session': 'current-session'}
        self.body = {**self.selection, 'before': False, 'favourite': True}
        self.data = {'status': 'ready', 'source': 'theaudiodb', 'language': 'en', 'name': 'Artist A',
                     'biography': 'Artist A is a band.\n\nA second paragraph.',
                     'url': 'https://www.theaudiodb.com/artist/123'}

    def test_local_artist_favourites_keep_stable_ids_accounts_inactive_ids_and_ratings(self):
        before = self.studio.library.album_view(10)
        result = self.studio.collections.favourite_artist(self.body)
        self.assertEqual(result['results'], [{'id': '4', 'favourite': True}])
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['4'])
        self.assertEqual(Collections(self.studio).artist_favourites()['artists'], ['4'])
        self.studio.client.assert_not_called()
        self.assertEqual(self.studio.client.mock_calls, [])
        self.assertEqual(self.studio.library.album_view(10), before)
        self.studio.library.artists.rows[4][0] = 'Renamed A'
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['4'])
        self.studio.library_user = 'account-two'
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], [])
        self.studio.collections.favourite_artist({**self.body, 'name': 'Renamed A'})
        self.studio.library_user = 'account-one'
        # Inactive favourites stay in the file, but not in the active browser list.
        for i in (100, 101, 104):
            self.studio.library.tracks.rows[i][6] = True
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], [])
        saved = self.studio._read('artist-favourites.json')
        self.assertEqual(saved['accounts'], {'account-one': ['4'], 'account-two': ['4']})

    def test_artist_favourites_check_name_session_active_membership_and_previous_state(self):
        for body in ({**self.body, 'name': 'Old name'}, {**self.body, 'session': 'old'},
                     {**self.body, 'artists': ['6'], 'name': 'artist c'},
                     {**self.body, 'artists': ['4', '5']}):
            with self.subTest(body=body), self.assertRaises(ConflictError):
                self.studio.collections.favourite_artist(body)
        self.studio.collections.favourite_artist(self.body)
        with self.assertRaises(ConflictError):
            self.studio.collections.favourite_artist(self.body)
        self.studio.collections.favourite_artist({**self.body, 'before': True, 'favourite': False})
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], [])
        for body in ({**self.body, 'before': 0}, {**self.body, 'favourite': 'yes'},
                     {**self.body, 'artists': [0]}, {**self.body, 'artists': ['4', '4']}):
            with self.subTest(body=body), self.assertRaises(LibraryError):
                self.studio.collections.favourite_artist(body)

    def test_same_name_native_artists_need_the_complete_group_and_preserve_other_ids(self):
        self.studio.library.artists.rows[5][0] = 'Artist A'
        with self.assertRaises(ConflictError):
            self.studio.collections.favourite_artist(self.body)
        self.studio.collections.favourite_artist({**self.body, 'artists': ['4', '5']})
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['4', '5'])

    def test_artist_favourite_file_errors_preserve_data(self):
        self.studio.collections.favourite_artist(self.body)
        with patch.object(self.studio, '_write', side_effect=OSError('Disk full')):
            with self.assertRaisesRegex(LibraryError, 'Could not save'):
                self.studio.collections.favourite_artist({**self.body, 'before': True, 'favourite': False})
        path = self.studio.home / 'artist-favourites.json'
        original = path.read_text()
        self.assertIn('4', original)
        path.write_text('{damaged')
        with self.assertRaisesRegex(LibraryError, 'Could not read'):
            self.studio.collections.artist_favourites()
        self.assertEqual(path.read_text(), '{damaged')

    def test_biographies_are_off_by_default_and_enabling_or_reading_never_fetches(self):
        self.assertEqual(self.bios.view({**self.selection, 'lookup': True}), {'enabled': False})
        self.assertFalse((self.studio.home / 'artist-biographies.sqlite3').exists())
        self.studio.config['artist_biographies'] = True
        self.assertTrue(self.bios.view(self.selection)['needs_lookup'])
        self.studio.lookup.http.json.assert_not_called()
        self.assertEqual(self.studio.client.mock_calls, [])
        for body in ({**self.selection, 'lookup': 'true'}, {**self.selection, 'session': 'old'},
                     {**self.selection, 'name': 'Another name'}):
            with self.subTest(body=body), self.assertRaises(LibraryError):
                self.bios.view(body)

    def test_biography_is_plain_attributed_text_persisted_without_credentials_or_tracks(self):
        self.studio.config['artist_biographies'] = True
        response = {**self.data, 'biography': '<p>Band &amp; music</p><script>bad()</script><p>Copyright source.</p>'}
        with patch.object(TheAudioDB, 'biography', return_value=response) as lookup:
            saved = self.bios.view({**self.selection, 'lookup': True})
            self.assertEqual(saved['biography'], 'Band & music\n\nCopyright source.')
            self.assertFalse(saved['needs_lookup'])
            again = ArtistBiographies(self.studio).view({**self.selection, 'lookup': True})
            self.assertEqual(again, saved)
            lookup.assert_called_once_with('Artist A')
        db = sqlite3.connect(self.studio.home / 'artist-biographies.sqlite3')
        self.addCleanup(db.close)
        [(encoded,)] = db.execute('SELECT data FROM biographies').fetchall()
        self.assertEqual(set(json.loads(encoded)), {'source', 'status', 'language', 'name', 'biography', 'url'})
        self.assertEqual(self.studio.client.mock_calls, [])

    def test_expired_text_is_returned_before_a_separate_lookup_and_missing_text_is_cached(self):
        self.studio.config['artist_biographies'] = True
        with patch('tagcast.artist_bios.time.time', return_value=1000):
            self.bios._write('artist a', self.data)
        with patch.object(TheAudioDB, 'biography', return_value={**self.data, 'biography': 'New text.'}) as lookup:
            old = self.bios.view(self.selection)
            self.assertTrue(old['needs_lookup'])
            self.assertEqual(old['biography'], self.data['biography'])
            lookup.assert_not_called()
            result = self.bios.view({**self.selection, 'lookup': True})
            self.assertEqual(result['biography'], 'New text.')
        self.bios._write('artist a', {**self.data, 'biography': '', 'status': 'missing'})
        with patch.object(TheAudioDB, 'biography') as lookup:
            self.assertEqual(self.bios.view({**self.selection, 'lookup': True})['status'], 'missing')
            lookup.assert_not_called()

    def test_disable_account_or_library_change_during_fetch_discards_late_biographies(self):
        for change in ('disable', 'library', 'account', 'revision'):
            with self.subTest(change=change):
                self.studio.config['artist_biographies'] = True
                self.studio.library = lib()
                self.studio.library_user = 'account-one'

                def fetch(name):
                    if change == 'disable':
                        self.studio.config['artist_biographies'] = False
                    elif change == 'library':
                        self.studio.library = lib()
                    elif change == 'account':
                        self.studio.library_user = 'account-two'
                    else:
                        self.bios.revision += 1
                    return self.data.copy()

                with patch.object(TheAudioDB, 'biography', side_effect=fetch), self.assertRaises(ConflictError):
                    self.bios.view({**self.selection, 'lookup': True})
                self.assertIsNone(self.bios._read('artist a'))

    def test_failed_source_keeps_existing_text_and_backs_off_without_retries(self):
        self.studio.config['artist_biographies'] = True
        with patch('tagcast.artist_bios.time.time', return_value=1000):
            self.bios._write('artist a', self.data)
        with patch.object(TheAudioDB, 'biography', side_effect=SourceError('is busy')) as lookup:
            for _ in range(2):
                with self.assertRaisesRegex(SourceError, 'TheAudioDB is busy'):
                    self.bios.view({**self.selection, 'lookup': True})
            lookup.assert_called_once()
        self.assertEqual(self.bios.view(self.selection)['biography'], self.data['biography'])
        self.assertTrue(self.bios.view(self.selection)['needs_lookup'])

    def test_simultaneous_visits_share_one_lookup_and_cache_size_is_bounded(self):
        self.studio.config['artist_biographies'] = True
        results = []
        with patch.object(TheAudioDB, 'biography', return_value=self.data.copy()) as lookup:
            threads = [threading.Thread(target=lambda: results.append(self.bios.view({**self.selection, 'lookup': True}))) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)
            self.assertEqual(len(results), 4)
            lookup.assert_called_once()
        with patch('tagcast.artist_bios.MAX_ENTRIES', 2):
            for i in range(5):
                self.bios._write(str(i), self.data)
        with sqlite3.connect(self.studio.home / 'artist-biographies.sqlite3') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM biographies').fetchone()[0], 2)
        path = self.studio.home / 'artist-biographies.sqlite3'
        path.write_bytes(b'broken database')
        with self.assertRaisesRegex(LibraryError, 'local biography cache'):
            self.bios.view(self.selection)
        self.assertEqual(path.read_bytes(), b'broken database')


class BiographySourceTests(unittest.TestCase):
    def source(self, rows):
        http = FakeHttp([('search.php', {'artists': rows})])
        return TheAudioDB(http, {}), http

    def test_biography_needs_one_exact_name_and_constructs_a_provider_link(self):
        row = {'idArtist': '123', 'strArtist': 'Brand X', 'strBiographyEN': 'Text.',
               'strBiographyES': 'Spanish text.', 'strWebsite': 'javascript:bad()'}
        source, http = self.source([row])
        result = source.biography('brand x')
        self.assertEqual(result['biography'], 'Text.')
        self.assertEqual(result['language'], 'en')
        self.assertEqual(result['url'], 'https://www.theaudiodb.com/artist/123')
        self.assertEqual(http.calls[0][1], {'s': 'brand x'})
        for requested in ('Brand Y', 'The Brand X', 'Brand X (band)'):
            self.assertEqual(source.biography(requested)['status'], 'missing')
        source, _ = self.source([row, {**row, 'idArtist': '124'}])
        self.assertEqual(source.biography('Brand X')['status'], 'ambiguous')
        source, _ = self.source([{**row, 'idArtist': '//elsewhere'}])
        with self.assertRaises(SourceError):
            source.biography('Brand X')

    def test_missing_biography_does_not_require_an_artist_image(self):
        # A live v1 response names the English field without the EN suffix.
        source, _ = self.source([{'idArtist': '123', 'strArtist': 'Brand X', 'strBiography': 'Current English field.'}])
        self.assertEqual(source.biography('Brand X')['biography'], 'Current English field.')
        source, _ = self.source([{'idArtist': '123', 'strArtist': 'Brand X'}])
        self.assertEqual(source.biography('Brand X')['status'], 'unavailable')
        source, _ = self.source(None)
        self.assertEqual(source.biography('Brand X')['status'], 'missing')
