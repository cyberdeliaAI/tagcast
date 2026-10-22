"""Lyrics never scan the library, fetch audio or silently replace native userdata."""

import copy
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_library import raw

from tagcast.library import ConflictError, Library, LibraryError
from tagcast.lyrics import MAX_LYRICS, Lyrics, fetch_lrclib
from tagcast.sources import SourceError


class LyricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        data = raw()
        data['library']['tracks']['map']['length'] = 8
        for key, row in data['library']['tracks'].items():
            if key != 'map':
                row.append(200)
        self.studio = SimpleNamespace(home=Path(self.temp.name), lock=threading.RLock(),
                                      save_lock=threading.Lock(), client=Mock(), library=Library(data),
                                      library_user='one', playback_session='session-one', premium=True)
        self.disabled = []
        self.studio.disabled_sources = lambda: self.disabled
        self.studio._require_client = lambda: self.studio.client
        self.studio._current = Mock()
        self.rows = [{'type': 'custom', 'name': 'Notes', 'value': 'Preserve me', 'unknown': 12}]
        self.studio.client._jsonrequest.side_effect = self.request
        self.service = Lyrics(self.studio)
        self.body = {'track_id': '100', 'title': 'Song One', 'artist': 'Artist A',
                     'session': 'session-one'}
        self.public = {'source': 'lrclib', 'status': 'ready', 'text': 'Test lyric line\nSecond line'}

    def request(self, mode, **kwargs):
        if mode == 'gettrackuserdata':
            self.assertEqual(kwargs, {'track_id': 100})
            return {'result': True, 'userdata': copy.deepcopy(self.rows)}
        self.assertEqual(mode, 'update_track')
        self.assertIs(kwargs['_retry'], False)
        self.assertEqual(len(kwargs['tracks']), 1)
        self.assertEqual(kwargs['tracks'][0]['file_id'], 100)
        self.rows = copy.deepcopy(kwargs['tracks'][0]['userdata'])
        return {'result': True}

    def prepare(self, after='User text'):
        data = self.service.view({**self.body, 'refresh': True})
        return self.service.prepare({**self.body, 'before_token': data['before_token'], 'lyrics': after})

    def test_native_text_takes_priority_without_any_provider_or_public_native_cache(self):
        self.rows.append({'type': 'lyrics', 'value': '<script>Text</script>\r\nVerse'})
        with patch('tagcast.lyrics.fetch_lrclib') as fetch:
            result = self.service.view({**self.body, 'lookup': True})
            self.assertEqual(result['text'], '<script>Text</script>\nVerse')
            self.assertEqual(result['source'], 'ibroadcast')
            self.assertFalse(result['can_lookup'])
            self.service.view(self.body)
            fetch.assert_not_called()
        self.assertEqual(self.studio.client._jsonrequest.call_count, 1)
        self.assertFalse((self.studio.home / 'lyrics.sqlite3').exists())

    def test_native_text_and_empty_results_survive_restart_without_userdata_or_tokens(self):
        for lyrics in ('Invented native verse\nSecond line', ''):
            with self.subTest(lyrics=lyrics):
                self.rows = self.rows[:1] + ([{'type': 'lyrics', 'value': lyrics}] if lyrics else [])
                self.service.view({**self.body, 'refresh': True})
                restarted = Lyrics(self.studio)
                self.studio.playback_session = 'new-session'
                body = {**self.body, 'session': 'new-session'}
                self.studio.client._jsonrequest.reset_mock()
                result = restarted.view(body)
                self.assertEqual(result['native_text'], lyrics)
                self.assertTrue(result['persisted'])
                self.assertNotIn('before_token', result)
                album_id = str(self.studio.library.active_track_album(100))
                restored = restarted.cached_album({'album_ids': [album_id], 'session': 'new-session'})
                self.assertEqual(restored['tracks'][0]['data']['native_text'], lyrics)
                self.studio.client._jsonrequest.assert_not_called()
                with closing(sqlite3.connect(self.studio.home / 'native-lyrics.sqlite3')) as db:
                    contents = str(db.execute('SELECT * FROM native_lyrics').fetchall())
                    for secret in ('Preserve me', 'Notes', 'before_token', 'session-one', 'new-session'):
                        self.assertNotIn(secret, contents)
                if os.name != 'nt':
                    self.assertEqual((self.studio.home / 'native-lyrics.sqlite3').stat().st_mode & 0o777, 0o600)
                self.studio.playback_session = 'session-one'

    def test_saved_native_cache_is_account_and_track_identity_bound_and_refreshable(self):
        self.rows.append({'type': 'lyrics', 'value': 'Before'})
        self.service.view(self.body)
        album_id = str(self.studio.library.active_track_album(100))
        body = {'album_ids': [album_id], 'session': 'session-one'}
        self.studio.library_user = 'other'
        self.assertEqual(Lyrics(self.studio).cached_album(body), {'tracks': []})
        self.studio.library_user = 'one'
        changed = raw()
        changed['library']['tracks']['100'][0] = 'Different title'
        original = self.studio.library
        self.studio.library = Library(changed)
        self.assertEqual(Lyrics(self.studio).cached_album(body), {'tracks': []})
        self.studio.library = original
        self.rows[-1]['value'] = 'After'
        self.assertEqual(Lyrics(self.studio).view(self.body)['text'], 'Before')
        self.assertEqual(self.service.view({**self.body, 'refresh': True})['text'], 'After')
        self.assertEqual(Lyrics(self.studio).view(self.body)['text'], 'After')
        self.studio.client._jsonrequest.reset_mock()
        for invalid in ({'album_ids': ['1'], 'session': 'other'}, {'album_ids': ['999'], 'session': 'session-one'},
                        {'album_ids': ['1'] * 21, 'session': 'session-one'}):
            with self.subTest(invalid=invalid), self.assertRaises(LibraryError):
                self.service.cached_album(invalid)
        self.studio.client._jsonrequest.assert_not_called()

    def test_native_cache_limits_and_corruption_do_not_start_remote_reads(self):
        with self.studio.lock:
            selection = self.service._selection(self.body)
        with patch('tagcast.lyrics.NATIVE_CACHE_BYTES', 5):
            self.service._native_store(selection, 'Longer than five bytes')
        self.assertIsNone(self.service._native_cached(selection))
        selections = [(selection[0], selection[1], account, selection[3], selection[4])
                      for account in ('first', 'second', 'third')]
        with patch('tagcast.lyrics.NATIVE_CACHE_ENTRIES', 2), patch('tagcast.lyrics.time.time', side_effect=[1, 2, 3]):
            for item in selections:
                self.service._native_store(item, 'Text')
        self.assertIsNone(self.service._native_cached(selections[0]))
        self.assertEqual(self.service._native_cached(selections[2]), 'Text')
        path = self.studio.home / 'native-lyrics.sqlite3'
        path.write_bytes(b'Not a SQLite database')
        with self.assertRaises(LibraryError):
            self.service.cached_album({'album_ids': [str(selection[4][1])], 'session': 'session-one'})
        self.studio.client._jsonrequest.assert_not_called()

    def test_corrupt_cache_initialization_closes_both_database_connections(self):
        connections = []

        class TrackedConnection(sqlite3.Connection):
            closed = False

            def close(self):
                self.closed = True
                super().close()

        connect = sqlite3.connect

        def tracked_connect(*args, **kwargs):
            db = connect(*args, **kwargs, factory=TrackedConnection)
            connections.append(db)
            return db

        for filename, open_db in [('native-lyrics.sqlite3', self.service._native_db),
                                  ('lyrics.sqlite3', self.service._db)]:
            with self.subTest(cache=filename):
                path = self.studio.home / filename
                path.write_bytes(b'Not a SQLite database')
                with patch('tagcast.lyrics.sqlite3.connect', side_effect=tracked_connect):
                    with self.assertRaises(sqlite3.DatabaseError):
                        open_db()
                self.assertTrue(connections[-1].closed)
                path.unlink()
        self.studio.client._jsonrequest.assert_not_called()

    def test_late_native_reads_are_not_persisted_for_a_replaced_account(self):
        self.rows.append({'type': 'lyrics', 'value': 'Private example'})
        original = self.request
        def replaced(mode, **kwargs):
            response = original(mode, **kwargs)
            self.studio.library_user = 'other'
            return response
        self.studio.client._jsonrequest.side_effect = replaced
        with self.assertRaises(ConflictError):
            self.service.view(self.body)
        with closing(sqlite3.connect(self.studio.home / 'native-lyrics.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM native_lyrics').fetchone()[0], 0)

    def test_lookup_is_explicit_cached_across_restart_and_never_writes_ibroadcast(self):
        with patch('tagcast.lyrics.fetch_lrclib', return_value=self.public) as fetch:
            self.assertEqual(self.service.view(self.body)['status'], 'not_cached')
            fetch.assert_not_called()
            result = self.service.view({**self.body, 'lookup': True})
            self.assertEqual(result['source'], 'lrclib')
            self.assertEqual(result['native_text'], '')
            self.assertEqual(Lyrics(self.studio).view(self.body)['text'], self.public['text'])
            fetch.assert_called_once()
            self.assertTrue(all(c.args[0] == 'gettrackuserdata' for c in self.studio.client._jsonrequest.call_args_list))
        with closing(sqlite3.connect(self.studio.home / 'lyrics.sqlite3')) as db:
            contents = str(db.execute('SELECT * FROM lyrics').fetchall())
            self.assertNotIn('Preserve me', contents)
            self.assertNotIn('session-one', contents)

    def test_disabled_source_hides_cached_public_lyrics_but_not_native_lyrics(self):
        with patch('tagcast.lyrics.fetch_lrclib', return_value=self.public):
            self.service.view({**self.body, 'lookup': True})
        self.disabled.append('lrclib')
        with patch('tagcast.lyrics.fetch_lrclib') as fetch:
            data = self.service.view({**self.body, 'lookup': True})
            self.assertFalse(data['can_lookup'])
            self.assertEqual(data['text'], '')
            fetch.assert_not_called()

    def test_bad_or_stale_selection_is_rejected_before_network_access(self):
        for change in ({'session': 'other'}, {'title': 'Other'}, {'artist': 'Other'},
                       {'track_id': '103'}, {'track_id': []}, {'track_id': '１００'}):
            with self.subTest(change=change), self.assertRaises(LibraryError):
                self.service.view({**self.body, **change})
        self.studio.client._jsonrequest.assert_not_called()

    def test_native_errors_or_malformed_userdata_do_not_become_empty_lyrics(self):
        for rows in (None, {}, [12], [{'type': 'lyrics', 'value': None}],
                     [{'type': 'lyrics', 'value': 'a'}, {'type': 'lyrics', 'value': 'b'}]):
            self.studio.client._jsonrequest.side_effect = None
            self.studio.client._jsonrequest.return_value = {'userdata': rows}
            with self.subTest(rows=rows), patch('tagcast.lyrics.fetch_lrclib') as fetch, self.assertRaises(LibraryError):
                self.service.view({**self.body, 'lookup': True})
            fetch.assert_not_called()

    def test_account_or_preferences_changed_during_lookup_reject_late_response(self):
        for mutate in (lambda: setattr(self.studio, 'library_user', 'two'),
                       lambda: self.disabled.append('lrclib')):
            with self.subTest(mutate=mutate):
                self.studio.library_user = 'one'
                self.disabled.clear()
                (self.studio.home / 'lyrics.sqlite3').unlink(missing_ok=True)
                self.service = Lyrics(self.studio)
                with patch('tagcast.lyrics.fetch_lrclib', side_effect=lambda _: (mutate(), self.public)[1]), self.assertRaises(ConflictError):
                    self.service.view({**self.body, 'lookup': True})

    def test_review_and_save_preserve_custom_userdata_and_read_back_once(self):
        review = self.prepare()
        self.assertEqual(review['before'], '')
        self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))
        self.assertEqual(self.service.save({'id': review['id'], 'approved': True}), {'status': 'saved'})
        self.assertEqual(self.rows[0], {'type': 'custom', 'name': 'Notes', 'value': 'Preserve me', 'unknown': 12})
        self.assertEqual(self.rows[1], {'type': 'lyrics', 'value': 'User text'})
        self.assertEqual(Lyrics(self.studio).view(self.body)['text'], 'User text')
        self.studio._current.assert_called_once_with(self.studio.client)
        with self.assertRaises(ConflictError):
            self.service.save({'id': review['id'], 'approved': True})
        self.assertEqual(sum(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list), 1)

    def test_blank_after_explicitly_removes_only_lyrics(self):
        self.rows.append({'type': 'lyrics', 'value': 'Old'})
        review = self.prepare('')
        self.service.save({'id': review['id'], 'approved': True})
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.rows[0]['type'], 'custom')
        self.assertEqual(Lyrics(self.studio).view(self.body)['native_text'], '')

    def test_cache_failure_after_confirmed_save_reports_saved_without_restoring_stale_text(self):
        review = self.prepare()
        with patch.object(self.service, '_native_store', side_effect=OSError('cache unavailable')):
            result = self.service.save({'id': review['id'], 'approved': True})
        self.assertEqual(result['status'], 'saved')
        self.assertIn('local lyrics cache', result['cache_error'])
        with self.studio.lock:
            self.assertIsNone(self.service._native_cached(self.service._selection(self.body)))
        self.assertEqual(self.rows[-1]['value'], 'User text')

    def test_custom_metadata_conflicts_block_prepare_and_save(self):
        before = self.service.view(self.body)
        self.rows[0]['value'] = 'Changed elsewhere'
        with self.assertRaises(ConflictError):
            self.service.prepare({**self.body, 'before_token': before['before_token'], 'lyrics': 'New'})
        self.service.native.clear()
        review = self.prepare()
        self.rows.append({'type': 'unknown', 'value': 'Later'})
        with self.assertRaises(ConflictError):
            self.service.save({'id': review['id'], 'approved': True})
        self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))

    def test_no_premium_or_explicit_confirmation_and_oversize_block_writes(self):
        self.studio.premium = False
        self.assertFalse(self.service.view(self.body)['can_save'])
        with self.assertRaises(LibraryError):
            self.prepare()
        self.studio.premium = True
        with self.assertRaises(LibraryError):
            self.prepare('a' * (MAX_LYRICS + 1))
        review = self.prepare()
        with self.assertRaises(LibraryError):
            self.service.save({'id': review['id']})

    def test_uncertain_write_and_unconfirmed_readback_are_not_retried(self):
        review = self.prepare()
        original = self.request
        def fail(mode, **kwargs):
            if mode == 'update_track':
                raise RuntimeError('connection lost after sending')
            return original(mode, **kwargs)
        self.studio.client._jsonrequest.side_effect = fail
        with self.assertRaises(RuntimeError):
            self.service.save({'id': review['id'], 'approved': True})
        with self.assertRaises(ConflictError):
            self.service.save({'id': review['id'], 'approved': True})
        self.studio.client._jsonrequest.side_effect = original
        review = self.prepare()
        def unchanged(mode, **kwargs):
            return {'result': True} if mode == 'update_track' else original(mode, **kwargs)
        self.studio.client._jsonrequest.side_effect = unchanged
        self.assertEqual(self.service.save({'id': review['id'], 'approved': True})['status'], 'unverified')
        with self.studio.lock:
            self.assertIsNone(self.service._native_cached(self.service._selection(self.body)))

    def test_new_native_lyrics_override_previously_cached_public_text(self):
        with patch('tagcast.lyrics.fetch_lrclib', return_value=self.public):
            self.service.view({**self.body, 'lookup': True})
        self.rows.append({'type': 'lyrics', 'value': 'Native wins'})
        self.service.native.clear()
        self.assertEqual(self.service.view({**self.body, 'refresh': True})['text'], 'Native wins')

    def test_session_change_expiry_and_another_save_block_reviewed_writes(self):
        review = self.prepare()
        self.studio.playback_session = 'other-session'
        with self.assertRaises(ConflictError):
            self.service.save({'id': review['id'], 'approved': True})
        self.studio.playback_session = 'session-one'
        review = self.prepare()
        with patch('tagcast.lyrics.time.monotonic', return_value=10**15), self.assertRaises(ConflictError):
            self.service.save({'id': review['id'], 'approved': True})
        review = self.prepare()
        self.studio.save_lock.acquire()
        try:
            with self.assertRaises(LibraryError):
                self.service.save({'id': review['id'], 'approved': True})
        finally:
            self.studio.save_lock.release()
        self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))



    def import_body(self, replace=False):
        album = self.studio.library.album_view(10)
        scope = {"combine_sets": bool(self.studio.library.combine_sets), "albums": [{
            "id": album["id"], "name": album["name"], "artist": album["artist"],
            "tracks": sorted(({key: t[key] for key in ("id", "title", "artist", "track")}
                              for t in album["tracks"]), key=lambda t: int(t["id"]))}]}
        data = self.service.view({**self.body, 'refresh': True})
        return {**self.body, "album_scope": scope, "replace_existing": replace,
                "before_token": data["before_token"], "lyrics": "Imported text"}

    def test_album_import_uses_existing_single_use_save_and_preserves_unknown_userdata(self):
        body = self.import_body()
        prepared = self.service.prepare(body)
        self.assertEqual(prepared['before'], '')
        self.assertEqual(prepared['after'], 'Imported text')
        result = self.service.save({'id': prepared['id'], 'approved': True})
        self.assertEqual(result['status'], 'saved')
        self.assertEqual(self.rows[0]['unknown'], 12)
        writes = [c for c in self.studio.client._jsonrequest.call_args_list if c.args[0] == 'update_track']
        self.assertEqual(len(writes), 1)
        with self.assertRaises(ConflictError):
            self.service.save({'id': prepared['id'], 'approved': True})

    def test_album_import_requires_explicit_replacement_of_existing_lyrics(self):
        self.rows.append({'type': 'lyrics', 'value': 'Existing text'})
        body = self.import_body()
        with self.assertRaisesRegex(ConflictError, 'replacement'):
            self.service.prepare(body)
        prepared = self.service.prepare({**body, 'replace_existing': True})
        self.assertEqual(prepared['before'], 'Existing text')
        self.assertEqual(prepared['after'], 'Imported text')
        for value in (None, 'true', 1):
            with self.subTest(value=value), self.assertRaises(LibraryError):
                self.service.prepare({**body, 'replace_existing': value})

    def test_album_import_scope_rejects_missing_members_stale_identity_and_foreign_tracks(self):
        body = self.import_body()
        for change in ('missing', 'number', 'title', 'foreign', 'combine', 'duplicate', 'multiple'):
            damaged = copy.deepcopy(body)
            album = damaged['album_scope']['albums'][0]
            if change == 'missing':
                album['tracks'].pop()
            elif change == 'number':
                album['tracks'][0]['track'] = 20
            elif change == 'title':
                album['name'] = 'Different'
            elif change == 'foreign':
                damaged['track_id'] = '102'
            elif change == 'combine':
                damaged['album_scope']['combine_sets'] = not damaged['album_scope']['combine_sets']
            elif change == 'multiple':
                album['id'] = '11'
            else:
                damaged['album_scope']['albums'].append(copy.deepcopy(album))
            with self.subTest(change=change), self.assertRaises(LibraryError):
                self.service.prepare(damaged)
        self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))

    def test_album_import_rechecks_full_album_after_fresh_remote_revision_before_send(self):
        body = self.import_body()
        prepared = self.service.prepare(body)
        def changed(*_):
            self.studio.library.tracks[101]._row[5] = 99
        # A different track's number changing also invalidates the reviewed matching scope.
        self.studio._current.side_effect = changed
        with self.assertRaises(ConflictError):
            self.service.save({'id': prepared['id'], 'approved': True})
        self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))


