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
