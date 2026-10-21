"""Reviewed native collection writes and the optional queue protocol, without a real account."""
import copy
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import certifi
from test_client import client, mock_ibroadcast
from test_library import change

from tagcast.library import ConflictError, LibraryError
from tagcast.queue_sync import QUEUE_SCOPES, clean_state


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.original = copy.deepcopy(mock_ibroadcast.STATE)
        mock_ibroadcast.STATE.update(reject=set(), busy=0, frozen=False, playlists={}, premium=False)
        mock_ibroadcast.STATE['writes'] = []
        self.home = tempfile.TemporaryDirectory()
        self.studio = client.Studio(self.home.name)
        self.studio.set_client_id('test')
        self.studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, 'refresh-1', time.time() + 3600, client.SCOPES + QUEUE_SCOPES))
        self.studio.load_library()

    def tearDown(self):
        self.studio.queue_sync.disconnect()
        # Cache writes run briefly in the background; join before cleaning settings.
        with self.studio.cache_lock:
            pass
        self.home.cleanup()
        mock_ibroadcast.STATE.clear()
        mock_ibroadcast.STATE.update(self.original)

    def job(self, response):
        for _ in range(100):
            result = self.studio.job(response['job'])
            if result['state'] != 'checking':
                return result
            time.sleep(.02)
        self.fail('Read-back did not finish')

    def test_playlist_duration_counts_every_active_position_without_extra_library_reads(self):
        mock_ibroadcast.STATE['playlists'][888] = {
            'name': 'Long list', 'tracks': [900] * 101 + [901, 903, 904, 999999]}
        mock_ibroadcast.STATE['tracks'][900]['length'] = 180
        mock_ibroadcast.STATE['tracks'][901]['length'] = 61
        mock_ibroadcast.STATE['tracks'][903]['length'] = None
        mock_ibroadcast.STATE['tracks'][904].update(length=999, trashed=True)
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        with patch.object(self.studio.client, 'fetch_library', side_effect=AssertionError('No download')):
            first = self.studio.collections.playlists(playlist_id='888')
            second = self.studio.collections.playlists(playlist_id='888', offset='100')
        self.assertEqual(first['total'], 103)
        self.assertEqual(len(first['rows']), 100)
        self.assertEqual(len(second['rows']), 3)
        self.assertEqual(first['duration'], 101 * 180 + 61)
        self.assertEqual(second['duration'], first['duration'])
        self.assertEqual(first['duration_missing'], 1)
        self.assertEqual(second['duration_missing'], 1)

    def test_empty_playlist_duration_is_zero(self):
        mock_ibroadcast.STATE['playlists'][888] = {'name': 'Empty', 'tracks': []}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        view = self.studio.collections.playlists(playlist_id='888')
        self.assertEqual((view['total'], view['duration'], view['duration_missing']), (0, 0, 0))

    def playlist_order_body(self, tracks=None):
        mock_ibroadcast.STATE['playlists'][888] = {
            'name': 'Original name', 'description': 'Keep description', 'artwork_id': 77,
            'tracks': tracks if tracks is not None else [900, 901, 900, 999999, 902], 'type': None}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        view = self.studio.collections.playlists(playlist_id='888')
        return {'action': 'reorder', 'playlist': '888', 'before_token': view['before_token'],
                'before_name': view['name'], 'session': self.studio.playback_session, 'approved': True,
                'positions': [3, 2, 1, 4, 0]}

    def test_playlist_order_pages_read_only_loaded_positions_including_repeats_and_unavailable(self):
        body = self.playlist_order_body()
        with patch.object(self.studio.client, '_jsonrequest', side_effect=AssertionError('No native request')):
            result = self.studio.collections.playlist_order_view({**body, 'positions': ['2', '0', '3', '4']})
        self.assertEqual([r['source_position'] for r in result['rows']], [2, 0, 3, 4])
        self.assertEqual([r['id'] for r in result['rows']], ['900', '900', '999999', '902'])
        self.assertEqual([r['available'] for r in result['rows']], [True, True, False, False])
        self.assertFalse(mock_ibroadcast.STATE['writes'])
        for positions in ([], ['0'] * 101, ['0', '0'], ['-1'], ['5'], ['bad'], [True], ['１']):
            with self.subTest(positions=positions), self.assertRaises(LibraryError):
                self.studio.collections.playlist_order_view({**body, 'positions': positions})

    def test_playlist_order_save_preserves_every_position_and_metadata_then_reads_back(self):
        body = self.playlist_order_body()
        before = copy.deepcopy(mock_ibroadcast.STATE['playlists'][888])
        original = self.studio.client._jsonrequest
        with patch.object(self.studio.client, '_jsonrequest', wraps=original) as requests:
            self.assertEqual(self.job(self.studio.collections.save_playlist(body))['results'],
                             [{'id': '888', 'status': 'saved'}])
        sent = [c for c in requests.call_args_list if c.args[0] == 'updateplaylist']
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0].kwargs, {'playlist': 888, 'tracks': [999999, 900, 901, 902, 900], '_retry': False})
        after = mock_ibroadcast.STATE['playlists'][888]
        self.assertEqual(after['tracks'], [999999, 900, 901, 902, 900])
        self.assertEqual({k: v for k, v in after.items() if k != 'tracks'},
                         {k: v for k, v in before.items() if k != 'tracks'})
        with self.assertRaises(ConflictError):
            self.studio.collections.save_playlist(body)

    def test_playlist_order_cannot_add_drop_duplicate_or_forge_review_positions(self):
        body = self.playlist_order_body()
        for changes in ({'approved': False}, {'before_token': None}, {'session': 'stale'},
                        {'tracks': [900]}, {'positions': [0, 1, 2, 3, 4]}, {'positions': [2, 1, 0, 3, 4]},
                        {'positions': [4, 3, 2, 0]},
                        {'positions': [4, 3, 2, 1, 1]}, {'positions': [4, 3, 2, 1, True]},
                        {'positions': [4, 3, 2, 1, -1]}, {'positions': ['4', '3', '2', '1', '0']},
                        {'positions': [5, 4, 3, 2, 1, 0]}, {'positions': list(range(10001))}):
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.studio.collections.save_playlist({**body, **changes})
        self.assertFalse(mock_ibroadcast.STATE['writes'])
        self.studio.save_lock.acquire()
        try:
            with self.assertRaisesRegex(LibraryError, 'Another save'):
                self.studio.collections.save_playlist(body)
        finally:
            self.studio.save_lock.release()

    def test_playlist_order_rejects_changed_metadata_membership_and_protected_lists(self):
        for changes in ({'name': 'Renamed'}, {'description': 'Changed'}, {'artwork_id': 99},
                        {'tracks': [900, 901]}, {'type': 'folder'}, {'system_created': True}):
            with self.subTest(changes=changes):
                body = self.playlist_order_body()
                mock_ibroadcast.STATE['playlists'][888].update(changes)
                mock_ibroadcast.STATE['version'] += 1
                with self.assertRaises(LibraryError):
                    self.studio.collections.save_playlist(body)
        self.assertFalse(mock_ibroadcast.STATE['writes'])

    def test_playlist_order_ambiguous_write_is_sent_once_and_readback_checks_metadata(self):
        body = self.playlist_order_body()
        original = self.studio.client._jsonrequest
        def uncertain(mode, **kwargs):
            if mode == 'updateplaylist':
                self.assertIs(kwargs['_retry'], False)
                raise client.ApiError('Connection lost after send')
            return original(mode, **kwargs)
        with patch.object(self.studio.client, '_jsonrequest', side_effect=uncertain) as requests:
            with self.assertRaises(client.ApiError):
                self.studio.collections.save_playlist(body)
        self.assertEqual(sum(c.args[0] == 'updateplaylist' for c in requests.call_args_list), 1)
        def changed(mode, **kwargs):
            result = original(mode, **kwargs)
            if mode == 'updateplaylist':
                mock_ibroadcast.STATE['playlists'][888]['artwork_id'] = 123
            return result
        with patch.object(self.studio.client, '_jsonrequest', side_effect=changed):
            checked = self.job(self.studio.collections.save_playlist(body))
        self.assertEqual(checked['results'], [{'id': '888', 'status': 'unverified'}])

    def test_playlist_order_pages_stay_bounded_at_the_ten_thousand_position_limit(self):
        body = self.playlist_order_body([900] * 9999 + [901])
        page = self.studio.collections.playlist_order_view({**body, 'positions': [str(i) for i in range(9900, 10000)]})
        self.assertEqual(len(page['rows']), 100)
        self.assertEqual(page['rows'][-1]['source_position'], 9999)
        body = self.playlist_order_body([900] * 10001)
        with self.assertRaisesRegex(LibraryError, '10,000'):
            self.studio.collections.playlist_order_view({**body, 'positions': ['0']})
        self.assertFalse(mock_ibroadcast.STATE['writes'])

    def test_playlist_browsing_reuses_loaded_library_without_remote_status_checks(self):
        self.playlist_metadata_body()
        mock_ibroadcast.STATE['playlists'][889] = {
            'name': 'Folder', 'type': 'folder', 'tracks': [888]}
        self.studio.load_library(refresh=True)
        with patch.object(self.studio, '_remote_state', side_effect=AssertionError('No status call')), \
                patch.object(self.studio.client, 'fetch_library', side_effect=AssertionError('No download')):
            for _ in range(2):
                self.assertEqual(self.studio.collections.playlists(browse=True)['total'], 1)
                self.assertEqual(self.studio.collections.playlists(query='Keep', browse=True)['total'], 1)
                self.assertEqual(self.studio.collections.playlists(playlist_id='889')['total'], 1)
                self.assertEqual(self.studio.collections.playlists(playlist_id='888')['total'], 2)
                self.assertEqual(self.studio.collections.playlists(offset='100')['playlists'], [])
                self.assertEqual(self.studio.collections.folder_choices()['total'], 2)

    def test_cached_playlist_browsing_refreshes_on_reload_and_writes_still_check_fresh_data(self):
        body = self.playlist_metadata_body()
        mock_ibroadcast.STATE['playlists'][888]['description'] = 'Edited elsewhere'
        mock_ibroadcast.STATE['version'] += 1
        cached = self.studio.collections.playlists(playlist_id='888')
        self.assertEqual(cached['description'], 'Before')
        with self.assertRaises(ConflictError):
            self.studio.collections.save_playlist(body)
        self.assertEqual(mock_ibroadcast.STATE['writes'], [])
        self.studio.load_library(refresh=True)
        refreshed = self.studio.collections.playlists(playlist_id='888')
        self.assertEqual(refreshed['description'], 'Edited elsewhere')
        body.update(before_token=refreshed['before_token'])
        self.assertEqual(self.job(self.studio.collections.save_playlist(body))['results'][0]['status'], 'saved')
        with patch.object(self.studio, '_remote_state', side_effect=AssertionError('Read-back already refreshed')):
            self.assertEqual(self.studio.collections.playlists(playlist_id='888')['description'],
                             'Only this text changes')

    def test_playlist_cache_upgrades_older_library_once_and_never_survives_disconnect(self):
        self.playlist_metadata_body()
        self.studio.library.playlists_loaded = False
        with patch.object(self.studio.client, 'fetch_library', wraps=self.studio.client.fetch_library) as fetch:
            self.studio.collections.playlists(browse=True)
            self.studio.collections.playlists(browse=True)
        self.assertEqual(fetch.call_count, 1)
        self.studio._disconnect()
        with self.assertRaises(client.NotConnected):
            self.studio.collections.playlists(browse=True)

    def playlist_metadata_body(self):
        mock_ibroadcast.STATE['playlists'][888] = {
            'name': 'Keep every position', 'description': 'Before', 'type': None,
            'tracks': [900, 900, 999999, 902], 'artwork_id': 77, 'system_created': False}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        view = self.studio.collections.playlists(playlist_id='888')
        return {'action': 'metadata', 'playlist': '888', 'before_name': view['name'],
                'before_token': view['before_token'], 'session': self.studio.playback_session,
                'approved': True, 'fields': {'description': 'Only this text changes'}}

    def test_playlist_description_only_omits_tracks_and_preserves_all_native_positions(self):
        body = self.playlist_metadata_body()
        before = copy.deepcopy(mock_ibroadcast.STATE['playlists'][888])
        with patch.object(self.studio.client, '_jsonrequest', wraps=self.studio.client._jsonrequest) as request:
            result = self.job(self.studio.collections.save_playlist(body))
        updates = [call for call in request.call_args_list if call.args[0] == 'updateplaylist']
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0].kwargs, {'playlist': 888, '_retry': False,
                                           'description': 'Only this text changes'})
        self.assertEqual(result['results'], [{'id': '888', 'status': 'saved'}])
        self.assertEqual(mock_ibroadcast.STATE['playlists'][888],
                         {**before, 'description': 'Only this text changes'})

    def test_playlist_text_review_rejects_unapproved_stale_or_unsupported_changes(self):
        body = self.playlist_metadata_body()
        for changes in ({'approved': False}, {'tracks': []}, {'fields': {}},
                        {'fields': {'artwork_id': 7}}, {'fields': {'name': ''}},
                        {'fields': {'description': ['text']}}, {'session': 'another-session'},
                        {'fields': {'name': 'x' * 201}}, {'fields': {'description': 'x' * 2001}},
                        {'fields': {'description': 'Before'}}):
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.studio.collections.save_playlist({**body, **changes})
        writes = len(mock_ibroadcast.STATE['writes'])
        mock_ibroadcast.STATE['playlists'][888]['tracks'].append(901)
        mock_ibroadcast.STATE['version'] += 1
        with self.assertRaises(ConflictError):
            self.studio.collections.save_playlist(body)
        self.assertEqual(len(mock_ibroadcast.STATE['writes']), writes)

    def test_playlist_rename_and_description_clear_are_verified_without_track_replacement(self):
        body = self.playlist_metadata_body()
        body['fields'] = {'name': 'Renamed – café', 'description': ''}
        checked = self.job(self.studio.collections.save_playlist(body))
        self.assertEqual(checked['results'], [{'id': '888', 'status': 'saved'}])
        stored = mock_ibroadcast.STATE['playlists'][888]
        self.assertEqual((stored['name'], stored['description']), ('Renamed – café', ''))
        self.assertEqual(stored['tracks'], [900, 900, 999999, 902])
        write = mock_ibroadcast.STATE['writes'][-1]
        self.assertNotIn('tracks', write)
        self.assertNotIn('artwork_id', write)

    def test_playlist_description_is_verified_for_text_and_track_replacements(self):
        for action in ('metadata', 'replace'):
            with self.subTest(action=action):
                body = self.playlist_metadata_body()
                if action == 'replace':
                    body.update(action='replace', name=body['before_name'],
                                description='Only this text changes', tracks=[900, 901])
                    body.pop('fields')
                original = self.studio.client._jsonrequest

                def ignore_description(mode, **kwargs):
                    result = original(mode, **kwargs)
                    if mode == 'updateplaylist':
                        mock_ibroadcast.STATE['playlists'][888]['description'] = 'Not accepted'
                    return result

                with patch.object(self.studio.client, '_jsonrequest', side_effect=ignore_description):
                    checked = self.job(self.studio.collections.save_playlist(body))
                self.assertEqual(checked['results'], [{'id': '888', 'status': 'unverified'}])

    def test_playlist_catalogue_times_use_active_positions_and_not_folder_references(self):
        self.playlist_metadata_body()
        mock_ibroadcast.STATE['tracks'][900]['length'] = 180
        mock_ibroadcast.STATE['playlists'][889] = {
            'name': 'Folder', 'type': 'folder', 'tracks': [888]}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        rows = self.studio.collections.playlists(query='Keep', browse=True)['playlists']
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['count'], rows[0]['active_count'], rows[0]['unavailable_count']), (4, 2, 2))
        self.assertEqual((rows[0]['duration'], rows[0]['duration_missing']), (360, 0))
        root = self.studio.collections.playlists(browse=True)['playlists'][0]
        self.assertEqual(root['kind'], 'folder')
        self.assertNotIn('duration', root)
        child = self.studio.collections.playlists(playlist_id='889')['playlists'][0]
        self.assertEqual(child['duration'], 360)

    def test_artist_rating_is_native_scalar_read_back_and_independent_of_hearts(self):
        body = {'artists': ['41'], 'name': 'Kate Bush', 'session': self.studio.playback_session,
                'before': [0], 'rating': 4}
        self.studio.collections.favourite_artist({**body, 'before': False, 'favourite': True})
        response = self.studio.collections.rate_artist(body)
        checked = self.job(response)
        self.assertNotIn('albums', checked)
        self.assertEqual(checked['results'], [{'id': '41', 'rating': 4, 'status': 'saved'}])
        writes = [w for w in mock_ibroadcast.STATE['writes'] if w['mode'] == 'rateartist']
        self.assertEqual([(w['artist_id'], w['rating']) for w in writes], [(41, 4)])
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['41'])
        self.assertEqual(self.studio.library.album_summary(72)['artist_rating'], 4)
        self.assertEqual(self.studio.library.album_view(73)['artist_rating'], 4)
        self.assertEqual(self.studio.library.album_summary(72)['rating'], 0)
        self.assertEqual(self.studio.library.track_view(900)['rating'], 0)
        self.job(self.studio.collections.rate_artist({**body, 'before': [4], 'rating': 0}))
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['41'])
        self.assertEqual(self.studio.library.album_summary(72)['artist_rating'], 0)


    def test_additional_album_artist_and_full_track_credits_save_and_verify_native_ids(self):
        album = self.studio.library.album_view(72)
        track = self.studio.library.track_view(900)
        album_credits = [{'artist_id': 42, 'name': 'Pink Floyd', 'type': 'artist', 'phrase': 'with'}]
        track_credits = [{'artist_id': None, 'name': 'New Lyricist', 'type': 'lyricist', 'phrase': 'Words by'}]
        result = self.studio.save([
            change('album', 72, 72, credits=(album['credits'], album_credits)),
            change('track', 900, 72, credits=(track['credits'], track_credits))])
        checked = self.job(result)
        self.assertTrue(all(row['status'] == 'saved' for row in checked['results']))
        self.assertEqual(result['created_artists'], ['New Lyricist'])
        saved = self.studio.library.album_view(72)
        self.assertEqual([a['name'] for a in saved['album_artists']], ['Kate Bush', 'Pink Floyd'])
        self.assertEqual(saved['tracks'][0]['credits'][0]['type'], 'lyricist')
        self.assertIsInstance(saved['tracks'][0]['credits'][0]['artist_id'], int)
        selection = {'artists': ['42'], 'name': 'Pink Floyd', 'session': self.studio.playback_session}
        self.studio.collections.favourite_artist({**selection, 'before': False, 'favourite': True})
        self.assertEqual(self.studio.collections.artist_favourites()['artists'], ['42'])
        self.assertTrue(all(r['status'] == 'saved' for r in self.job(self.studio.collections.rate_artist(
            {**selection, 'before': [0], 'rating': 3}))['results']))
        self.assertEqual(self.studio.library.album_summary(72)['album_artists'][1]['rating'], 3)

    def test_thumbs_down_sets_one_native_track_rating_and_can_be_cleared(self):
        self.assertTrue(all(r['status'] == 'saved' for r in self.job(self.studio.favourite(
            {'track_id': '903', 'before': 0, 'rating': 1}))['results']))
        self.assertEqual(self.studio.library.track_view(903)['rating'], 1)
        self.assertNotIn('903', [r['id'] for r in self.studio.library.favourites()['tracks']])
        with self.assertRaises(ConflictError):
            self.studio.favourite({'track_id': '903', 'before': 0, 'rating': 5})
        self.assertTrue(all(r['status'] == 'saved' for r in self.job(self.studio.favourite(
            {'track_id': '903', 'before': 1, 'rating': 0}))['results']))
        self.assertEqual(self.studio.library.track_view(903)['rating'], 0)
        self.assertEqual([w['rating'] for w in mock_ibroadcast.STATE['writes'] if w['mode'] == 'ratetrack'], [1, 0])

    def test_combined_sets_block_album_credits_without_creating_their_artists(self):
        album = self.studio.library.album_view(72)
        track = self.studio.library.track_view(900)
        mock_ibroadcast.STATE['combine_sets'] = True
        result = self.studio.save([
            change('album', 72, 72, credits=(album['credits'], [
                {'artist_id': None, 'name': 'Blocked Album Guest', 'type': 'artist', 'phrase': None}])),
            change('track', 900, 72, credits=(track['credits'], [
                {'artist_id': None, 'name': 'Allowed Writer', 'type': 'lyricist', 'phrase': None}]))])
        checked = self.job(result)
        self.assertEqual({r['kind']: r['status'] for r in checked['results']},
                         {'album': 'blocked', 'track': 'saved'})
        self.assertEqual(result['created_artists'], ['Allowed Writer'])
        self.assertNotIn('Blocked Album Guest', mock_ibroadcast.STATE['artists'].values())
        self.assertEqual(self.studio.library.album_view(72)['credits'], [])

    def test_large_playlist_append_and_delete_use_checked_compact_snapshots(self):
        tracks = copy.deepcopy(mock_ibroadcast.STATE['tracks'])
        for action in ('delete', 'append'):
            mock_ibroadcast.STATE['playlists'][888] = {
                'name': 'Large playlist', 'type': 'playlist', 'tracks': [900, 901] * 5001}
            mock_ibroadcast.STATE['version'] += 1
            self.studio.load_library(refresh=True)
            page = self.studio.collections.playlists(playlist_id='888', offset='10000')
            self.assertEqual(page['total'], 10002)
            self.assertEqual(len(page['tracks']), 2)
            body = {'action': action, 'playlist': page['id'], 'before_token': page['before_token'],
                    'before_name': page['name'], 'confirm_delete': True, 'tracks': [903]}
            checked = self.job(self.studio.collections.save_playlist(body))
            self.assertEqual(checked['results'][0]['status'], 'saved')
            if action == 'delete':
                self.assertNotIn(888, mock_ibroadcast.STATE['playlists'])
            else:
                self.assertEqual(mock_ibroadcast.STATE['playlists'][888]['tracks'], [900, 901, 903])
            self.assertEqual(mock_ibroadcast.STATE['tracks'], tracks)

    def test_artist_ratings_reject_stale_values_names_sessions_and_invalid_inputs(self):
        body = {'artists': ['41'], 'name': 'Kate Bush', 'session': self.studio.playback_session,
                'before': [0], 'rating': 3}
        for changes in [{'rating': True}, {'rating': 6}, {'before': [True]},
                        {'artists': ['41', '41'], 'before': [0, 0]}, {'artists': []}]:
            with self.subTest(changes=changes), self.assertRaises(LibraryError):
                self.studio.collections.rate_artist({**body, **changes})
        for changes in [{'name': 'Other artist'}, {'session': 'old'}, {'before': [1]},
                        {'artists': ['43']}]:
            with self.subTest(changes=changes), self.assertRaises(ConflictError):
                self.studio.collections.rate_artist({**body, **changes})
        self.assertEqual(mock_ibroadcast.STATE['writes'], [])
        self.studio.save_lock.acquire()
        try:
            with self.assertRaisesRegex(LibraryError, 'Another save'):
                self.studio.collections.rate_artist(body)
        finally:
            self.studio.save_lock.release()

    def test_artist_rating_stops_a_named_group_after_an_ambiguous_request_error(self):
        mock_ibroadcast.STATE['artists'].update({42: 'Kate Bush', 43: 'Kate Bush'})
        mock_ibroadcast.STATE['albums'][75] = {**mock_ibroadcast.STATE['albums'][74],
                                             'artist_id': 43, 'tracks': [905]}
        mock_ibroadcast.STATE['tracks'][905] = {**mock_ibroadcast.STATE['tracks'][904], 'album_id': 75}
        self.studio.load_library(refresh=True)
        original, attempted = self.studio.client._jsonrequest, []

        def request(mode, **fields):
            if mode == 'rateartist':
                attempted.append(fields['artist_id'])
                if fields['artist_id'] == 42:
                    raise client.ApiError('Uncertain request')
            return original(mode, **fields)

        with patch.object(self.studio.client, '_jsonrequest', side_effect=request):
            response = self.studio.collections.rate_artist({
                'artists': ['41', '42', '43'], 'name': 'Kate Bush',
                'session': self.studio.playback_session, 'before': [0, 0, 0], 'rating': 5})
            checked = self.job(response)
        self.assertEqual(attempted, [41, 42])
        self.assertIn('Uncertain request', response['error'])
        self.assertEqual([r['status'] for r in checked['results']], ['saved', 'unverified', 'not_sent'])

    def test_missing_artist_cannot_confirm_clearing_a_rating(self):
        with patch.object(self.studio, '_check_later', return_value='read-back') as check_later:
            self.studio.collections.rate_artist({'artists': ['41'], 'name': 'Kate Bush',
                'session': self.studio.playback_session, 'before': [0], 'rating': 1})
        callback = check_later.call_args.args[2]
        del self.studio.library.artists.rows[41]
        self.assertEqual(callback(self.studio.library)[0]['status'], 'unverified')

    def test_unnamed_artist_rating_is_confirmed_by_its_displayed_identity(self):
        mock_ibroadcast.STATE['artists'][41] = ''
        self.studio.load_library(refresh=True)
        response = self.studio.collections.rate_artist({
            'artists': ['41'], 'name': 'Unknown artist',
            'session': self.studio.playback_session, 'before': [0], 'rating': 4})
        self.assertEqual(self.job(response)['results'],
                         [{'id': '41', 'rating': 4, 'status': 'saved'}])
        writes = [w for w in mock_ibroadcast.STATE['writes'] if w['mode'] == 'rateartist']
        self.assertEqual(len(writes), 1)
        self.assertEqual(self.studio.library.artist_name(41), 'Unknown artist')

    def test_album_rating_is_native_scalar_checked_and_separate_from_track_rating(self):
        before = self.studio.album_details(['73'])[0]['rating']
        response = self.studio.collections.rate_album({'albums': ['73'], 'before': [before], 'rating': 5})
        checked = self.job(response)
        self.assertEqual(checked['results'][0]['status'], 'saved')
        self.assertNotIn('albums', checked, 'A single rating must not serialize every album summary')
        self.assertEqual(mock_ibroadcast.STATE['writes'][-1]['album_id'], 73)
        self.assertEqual(self.studio.album_details(['73'])[0]['rating'], 5)
        self.assertEqual(self.studio.library.tracks[903].get('rating', 0), self.original['tracks'][903].get('rating', 0))
        with self.assertRaises(ConflictError):
            self.studio.collections.rate_album({'albums': ['73'], 'before': [0], 'rating': 3})
        with self.assertRaises(LibraryError):
            self.studio.collections.rate_album({'albums': ['72', '73'], 'before': [0, 5], 'rating': 5})

    def favourite(self, ids=('73',), before=(False,), value=True):
        return self.studio.collections.favourite_album({
            'albums': list(ids), 'before': list(before), 'favourite': value,
            'session': self.studio.playback_session, 'combine_sets': self.studio.combine_sets})

    def test_local_album_favourite_preserves_native_ratings_and_survives_restart(self):
        self.job(self.studio.collections.rate_album({'albums': ['73'], 'before': [0], 'rating': 3}))
        writes = copy.deepcopy(mock_ibroadcast.STATE['writes'])
        with patch.object(self.studio.client, '_jsonrequest', side_effect=AssertionError('Local hearts must not contact iBroadcast')):
            response = self.favourite()
            self.assertEqual(response['results'], [{'id': '73', 'favourite': True}])
            self.assertIn('73', self.studio.collections.album_favourites()['albums'])
            self.assertEqual(self.studio.album_details(['73'])[0]['rating'], 3)
        self.assertEqual(mock_ibroadcast.STATE['writes'], writes)
        restarted = client.Studio(self.home.name)
        loaded = restarted.load_library()
        self.assertIn('73', loaded['album_favourites']['albums'])
        self.assertEqual(restarted.album_details(['73'])[0]['rating'], 3)
        with restarted.cache_lock:
            pass
        self.favourite(before=(True,), value=False)
        self.assertEqual(self.studio.album_details(['73'])[0]['rating'], 3)

    def test_former_five_star_favourites_are_imported_once_per_account(self):
        path = self.studio.home / 'album-favourites.json'
        path.unlink()
        self.studio.library.albums.rows[73][self.studio.library.albums.fields['rating']] = 5
        self.assertEqual(self.studio.collections.album_favourites()['albums'], ['73'])
        self.favourite(before=(True,), value=False)
        self.assertEqual(self.studio.album_details(['73'])[0]['rating'], 5)
        self.assertEqual(self.studio.collections.album_favourites()['albums'], [])
        self.studio.library.albums.rows[74][self.studio.library.albums.fields['rating']] = 5
        self.assertEqual(self.studio.collections.album_favourites()['albums'], [])
        self.studio.library_user = 'another-account'
        self.assertEqual(set(self.studio.collections.album_favourites()['albums']), {'73', '74'})
        self.studio.library_user = '7'
        self.assertEqual(self.studio.collections.album_favourites()['albums'], [])

    def test_artist_favourites_load_with_compact_library_and_do_not_block_it_on_file_errors(self):
        self.studio.collections.favourite_artist({
            'artists': ['42'], 'name': 'Pink Floyd', 'before': False, 'favourite': True,
            'session': self.studio.playback_session})
        self.assertEqual(self.studio.load_library()['artist_favourites']['artists'], ['42'])
        self.assertFalse((self.studio.home / 'artist-biographies.sqlite3').exists())
        path = self.studio.home / 'artist-favourites.json'
        path.write_text('{broken')
        view = self.studio.load_library()
        self.assertTrue(view['albums'])
        self.assertIsNone(view['artist_favourites']['artists'])
        self.assertIn('Could not read', view['artist_favourites']['error'])
        self.assertEqual(path.read_text(), '{broken')

    def test_artist_biography_setting_is_boolean_persisted_and_never_fetches_on_enable(self):
        self.assertFalse(self.studio.settings()['artist_biographies'])
        with patch.object(self.studio.lookup.http, 'json') as lookup:
            settings = self.studio.save_settings({'artist_biographies': True})
            self.assertTrue(settings['artist_biographies'])
            lookup.assert_not_called()
        self.assertFalse((self.studio.home / 'artist-biographies.sqlite3').exists())
        self.assertTrue(client.Studio(self.home.name).settings()['artist_biographies'])
        for invalid in ('yes', 1, None):
            with self.assertRaises(client.ApiError):
                self.studio.save_settings({'artist_biographies': invalid})
        self.assertFalse(self.studio.save_settings({'artist_biographies': False})['artist_biographies'])

    def test_local_album_favourites_reject_stale_account_membership_and_concurrent_changes(self):
        self.favourite()
        with self.assertRaises(ConflictError):
            self.favourite()
        with self.assertRaises(ConflictError):
            self.favourite(ids=('999999',))
        body = {'albums': ['73'], 'before': [True], 'favourite': False,
                'session': 'old-session', 'combine_sets': False}
        with self.assertRaises(ConflictError):
            self.studio.collections.favourite_album(body)
        with self.assertRaises(ConflictError):
            self.studio.collections.favourite_album({**body, 'session': self.studio.playback_session, 'combine_sets': True})
        with self.assertRaises(LibraryError):
            self.favourite(ids=('73', '74'), before=(True, False))
        self.assertEqual(self.studio.collections.album_favourites()['albums'], ['73'])

    def test_local_album_favourite_file_errors_do_not_erase_data_or_block_the_library(self):
        self.favourite()
        with patch.object(self.studio, '_write', side_effect=OSError('Disk full')):
            with self.assertRaisesRegex(LibraryError, 'Could not save'):
                self.favourite(before=(True,), value=False)
        self.assertEqual(self.studio.collections.album_favourites()['albums'], ['73'])
        path = self.studio.home / 'album-favourites.json'
        path.write_text('{broken')
        view = self.studio.load_library()
        self.assertTrue(view['albums'])
        self.assertIsNone(view['album_favourites']['albums'])
        self.assertIn('Could not read', view['album_favourites']['error'])
        with self.assertRaises(LibraryError):
            self.favourite()
        self.assertEqual(path.read_text(), '{broken')

    def test_local_multi_disc_favourites_keep_separate_ratings_and_original_disc_ids(self):
        library = self.studio.library
        # The two displayed discs share identity, but retain independent stars.
        library.albums.rows[73][library.albums.fields['rating']] = 3
        library.albums.rows[74] = [*library.albums.rows[73]]
        library.albums.rows[74][1] = [904]
        library.albums.rows[74][5] = 2
        library.albums.rows[74][library.albums.fields['rating']] = 4
        self.favourite(ids=('73', '74'), before=(False, False))
        self.assertEqual(set(self.studio.collections.album_favourites()['albums']), {'73', '74'})
        self.assertEqual([a['rating'] for a in self.studio.album_details(['73', '74'])], [3, 4])
        # iBroadcast's combined view exposes one album containing both originals.
        library.combine_sets = self.studio.combine_sets = True
        library.albums.rows[73][1] = [903, 904]
        library.albums.rows[74][3] = True
        self.assertEqual(self.studio.collections.album_favourites()['albums'], ['73'])
        self.favourite(before=(True,), value=False)
        library.combine_sets = self.studio.combine_sets = False
        library.albums.rows[73][1] = [903]
        library.albums.rows[74][3] = False
        self.assertEqual(self.studio.collections.album_favourites()['albums'], [])

    def test_private_playlist_create_append_replace_and_stale_review(self):
        response = self.studio.collections.save_playlist({'action': 'create', 'name': 'Album evening', 'description': 'Two albums', 'tracks': [900, 901, 900]})
        self.assertEqual(self.job(response)['results'][0]['status'], 'saved')
        i = response['id']
        self.assertFalse(mock_ibroadcast.STATE['writes'][-1]['make_public'])
        view = self.studio.collections.playlists(playlist_id=i)
        self.assertEqual(view['tracks'], [900, 901])
        append = {'action': 'append', 'playlist': i, 'name': view['name'], 'tracks': [903, 901], 'before': view['before'], 'before_name': view['name']}
        self.assertEqual(self.job(self.studio.collections.save_playlist(append))['results'][0]['status'], 'saved')
        with self.assertRaises(ConflictError):
            self.studio.collections.save_playlist(append)
        view = self.studio.collections.playlists(playlist_id=i)
        replace = {**append, 'action': 'replace', 'name': 'Renamed', 'description': '', 'tracks': [903, 900], 'before': view['before']}
        self.assertEqual(self.job(self.studio.collections.save_playlist(replace))['results'][0]['status'], 'saved')
        self.assertEqual(self.studio.collections.playlists(playlist_id=i)['tracks'], [903, 900])
        with self.assertRaises(LibraryError):
            self.studio.collections.save_playlist({**replace, 'playlist': 777})
        with self.assertRaises(LibraryError):
            self.studio.collections.save_playlist({'action': 'create', 'name': 'Trash', 'tracks': [902]})

    def test_quality_requires_premium_and_formats_are_not_replaced_by_stream_format(self):
        with self.assertRaises(client.ApiError):
            self.studio.stream('903', quality='orig')
        with self.assertRaises(client.ApiError):
            self.studio.stream('903', quality='96')
        self.studio.premium = True
        response = Mock(status_code=200, ok=True)
        with patch.object(self.studio.client, 'open_stream', return_value=response) as stream:
            self.assertEqual(self.studio.stream('903', quality='320')[1], 'audio/mpeg')
            self.assertTrue(stream.call_args.args[0].startswith('/320/'))
            self.studio.stream('903', quality='orig')
            self.assertTrue(stream.call_args.args[0].startswith('/orig/'))
            with self.assertRaises(client.ApiError):
                self.studio.stream('903', quality='https://elsewhere')
            self.assertEqual(stream.call_count, 2)
        rows = self.studio.collections.queue_tracks({'tracks': [903, 900]})['tracks']
        self.assertEqual([r['id'] for r in rows], ['903', '900'])
        self.assertEqual(rows[0]['format'], 'MP3')

    def test_create_playlist_network_failure_is_never_retried(self):
        with patch.object(client.requests, 'post', side_effect=client.requests.Timeout) as post:
            with self.assertRaises(client.ApiError):
                self.studio.client._jsonrequest('createplaylist', name='One', tracks=[])
            self.assertEqual(post.call_count, 1)

    def test_playlist_delete_requires_review_preserves_music_and_reads_back(self):
        created = self.studio.collections.save_playlist({'action': 'create', 'name': 'Delete this list', 'tracks': [900, 901]})
        self.job(created)
        view = self.studio.collections.playlists(playlist_id=created['id'])
        body = {'action': 'delete', 'playlist': view['id'], 'before': view['before'], 'before_name': view['name']}
        previous = copy.deepcopy(mock_ibroadcast.STATE['tracks'])
        writes = len(mock_ibroadcast.STATE['writes'])
        with self.assertRaisesRegex(LibraryError, 'confirm'):
            self.studio.collections.save_playlist(body)
        self.assertEqual(len(mock_ibroadcast.STATE['writes']), writes)
        response = self.studio.collections.save_playlist({**body, 'confirm_delete': True})
        self.assertEqual(self.job(response)['results'][0]['status'], 'saved')
        self.assertEqual(mock_ibroadcast.STATE['writes'][-1]['mode'], 'deleteplaylist')
        self.assertEqual(mock_ibroadcast.STATE['writes'][-1]['playlist'], int(view['id']))
        self.assertNotIn(int(view['id']), self.studio.library.playlists)
        self.assertEqual(mock_ibroadcast.STATE['tracks'], previous)
        self.assertEqual(self.studio.collections.playlists()['total'], 0)

    def test_playlist_delete_blocks_stale_reviews_system_lists_and_missing_lists(self):
        created = self.studio.collections.save_playlist({'action': 'create', 'name': 'Original', 'tracks': [900]})
        self.job(created)
        view = self.studio.collections.playlists(playlist_id=created['id'])
        body = {'action': 'delete', 'playlist': view['id'], 'before': view['before'], 'before_name': view['name'], 'confirm_delete': True}
        mock_ibroadcast.STATE['playlists'][int(view['id'])]['name'] = 'Changed elsewhere'
        mock_ibroadcast.STATE['version'] += 1
        writes = len(mock_ibroadcast.STATE['writes'])
        with self.assertRaises(ConflictError):
            self.studio.collections.save_playlist(body)
        for i in ('777', '999999'):
            with self.assertRaises(LibraryError):
                self.studio.collections.save_playlist({**body, 'playlist': i})
        self.assertEqual(len(mock_ibroadcast.STATE['writes']), writes)

    def test_playlist_delete_refusal_or_uncertain_network_failure_is_not_retried(self):
        with patch.object(client.requests, 'post', side_effect=client.requests.Timeout) as post:
            with self.assertRaises(client.ApiError):
                self.studio.client._jsonrequest('deleteplaylist', playlist=801)
            self.assertEqual(post.call_count, 1)

    def test_queue_is_opt_in_scoped_account_bound_and_role_sanitized(self):
        bridge = self.studio.queue_sync
        body = {'action': 'connect', 'browser': 'browser_abcdefghijklmnop', 'session': self.studio.playback_session}
        with self.assertRaises(LibraryError):
            bridge.action(body)
        self.studio.save_settings({'queue_sync': True})
        self.assertTrue(set(QUEUE_SCOPES).issubset(self.studio.scopes))
        self.studio.client.token_set.scope = client.SCOPES
        with self.assertRaisesRegex(LibraryError, 'Reconnect'):
            bridge.action(body)
        self.studio.client.token_set.scope += QUEUE_SCOPES
        with self.assertRaisesRegex(LibraryError, 'available device'):
            bridge.action({**body, 'target': 'someone-elses-session'})
        with patch.object(bridge, 'run'):
            result = bridge.action(body)
        self.assertEqual(result['owner'], body['browser'])
        sock = Mock()
        bridge.socket = sock
        bridge.status = 'connected'
        bridge.receive({'command': 'set_state', 'role': 'controller', 'tracks': [900], 'current_song': 900, 'data': {}, 'token': 'secret'})
        self.assertNotIn('secret', json.dumps(bridge.view()))
        with self.assertRaises(LibraryError):
            bridge.action({**body, 'action': 'state', 'revision': -1, 'state': bridge.state})
        changed = bridge.action({**body, 'action': 'state', 'revision': bridge.revision, 'state': {**bridge.state, 'pause': False, 'role': 'player'}})
        self.assertEqual(changed['state']['role'], 'controller')
        payload = json.loads(sock.send.call_args.args[0])
        self.assertEqual(payload['session_uuid'], 'tagcast-session')
        self.assertNotIn('role', payload['value'])
        self.assertNotIn('secret', json.dumps(payload))
        with self.assertRaises(LibraryError):
            bridge.action({**body, 'action': 'disconnect', 'session': 'old-account-session'})
        self.studio.save_settings({'queue_sync': False})
        self.assertEqual(bridge.view()['status'], 'disconnected')

    def test_controller_play_reports_are_blocked_even_before_the_next_browser_poll(self):
        studio, bridge = self.studio, self.studio.queue_sync
        studio.save_settings({'record_plays': True})
        bridge.owner = 'browser_abcdefghijklmnop'
        bridge.binding = studio.playback_session
        bridge.own_session = bridge.target = 'tagcast-session'
        bridge.state = {'role': 'controller'}
        body = {'track_id': '903', 'event_id': 'event_controller_abcdefghijklmnop',
                'session': studio.playback_session, 'browser': bridge.owner,
                'played_at': datetime.now(timezone.utc).isoformat(), 'listened': 11}
        previous = len(mock_ibroadcast.STATE['play_requests'])
        self.assertEqual(studio.record_play(body)['status'], 'controller')
        self.assertEqual(len(mock_ibroadcast.STATE['play_requests']), previous)
        bridge.state = {'role': 'player'}
        self.assertEqual(studio.record_play(body)['status'], 'sent')
        self.assertEqual(len(mock_ibroadcast.STATE['play_requests']), previous + 1)

    def test_websocket_one_use_token_get_state_and_server_role(self):
        bridge = self.studio.queue_sync
        bridge.own_session = bridge.target = 'tagcast-session'
        bridge.stop_event = threading.Event()
        socket = Mock()
        messages = [json.dumps({'command': 'set_state', 'role': 'player', 'tracks': [903], 'current_song': 903, 'data': {'repeat_mode': 'queue'}})]
        def receive():
            if messages:
                return messages.pop(0)
            bridge.stop_event.set()
            return ''
        socket.recv.side_effect = receive
        with patch('tagcast.queue_sync.websocket.create_connection', return_value=socket) as connect:
            bridge.run(self.studio.client, bridge.stop_event, self.studio.playback_session)
        self.assertEqual(connect.call_args.args[0], 'wss://queue.ibroadcast.com/ws?token=one-use-secret')
        self.assertEqual(connect.call_args.kwargs['sslopt']['ca_certs'], certifi.where())
        self.assertEqual(json.loads(socket.send.call_args.args[0])['command'], 'get_state')
        self.assertEqual(bridge.view()['state']['role'], 'player')
        self.assertNotIn('one-use-secret', json.dumps(bridge.view()))

    def test_queue_validation_preserves_up_next_and_rejects_invalid_timing(self):
        state = clean_state({'tracks': [900, 901], 'play_next': [903], 'data': {'play_index': 1, 'play_from': 'play_next', 'repeat_mode': 'queue'}})
        self.assertEqual((state['tracks'], state['play_next'], state['data']['play_index']), ([900, 901], [903], 1))
        for invalid in ({'volume': float('nan')}, {'tracks': [-1]}, {'data': {'play_index': 3}}, {'data': {'repeat_mode': 'random'}}):
            with self.assertRaises(LibraryError):
                clean_state(invalid)

    def folder_change(self, action, folder=None, **fields):
        body = {'action': action, 'session': self.studio.playback_session, 'approved': True, **fields}
        if folder:
            body.update(playlist=folder['id'], before_name=folder['name'], before_token=folder['before_token'])
        return self.studio.collections.save_folder(body)

    def create_folder(self, name='Decades'):
        response = self.folder_change('create', name=name)
        self.assertEqual(self.job(response)['results'], [{'id': response['id'], 'status': 'saved'}])
        return self.studio.collections.playlists(playlist_id=response['id'])

    def test_playlist_folders_create_nest_browse_rename_unlink_and_delete_without_touching_music(self):
        previous_tracks = copy.deepcopy(mock_ibroadcast.STATE['tracks'])
        root = self.create_folder()
        child = self.create_folder('Eighties')
        created = self.studio.collections.save_playlist({'action': 'create', 'name': 'Top 80', 'tracks': [900, 901]})
        self.job(created)
        selected = self.studio.collections.folder_choices()['playlists']
        leaf = next(p for p in selected if p['id'] == created['id'])
        nested = next(p for p in selected if p['id'] == child['id'])
        self.assertEqual(self.job(self.folder_change('add', root, members=[nested]))['results'][0]['status'], 'saved')
        self.assertEqual(self.job(self.folder_change('add', child, members=[leaf]))['results'][0]['status'], 'saved')
        roots = self.studio.collections.playlists(browse=True)
        self.assertEqual([p['id'] for p in roots['playlists']], [root['id']])
        self.assertEqual(self.studio.collections.playlists(query='Top', browse=True)['playlists'][0]['id'], leaf['id'])
        self.assertEqual([p['id'] for p in self.studio.collections.playlists()['playlists']], [leaf['id']], 'Track destination choices exclude folders')
        child = self.studio.collections.playlists(playlist_id=child['id'])
        self.assertEqual(child['parents'], [{'id': root['id'], 'name': root['name']}])
        self.assertNotIn('rows', child, 'Folder member IDs must never resolve into track rows')
        self.assertEqual(self.job(self.folder_change('rename', child, name='1980s', description='Updated'))['results'][0]['status'], 'saved')
        child = self.studio.collections.playlists(playlist_id=child['id'])
        self.assertEqual(self.job(self.folder_change('remove', child, members=[leaf]))['results'][0]['status'], 'saved')
        child = self.studio.collections.playlists(playlist_id=child['id'])
        with self.assertRaisesRegex(LibraryError, 'parent'):
            self.folder_change('delete', child, confirm_delete=True)
        root = self.studio.collections.playlists(playlist_id=root['id'])
        child_ref = root['playlists'][0]
        self.job(self.folder_change('remove', root, members=[child_ref]))
        self.job(self.folder_change('delete', child, confirm_delete=True))
        self.assertIn(int(leaf['id']), self.studio.library.playlists)
        self.assertEqual(mock_ibroadcast.STATE['tracks'], previous_tracks)
        self.assertTrue(all(w['mode'] in ('createplaylist', 'createplaylistfolder', 'updateplaylist', 'deleteplaylist') for w in mock_ibroadcast.STATE['writes']))
        self.assertFalse(any('_retry' in w for w in mock_ibroadcast.STATE['writes']))

    def test_folder_reviews_block_stale_targets_members_sessions_cycles_and_system_lists(self):
        root = self.create_folder()
        child = self.create_folder('Child')
        choice = next(p for p in self.studio.collections.folder_choices()['playlists'] if p['id'] == child['id'])
        self.job(self.folder_change('add', root, members=[choice]))
        root = self.studio.collections.playlists(playlist_id=root['id'])
        root_choice = next(p for p in self.studio.collections.folder_choices()['playlists'] if p['id'] == root['id'])
        count = len(mock_ibroadcast.STATE['writes'])
        for selected in ([root_choice], [choice]):
            with self.assertRaisesRegex(LibraryError, 'parent|itself'):
                self.folder_change('add', child, members=selected)
        with self.assertRaises(ConflictError):
            self.studio.collections.save_folder({'action': 'create', 'name': 'Wrong account', 'approved': True, 'session': 'old'})
        with self.assertRaises(LibraryError):
            self.folder_change('delete', root, confirm_delete=True)
        with self.assertRaises(LibraryError):
            self.studio.collections.save_folder({'action': 'create', 'name': 'Unreviewed', 'session': self.studio.playback_session})
        with self.assertRaises(LibraryError):
            self.folder_change('rename', {**root, 'id': '777'}, name='System')
        with self.assertRaises(ConflictError):
            self.folder_change('add', root, members=[{**choice, 'name': 'Stale child'}])
        mock_ibroadcast.STATE['playlists'][int(root['id'])]['artwork_id'] = 321
        mock_ibroadcast.STATE['version'] += 1
        with self.assertRaises(ConflictError):
            self.folder_change('rename', root, name='Stale cover')
        self.assertEqual(len(mock_ibroadcast.STATE['writes']), count)

    def test_large_folder_is_paginated_and_missing_references_can_be_removed_without_track_lookup(self):
        ids = list(range(2000, 12101))
        mock_ibroadcast.STATE['playlists'][888] = {'name': 'Large folder', 'type': 'folder', 'tracks': ids}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        with patch.object(self.studio.library, 'track_row', side_effect=AssertionError('Folder IDs are not tracks')):
            page = self.studio.collections.playlists(playlist_id='888', offset='10000')
            self.assertEqual(page['total'], len(ids))
            self.assertEqual(len(page['playlists']), 100)
            self.assertEqual(page['playlists'][0]['kind'], 'unavailable')
        members = page['playlists'][:100]
        self.job(self.folder_change('remove', page, members=members))
        self.assertEqual(len(mock_ibroadcast.STATE['playlists'][888]['tracks']), 10001)
        self.assertEqual(mock_ibroadcast.STATE['writes'][-1]['tracks'], ids[:10000] + ids[10100:])
        page = self.studio.collections.playlists(playlist_id='888', offset='10000')
        self.job(self.folder_change('remove', page, members=page['playlists']))
        self.assertEqual(len(mock_ibroadcast.STATE['playlists'][888]['tracks']), 10000)

    def test_existing_folder_cycles_remain_browsable_without_recursion_or_automatic_repairs(self):
        mock_ibroadcast.STATE['playlists'].update({800: {'name': 'A', 'type': 'folder', 'tracks': [801]},
                                                 801: {'name': 'B', 'type': 'folder', 'tracks': [800]}})
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        rows = self.studio.collections.playlists(browse=True)['playlists']
        self.assertEqual({p['id'] for p in rows}, {'800', '801'})
        self.assertEqual(mock_ibroadcast.STATE['writes'], [])

    def test_playlist_cover_upload_uses_oauth_and_updates_only_artwork_with_full_read_back(self):
        import base64
        created = self.studio.collections.save_playlist({'action': 'create', 'name': 'Artwork', 'description': 'Keep', 'tracks': [900, 901]})
        self.job(created)
        view = self.studio.collections.playlists(playlist_id=created['id'])
        tracks = copy.deepcopy(mock_ibroadcast.STATE['tracks'])
        response = self.studio.collections.playlist_artwork({'playlist': view['id'], 'before_token': view['before_token'],
            'before_name': view['name'], 'session': self.studio.playback_session, 'approved': True,
            'source': {'data': 'data:image/png;base64,' + base64.b64encode(mock_ibroadcast.PNG).decode(), 'name': 'Playlist.png'}})
        self.assertEqual(self.job(response)['results'], [{'id': view['id'], 'status': 'saved'}])
        self.assertGreater(response['artwork_id'], 0)
        update = mock_ibroadcast.STATE['writes'][-1]
        self.assertEqual(update['mode'], 'updateplaylist')
        self.assertEqual(update['playlist'], int(view['id']))
        self.assertNotIn('tracks', update)
        self.assertNotIn('name', update)
        self.assertEqual(mock_ibroadcast.STATE['tracks'], tracks)
        after = self.studio.collections.playlists(playlist_id=view['id'])
        self.assertIn(str(response['artwork_id']), after['artwork'])
        self.assertEqual(after['tracks'], view['tracks'])
        self.assertEqual(self.studio.library.to_cache()['library']['playlists'][view['id']]['artwork_id'], response['artwork_id'])
        with self.assertRaises(ConflictError):
            self.studio.collections.playlist_artwork({'playlist': view['id'], 'before_token': view['before_token'], 'before_name': view['name'],
                'session': self.studio.playback_session, 'approved': True, 'source': {'artwork_id': 55}})

    def test_playlist_cover_rechecks_changes_during_upload_and_preserves_unknown_memberships(self):
        mock_ibroadcast.STATE['playlists'][888] = {'name': 'Many', 'tracks': [900, 999999, 900]}
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        view = self.studio.collections.playlists(playlist_id='888')
        body = {'playlist': '888', 'before_token': view['before_token'], 'before_name': view['name'],
                'session': self.studio.playback_session, 'approved': True, 'source': {'artwork_id': 55}}
        original = copy.deepcopy(mock_ibroadcast.STATE['playlists'][888]['tracks'])
        result = self.studio.collections.playlist_artwork(body)
        self.assertEqual(self.job(result)['results'][0]['status'], 'saved')
        self.assertEqual(mock_ibroadcast.STATE['playlists'][888]['tracks'], original)
        view = self.studio.collections.playlists(playlist_id='888')

        def changed(*args):
            mock_ibroadcast.STATE['playlists'][888]['description'] = 'Changed while uploading'
            mock_ibroadcast.STATE['version'] += 1
            return 66
        count = len(mock_ibroadcast.STATE['writes'])
        with patch.object(self.studio, '_image', side_effect=changed), self.assertRaises(ConflictError):
            self.studio.collections.playlist_artwork({**body, 'before_token': view['before_token']})
        self.assertEqual(len(mock_ibroadcast.STATE['writes']), count)
        for bad in ({'approved': False}, {'session': 'stale'}, {'playlist': '777'}, {'source': {'data': 'broken'}}):
            fresh = self.studio.collections.playlists(playlist_id='888')
            with self.subTest(bad=bad), self.assertRaises((LibraryError, client.artwork.ArtworkError)):
                self.studio.collections.playlist_artwork({**body, 'before_token': fresh['before_token'], **bad})

    def test_folder_and_cover_ambiguous_mutations_are_not_retried_and_readback_detects_other_changes(self):
        for mode, fields in [('createplaylistfolder', {'name': 'Folder'}),
                             ('updateplaylist', {'playlist': 888, 'artwork_id': 99, '_retry': False})]:
            with patch.object(client.requests, 'post', side_effect=client.requests.Timeout) as post:
                with self.assertRaises(client.ApiError):
                    self.studio.client._jsonrequest(mode, **fields)
                self.assertEqual(post.call_count, 1)
        created = self.studio.collections.save_playlist({'action': 'create', 'name': 'Readback', 'tracks': [900]})
        self.job(created)
        view = self.studio.collections.playlists(playlist_id=created['id'])
        with patch.object(self.studio, '_check_later', return_value='captured') as later:
            self.studio.collections.playlist_artwork({'playlist': view['id'], 'before_token': view['before_token'], 'before_name': view['name'],
                'session': self.studio.playback_session, 'approved': True, 'source': {'artwork_id': 55}})
        self.studio.load_library(refresh=True)
        callback = later.call_args.args[2]
        self.assertEqual(callback(self.studio.library)[0]['status'], 'saved')
        mock_ibroadcast.STATE['playlists'][int(view['id'])]['tracks'].append(901)
        self.studio.load_library(refresh=True)
        self.assertEqual(callback(self.studio.library)[0]['status'], 'unverified')

    def test_folder_can_unlink_protected_references_without_editing_their_playlist(self):
        mock_ibroadcast.STATE['playlists'].update({
            800: {'name': 'Folder', 'type': 'folder', 'tracks': [801]},
            801: {'name': 'Managed list', 'system_created': True, 'tracks': [900]}})
        mock_ibroadcast.STATE['version'] += 1
        self.studio.load_library(refresh=True)
        folder = self.studio.collections.playlists(playlist_id='800')
        member = folder['playlists'][0]
        self.assertEqual(member['kind'], 'unavailable')
        self.assertEqual(member['name'], 'Managed list')
        self.assertTrue(member['before_token'])
        self.job(self.folder_change('remove', folder, members=[member]))
        self.assertEqual(mock_ibroadcast.STATE['playlists'][800]['tracks'], [])
        self.assertEqual(mock_ibroadcast.STATE['playlists'][801]['tracks'], [900])
        self.assertEqual(mock_ibroadcast.STATE['writes'][-1]['playlist'], 800)