class LRCLIBTests(unittest.TestCase):
    def fetch(self, payload, status=200):
        response = Mock(status_code=status)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [json.dumps(payload).encode()]
        session = Mock()
        session.__enter__ = Mock(return_value=session)
        session.__exit__ = Mock(return_value=False)
        session.get.return_value = response
        with patch('tagcast.lyrics.requests.Session', return_value=session):
            result = fetch_lrclib({'title': 'Song (Live)', 'artist': 'Artist', 'length': 200})
        self.assertFalse(session.trust_env)
        self.assertIs(session.get.call_args.kwargs['allow_redirects'], False)
        self.assertEqual(session.get.call_args.kwargs['params']['track_name'], 'Song (Live)')
        return result

    def test_plain_or_synced_text_and_instrumental_with_full_version_matching(self):
        data = {'trackName': 'Song (Live)', 'artistName': 'Artist', 'duration': 201,
                'plainLyrics': 'Line\nNext', 'instrumental': False}
        self.assertEqual(self.fetch(data)['text'], 'Line\nNext')
        self.assertEqual(self.fetch({**data, 'plainLyrics': None, 'syncedLyrics': '[00:01.20]Line\n[00:03.00]Next'})['text'], 'Line\nNext')
        self.assertEqual(self.fetch({**data, 'instrumental': True})['status'], 'instrumental')
        for change in ({'trackName': 'Song'}, {'artistName': 'Another'}, {'duration': 204}, {'duration': True}):
            with self.subTest(change=change):
                self.assertEqual(self.fetch({**data, **change})['status'], 'missing')

    def test_missing_errors_redirects_and_oversized_text(self):
        self.assertEqual(self.fetch({}, 404)['status'], 'missing')
        for status in (302, 403, 429, 503):
            with self.subTest(status=status), self.assertRaises(SourceError):
                self.fetch({}, status)
        with self.assertRaises(SourceError):
            self.fetch({'trackName': 'Song (Live)', 'artistName': 'Artist', 'duration': 200,
                        'plainLyrics': 'x' * (MAX_LYRICS + 1)})
        with self.assertRaises(SourceError):
            self.fetch({'padding': 'x' * 600000})
