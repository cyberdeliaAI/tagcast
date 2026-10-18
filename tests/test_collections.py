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
