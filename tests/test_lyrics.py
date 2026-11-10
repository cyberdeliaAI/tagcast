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
        self.library_data = data
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

    def test_legacy_public_cache_does_not_hide_the_improved_search_or_modify_native_cache(self):
        for status, value in (('missing', ''), ('ready', '[00:01]<00:01>Legacy word timing')):
            self.service._cache(json.dumps(['song one', 'artist a', 200]),
                                {'source': 'lrclib', 'status': status, 'text': value})
            with patch('tagcast.lyrics.fetch_lrclib', return_value=self.public) as fetch:
                result = self.service.view(self.body)
                self.assertEqual(result['status'], 'not_cached')
                self.assertTrue(result['can_lookup'])
                fetch.assert_not_called()
                self.assertEqual(self.service.view({**self.body, 'lookup': True})['text'], self.public['text'])
                fetch.assert_called_once()
            with closing(sqlite3.connect(self.studio.home / 'native-lyrics.sqlite3')) as db:
                self.assertEqual(db.execute('SELECT lyrics FROM native_lyrics').fetchall(), [('',)])
            # Recreate only the public cache for the second legacy format.
            (self.studio.home / 'lyrics.sqlite3').unlink()

    def test_found_timed_lyrics_are_plain_text_and_save_only_after_existing_review(self):
        timed = {'status': 'ready', 'source': 'lrclib', 'timed': True, 'lines': [
            {'start': 1, 'end': 2, 'text': 'First line', 'words': [
                {'start': 1, 'end': 2, 'text': 'First line'}]},
            {'start': 2, 'end': 3, 'text': ''}, {'start': 3, 'end': 5, 'text': 'Second line'}]}
        with patch('tagcast.lyrics.fetch_lrclib_display', return_value=timed), \
                patch('tagcast.playback_lyrics.fetch_unison') as unison:
            found = self.service.view({**self.body, 'lookup': True})
            self.assertEqual(found['text'], 'First line\n\nSecond line')
            self.assertEqual(found['native_text'], '')
            self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))
            review = self.service.prepare({**self.body, 'before_token': found['before_token'], 'lyrics': found['text']})
            self.assertEqual(review['after'], found['text'])
            self.assertFalse(any(c.args[0] == 'update_track' for c in self.studio.client._jsonrequest.call_args_list))
            self.assertEqual(self.service.save({'id': review['id'], 'approved': True})['status'], 'saved')
            self.assertEqual([row['value'] for row in self.rows if row['type'] == 'lyrics'], [found['text']])
            self.assertEqual(self.rows[0]['value'], 'Preserve me')
            unison.assert_not_called()
        with closing(sqlite3.connect(self.studio.home / 'lyrics.sqlite3')) as db:
            stored = json.loads(db.execute('SELECT data FROM lyrics').fetchone()[0])
            self.assertEqual(stored, {'source': 'lrclib', 'status': 'ready', 'text': found['text']})

    def test_lookup_uses_album_identity_and_account_checks_without_player_track_cancellation(self):
        def found(track, album, current, policy, **options):
            self.assertEqual(album, self.studio.library.albums[10]['name'])
            self.assertIs(policy, self.service.display)
            self.assertEqual(options, {'plain_text': True})
            # An unrelated Now playing selection must not cancel explicit editor work.
            policy.revision += 1
            current()
            return {'status': 'ready', 'lines': [{'text': 'Explicit editor result'}]}
        with patch('tagcast.lyrics.fetch_lrclib_display', side_effect=found):
            self.assertEqual(self.service.view({**self.body, 'lookup': True})['text'], 'Explicit editor result')
        with self.studio.lock:
            first = self.service._selection(self.body)
            other = list(first)
            other[4] = [*first[4][:-1], 'Different album']
            self.assertNotEqual(self.service._public_key(first), self.service._public_key(other))

    def test_temporary_lookup_error_keeps_retry_after_and_does_not_cache_missing(self):
        failure = SourceError('Temporary provider error')
        failure.retry_after = 1
        with patch('tagcast.lyrics.time.monotonic', return_value=100), \
                patch('tagcast.lyrics.fetch_lrclib', side_effect=failure):
            with self.assertRaises(SourceError):
                self.service.view({**self.body, 'lookup': True})
        self.assertEqual(self.service.display.backoff['lrclib'], 101)
        self.assertEqual(self.service.display.backoff['unison'], 0)
        with closing(sqlite3.connect(self.studio.home / 'lyrics.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM lyrics').fetchone()[0], 0)
        self.assertEqual(self.service.view(self.body)['status'], 'not_cached')

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
                with patch('tagcast.lyrics.fetch_lrclib', side_effect=lambda *_: (mutate(), self.public)[1]), self.assertRaises(ConflictError):
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

    def test_applied_lyrics_with_lost_reply_verify_all_userdata_without_retry(self):
        from tagcast.client import UncertainWrite

        for modified in (False, True):
            with self.subTest(custom_metadata_changed=modified):
                self.studio.client._jsonrequest.side_effect = self.request
                review = self.prepare("Reviewed text changed" if modified else "Reviewed text")
                sent = []
                def lost(mode, **fields):
                    result = self.request(mode, **fields)
                    if mode == "update_track":
                        sent.append(mode)
                        if modified:
                            self.rows[0]["value"] = "External change"
                        raise UncertainWrite("Applied, reply lost")
                    return result
                self.studio.client._jsonrequest.side_effect = lost
                result = self.service.save({"id": review["id"], "approved": True})
                self.assertEqual(result["status"], "unverified" if modified else "saved")
                self.assertEqual(sent, ["update_track"])
                with self.assertRaises(ConflictError):
                    self.service.save({"id": review["id"], "approved": True})

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

    def test_import_prepare_reuses_review_snapshot_but_save_checks_remote_data(self):
        body = self.import_body()
        self.studio.client._jsonrequest.reset_mock()
        prepared = self.service.prepare(body)
        self.studio.client._jsonrequest.assert_not_called()
        self.assertEqual(self.service.save({'id': prepared['id'], 'approved': True}),
                         {'status': 'saved'})
        self.studio._current.assert_called_once_with(self.studio.client)
        self.assertEqual([c.args[0] for c in self.studio.client._jsonrequest.call_args_list],
                         ['gettrackuserdata', 'update_track', 'gettrackuserdata'])
        self.assertEqual(self.rows[0]['unknown'], 12)

    def test_import_cached_review_never_skips_final_conflict_check(self):
        body = self.import_body()
        self.rows[0]['value'] = 'Changed in another app after review'
        prepared = self.service.prepare(body)
        with self.assertRaises(ConflictError):
            self.service.save({'id': prepared['id'], 'approved': True})
        self.assertFalse(any(c.args[0] == 'update_track'
                             for c in self.studio.client._jsonrequest.call_args_list))
        with self.assertRaises(ConflictError):
            self.service.save({'id': prepared['id'], 'approved': True})

    def test_import_snapshot_survives_library_refresh_only_with_matching_identity(self):
        body = self.import_body()
        self.studio.library = Library(copy.deepcopy(self.library_data))
        self.studio.client._jsonrequest.reset_mock()
        prepared = self.service.prepare(body)
        self.studio.client._jsonrequest.assert_not_called()
        self.assertEqual(self.service.save({'id': prepared['id'], 'approved': True})['status'],
                         'saved')

    def test_import_prepare_fetches_again_for_expired_or_other_session_snapshots(self):
        for changed in ('expired', 'session', 'account', 'client', 'token', 'evicted'):
            with self.subTest(changed=changed):
                body = self.import_body()
                if changed == 'expired':
                    item = self.service.native['100']
                    self.service.native['100'] = (item[0] - 901, *item[1:])
                elif changed == 'session':
                    self.service.context = (*self.service.context[:3], 'different-session')
                elif changed == 'account':
                    self.service.context = (*self.service.context[:2], 'different-account',
                                            self.service.context[3])
                elif changed == 'client':
                    self.service.context = (Mock(), *self.service.context[1:])
                elif changed == 'token':
                    body['before_token'] = 'invalid'
                else:
                    self.service.native.clear()
                self.studio.client._jsonrequest.reset_mock()
                if changed == 'token':
                    with self.assertRaises(ConflictError):
                        self.service.prepare(body)
                else:
                    self.service.prepare(body)
                self.studio.client._jsonrequest.assert_called_once_with('gettrackuserdata',
                                                                       track_id=100)

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
    """Exercise the editor adapter through the actual shared provider/search parser."""

    def fetch(self, replies, track=None, album='Album', current=None):
        self.session = Mock(headers={})
        contexts = []
        for status, data, *extra in replies:
            headers = extra[0] if extra else {'Content-Type': 'application/json'}
            response = Mock(status_code=status, headers=headers)
            response.iter_content.return_value = [json.dumps(data).encode()]
            context = Mock()
            context.__enter__ = Mock(return_value=response)
            context.__exit__ = Mock(return_value=False)
            contexts.append(context)
        self.session.get.side_effect = contexts
        self.clock = 100.
        def sleep(delay):
            self.clock += delay
        with patch('tagcast.playback_lyrics.requests.Session') as create, \
                patch('tagcast.playback_lyrics.time.monotonic', side_effect=lambda: self.clock), \
                patch('tagcast.playback_lyrics.time.sleep', side_effect=sleep), \
                patch('tagcast.playback_lyrics.fetch_unison') as unison:
            create.return_value.__enter__.return_value = self.session
            result = fetch_lrclib(track or {'title': 'Song (Live)', 'artist': 'Artist', 'length': 200},
                                  album, current or Mock())
            unison.assert_not_called()
        self.assertFalse(self.session.trust_env)
        self.assertEqual(set(self.session.headers), {'User-Agent', 'Accept'})
        for call in self.session.get.call_args_list:
            self.assertFalse(call.kwargs['allow_redirects'])
            self.assertEqual(set(call.kwargs['params']) - {'track_name', 'artist_name', 'album_name', 'duration'}, set())
            self.assertTrue(call.args[0].startswith('https://lrclib.net/api/'))
        return result

    def record(self, **fields):
        return {'trackName': 'Song (Live)', 'artistName': 'Artist', 'duration': 201,
                'albumName': 'Album', 'plainLyrics': 'Line\nNext', 'instrumental': False, **fields}

    def test_plain_synced_and_enhanced_lrc_are_text_only_with_no_automatic_writes(self):
        self.assertEqual(self.fetch([(200, [self.record()])])['text'], 'Line\nNext')
        self.assertEqual(self.session.get.call_args.args[0], 'https://lrclib.net/api/search')
        self.session.get.assert_called_once()
        value = '[ar:Test artist]\n[offset:500]\n[00:01.20]<00:01.20>Line <00:01.80>one<00:02.10>\n[00:02.5]\n[00:03.00]Next'
        result = self.fetch([(200, [self.record(plainLyrics=None, syncedLyrics=value)])])
        self.assertEqual(result, {'status': 'ready', 'source': 'lrclib', 'text': 'Line one\n\nNext'})
        self.assertNotRegex(result['text'], r'offset:|ar:|<\d+:|\[\d+:')
        self.assertEqual(self.fetch([(200, [self.record(instrumental=True)])])['status'], 'instrumental')

    def test_lyricsfile_words_and_line_timing_never_enter_the_editor(self):
        document = {"version": "1.0", "metadata": {"title": "Song (Live)", "artist": "Artist"},
                    "lines": [{"start_ms": 1000, "end_ms": 4000, "text": "Synthetic words", "words": [
                        {"start_ms": 1000, "end_ms": 2000, "text": "Synthetic "},
                        {"start_ms": 2000, "end_ms": 4000, "text": "words"}]}]}
        result = self.fetch([(200, [self.record(plainLyrics=None, syncedLyrics=None,
                                               lyricsfile=json.dumps(document), hasWordSync=True)])])
        self.assertEqual(result, {'status': 'ready', 'text': 'Synthetic words', 'source': 'lrclib'})

    def test_valid_plain_text_keeps_priority_over_different_or_invalid_timing(self):
        for synced in ('[00:01]Different timed text', '[99:99]Invalid timed text'):
            result = self.fetch([(200, [self.record(syncedLyrics=synced)]), (404, {})])
            self.assertEqual(result['text'], 'Line\nNext')
            self.session.get.assert_called_once()

    def test_version_labels_and_credits_match_with_duration_but_live_and_unknown_stay_strict(self):
        track = {'title': 'Song - Remastered 2011', 'artist': 'Prince & The Revolution', 'length': 200}
        hit = self.record(trackName='Song', artistName='Prince The Revolution', duration=200)
        self.assertEqual(self.fetch([(200, []), (200, [hit])], track)['status'], 'ready')
        self.assertEqual(self.session.get.call_args.kwargs['params'], {'track_name': 'Song', 'artist_name': 'Prince'})
        for fields in ({'trackName': 'Song'}, {'artistName': 'Another'}, {'duration': 204}, {'duration': True}):
            self.assertEqual(self.fetch([(200, [self.record(**fields)]), (404, {})])['status'], 'missing')
        unknown = {'title': 'Song (Live)', 'artist': 'Artist', 'length': 0}
        self.assertEqual(self.fetch([(200, [self.record(), self.record(duration=200)])], unknown)['status'], 'missing')
        self.assertEqual(self.fetch([(200, [self.record()])], unknown)['status'], 'ready')
        self.assertEqual(self.fetch([(200, [self.record()]), (404, {})], unknown, album='Other')['status'], 'missing')

    def test_get_fallback_and_one_short_retry_use_the_shared_request_policy(self):
        result = self.fetch([(503, {}, {'Retry-After': '1'}), (200, [self.record()])])
        self.assertEqual(result['status'], 'ready')
        self.assertAlmostEqual(self.clock, 101)
        self.assertEqual(self.session.get.call_count, 2)
        self.assertTrue(all(call.args[0].endswith('/search') for call in self.session.get.call_args_list))
        result = self.fetch([(200, []), (200, self.record())])
        self.assertEqual(result['status'], 'ready')
        self.assertTrue(self.session.get.call_args.args[0].endswith('/get'))
        self.assertEqual(self.session.get.call_args.kwargs['params']['album_name'], 'Album')

    def test_missing_redirects_long_backoff_and_invalid_or_oversized_responses(self):
        self.assertEqual(self.fetch([(404, {}), (404, {})])['status'], 'missing')
        for status in (302, 307, 308, 403):
            with self.subTest(status=status), self.assertRaises(SourceError):
                self.fetch([(status, {})])
            self.session.get.assert_called_once()
        for reply in ((429, {}, {'Retry-After': '180'}), (503, {}, {'Retry-After': '180'})):
            with self.assertRaises(SourceError) as raised:
                self.fetch([reply])
            self.assertEqual(raised.exception.retry_after, 180)
            self.session.get.assert_called_once()
            self.assertEqual(self.clock, 100)
        with self.assertRaises(SourceError):
            self.fetch([(200, {'padding': 'x' * 600000})])
        with self.assertRaises(SourceError):
            self.fetch([(200, {}, {'Content-Type': 'text/html'})])
        self.assertEqual(self.fetch([(200, [self.record(plainLyrics='x' * (MAX_LYRICS + 1))]),
                                     (404, {})])['status'], 'missing')

    def test_joining_timed_lines_cannot_exceed_the_plain_text_save_limit(self):
        lines = [{'text': 'x' * 25, 'start': None, 'end': None} for _ in range(2000)]
        with patch('tagcast.lyrics.fetch_lrclib_display', return_value={'status': 'ready', 'lines': lines}), \
                self.assertRaises(SourceError):
            fetch_lrclib({'title': 'Test', 'artist': 'Artist', 'length': 200}, 'Album')

    def test_replaced_context_stops_before_the_next_provider_step(self):
        current = Mock(side_effect=[None, None, None, None, None, ConflictError('Replaced')])
        with self.assertRaises(ConflictError):
            self.fetch([(200, []), (200, self.record())], current=current)
        self.assertLessEqual(self.session.get.call_count, 1)
