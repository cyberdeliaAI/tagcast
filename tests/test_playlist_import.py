"""CSV text, conservative matching, bounded review and single-use playlist creation."""

import copy
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from tagcast.client import Studio
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.playlist_import import MAX_ROWS, TrackCatalogue, duration_seconds, parse_csv


def fixture():
    return {"status": {"lastmodified": "one"}, "combine_sets": False, "library": {
        "artists": {"map": {}, "1": {"name": "Kate Bush"}, "2": {"name": "Guest"}, "3": {"name": "Writer"}},
        "albums": {"map": {}, "10": {"name": "Hounds of Love", "artist_id": 1, "disc": 1, "year": 1985,
                                        "tracks": [101, 102, 103, 104, 105]},
                   "11": {"name": "Compilation", "artist_id": 1, "year": 1985, "tracks": [201]},
                   "12": {"name": "Trashed", "artist_id": 1, "trashed": True, "tracks": [301]}},
        "tracks": {"map": {}, "101": {"album_id": 10, "artist_id": 1, "title": "Running Up That Hill", "length": 300, "track": 1},
                   "102": {"album_id": 10, "artist_id": 1, "title": "Cloudbusting", "length": 310, "track": 2, "type": "audio/flac"},
                   "103": {"album_id": 10, "artist_id": 1, "title": "Cloudbusting (Live)", "length": 330, "track": 3},
                   "104": {"album_id": 999, "artist_id": 1, "title": "Duet", "length": 200, "track": 4,
                           "artists_additional": [[2, "with", "artist"], [3, "words", "composer"]]},
                   "105": {"album_id": 10, "artist_id": 1, "title": "Deleted", "trashed": True},
                   "201": {"album_id": 11, "artist_id": 1, "title": "Running Up That Hill", "length": 300, "track": 1},
                   "301": {"album_id": 12, "artist_id": 1, "title": "Hidden"},
                   "401": {"album_id": 10, "artist_id": 1, "title": "Unlisted"}}, "playlists": {"map": {}}}}


class CsvParsingTests(unittest.TestCase):
    def test_quotes_multiline_bom_delimiters_headers_and_line_positions(self):
        columns, rows, delimiter, blank = parse_csv('\ufeffTitle;Artist;Album\r\n"One; Two";Björk;"First\nSecond"\r\n\r\nOther;Kate\r\n', ';')
        self.assertEqual(columns, ['Title', 'Artist', 'Album'])
        self.assertEqual(rows, [{'line': 3, 'cells': ['One; Two', 'Björk', 'First\nSecond']}, {'line': 5, 'cells': ['Other', 'Kate', '']}])
        self.assertEqual((delimiter, blank), (';', 1))
        self.assertEqual(parse_csv('Title\tArtist\nCloudbusting\tKate Bush\n')[2], '\t')
        self.assertEqual(parse_csv('Cloudbusting,Kate Bush\n', ',', False)[0], ['Column 1', 'Column 2'])
        self.assertEqual(parse_csv('Title,Artist\n=1+1,@someone\n', ',')[1][0]['cells'], ['=1+1', '@someone'])

    def test_invalid_or_oversized_csv_is_rejected_without_silent_record_loss(self):
        for content, delimiter in [('', ','), ('One\nTwo', 'auto'), ('Title,Artist\n"unclosed,Kate', ','),
                                   ('A,B\nx,y,z\n', ','), ('A,B\nx,\x00\n', ','), ('A,B\nx,\ud800\n', ','),
                                   ('A,B\n' + 'x' * 2001 + ',y', ','), (','.join(['c'] * 101), ',')]:
            with self.subTest(content=content[:30]), self.assertRaises(LibraryError):
                parse_csv(content, delimiter)
        self.assertEqual(len(parse_csv('A,B\n' + 'x,y\n' * MAX_ROWS, ',')[1]), MAX_ROWS)
        with self.assertRaisesRegex(LibraryError, '10,000'):
            parse_csv('A,B\n' + 'x,y\n' * (MAX_ROWS + 1), ',')
        with self.assertRaises(LibraryError):
            parse_csv('A,B\nx,y', ',', 'yes')

    def test_duration_units_precision_and_invalid_values(self):
        for value, unit, expected in [('153880', 'milliseconds', 153.88), ('153,88', 'seconds', 153.88),
                                      ('2:33.88', 'seconds', 153.88), ('1:02:03', 'milliseconds', 3723), ('', 'seconds', None)]:
            self.assertEqual(duration_seconds(value, unit), expected)
        for value in ('nan', 'inf', '-1', '0', '2:99', '1:2:3:4', 'tomorrow'):
            with self.subTest(value=value), self.assertRaises(LibraryError):
                duration_seconds(value, 'seconds')


class PlaylistImportTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.studio = Studio(self.home.name)
        self.studio.client = Mock()
        self.studio.library = Library(fixture())
        self.studio.library_user = 'one'
        self.studio.playback_session = 'session'
        self.importer = self.studio.playlist_import
        self.studio._current = Mock(return_value=(self.studio.library, 'memory'))
        self.studio._check_later = Mock(return_value='checked')

    def body(self, result, **fields):
        return {'id': result['id'], 'revision': result['revision'], 'session': 'session', **fields}

    def read(self, content='Title,Artist\nCloudbusting,Kate Bush\n', **fields):
        return self.importer.read({'text': content, 'delimiter': ',', 'session': 'session', **fields})

    def matched(self, content='Title,Artist\nCloudbusting,Kate Bush\n', **fields):
        parsed = self.read(content)
        return self.importer.match(self.body(parsed, mapping=parsed['mapping'], **fields))

    def test_parsing_and_matching_only_read_loaded_metadata_and_keep_bounded_responses(self):
        parsed = self.read('\ufeffTrack Name,Artist Name(s),Album Name,Duration (ms),Release Date\nCloudbusting,Kate Bush,Hounds of Love,310100,1985-09-16\n')
        self.assertEqual(parsed['mapping']['title'], 0)
        self.assertEqual(parsed['mapping']['duration'], 3)
        matched = self.importer.match(self.body(parsed, mapping=parsed['mapping'], duration_unit='milliseconds'))
        self.assertEqual(matched['rows'][0]['status'], 'automatic')
        self.assertEqual(matched['rows'][0]['choice']['id'], '102')
        self.studio._current.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()
        many = self.matched('Title,Artist\n' + 'Cloudbusting,Kate Bush\n' * 155)
        self.assertEqual(many['summary']['total'], 155)
        self.assertEqual(len(many['rows']), 50)
        self.assertEqual(many['summary']['duplicates'], 154)
        page = self.importer.view(self.body(many, offset=100))
        self.assertEqual([r['position'] for r in page['rows']], list(range(100, 150)))

    def test_alternative_export_uses_mmss_and_never_mistakes_generic_date_for_release_year(self):
        parsed = self.read('Row Index,Title,Artist,Album,Source Context,Duration,Date,Artist Link,Cover URL\n'
                           '1,Cloudbusting,Kate Bush,Hounds of Love,Evergreen list,05:10,27/12/2024,https://example.invalid/artist,https://example.invalid/image\n')
        self.assertEqual(parsed['mapping'], {'title': 1, 'artist': 2, 'album': 3, 'album_artist': None, 'duration': 5, 'year': None, 'track': None})
        result = self.importer.match(self.body(parsed, mapping=parsed['mapping']))
        self.assertEqual(result['rows'][0]['choice']['id'], '102')
        self.studio._current.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()

    def test_duplicate_copies_versions_and_conflicting_optional_fields_need_a_choice(self):
        matched = self.matched('Title,Artist\nRunning Up That Hill,Kate Bush\nCloudbusting - Remastered 2008,Kate Bush\nCloudbusting (Live),Kate Bush\n')
        self.assertIsNone(matched['rows'][0]['choice'])
        self.assertEqual(matched['rows'][0]['eligible'], 2)
        self.assertIsNone(matched['rows'][1]['choice'])
        self.assertIn('102', [r['id'] for r in matched['rows'][1]['candidates']])
        self.assertEqual(matched['rows'][2]['choice']['id'], '103')
        for extra, value in [('Album', 'Wrong album'), ('Duration', '900'), ('Year', '2020'), ('Track number', '99')]:
            with self.subTest(extra=extra):
                result = self.matched(f'Title,Artist,{extra}\nCloudbusting,Kate Bush,{value}\n')
                self.assertIsNone(result['rows'][0]['choice'])
        unique = self.matched('Title,Artist,Album\nRunning Up That Hill,Kate Bush,Hounds of Love\n')
        self.assertEqual(unique['rows'][0]['choice']['id'], '101')

    def test_native_additional_performers_are_matched_but_composers_are_not(self):
        for name, expected in [('Guest', '104'), ('Writer', None), ('Kate Bush;Guest', None)]:
            row = self.matched(f'Title,Artist\nDuet,{name}\n')['rows'][0]
            self.assertEqual(row['choice']['id'] if row['choice'] else None, expected)
        row = self.matched('Title,Artist\nDuet,Kate Bush;Guest\n', artist_separator=';')['rows'][0]
        self.assertEqual(row['choice']['id'], '104')
        self.assertEqual(row['choice']['album_id'], '10', 'Use active membership, not original source album ID')
        catalogue = TrackCatalogue(self.studio.library)
        self.assertFalse({105, 301, 401} & catalogue.members.keys())

    def test_bad_mapping_and_missing_or_invalid_optional_cells_remain_visible(self):
        parsed = self.read()
        for mapping in ({'artist': 1}, {'title': 0, 'artist': 0}, {'title': True, 'artist': 1}, {'title': 4, 'artist': 1}, {'title': 0, 'artist': 1, 'surprise': 2}):
            with self.subTest(mapping=mapping), self.assertRaises(LibraryError):
                self.importer.match(self.body(parsed, mapping=mapping))
        result = self.matched('Title,Artist,Duration\nCloudbusting,Kate Bush,wrong\n,Guest,2:10\n')
        self.assertEqual(result['summary']['unresolved'], 2)
        self.assertTrue(all(row['source']['warnings'] for row in result['rows']))
        self.assertIsNone(result['rows'][0]['choice'])
        with self.assertRaisesRegex(LibraryError, 'Resolve'):
            self.importer.review(self.body(result, name='Not ready'))

    def test_manual_search_choice_and_skip_preserve_csv_order_and_report_duplicate_collapse(self):
        result = self.matched('Title,Artist\nRunning Up That Hill,Kate Bush\nCloudbusting,Kate Bush\nMissing,Unknown\nCloudbusting,Kate Bush\n')
        found = self.importer.search(self.body(result, query='running', offset=0))
        self.assertEqual({t['id'] for t in found['tracks']}, {'101', '201'})
        result = self.importer.choose(self.body(result, position=0, track_id='201'))
        with self.assertRaises(LibraryError):
            self.importer.choose(self.body(result, position=2, track_id='105'))
        result = self.importer.choose(self.body(result, position=2, skip=True))
        self.assertEqual(result['summary']['unresolved'], 0)
        review = self.importer.review(self.body(result, name='Chosen', description='Keep notes'))
        self.assertEqual([t['id'] for t in review['tracks']], ['201', '102'])
        self.assertEqual((review['summary']['skipped'], review['summary']['duplicates']), (1, 1))
        self.studio.client._jsonrequest.assert_not_called()
        revised = self.importer.revise(self.body(review))
        self.assertEqual(revised['rows'][0]['status'], 'manual')
        self.assertEqual(revised['summary']['skipped'], 1)
        self.assertEqual(self.importer.view(self.body(revised, show='unresolved', offset=100))['rows'], [])

    def test_review_is_single_use_and_sends_only_a_private_playlist_then_checks_full_definition(self):
        matched = self.matched()
        review = self.importer.review(self.body(matched, name='Imported', description='Notes'))
        body = self.body(review, review_token=review['review_token'], approved=True)
        self.studio.client._jsonrequest.return_value = {'playlist_id': 500}
        response = self.importer.save(body)
        self.assertEqual(response, {'id': '500', 'job': 'checked'})
        self.studio.client._jsonrequest.assert_called_once_with('createplaylist', name='Imported', description='Notes', make_public=False, tracks=[102])
        callback = self.studio._check_later.call_args.args[2]
        raw = fixture()
        raw['library']['playlists']['500'] = {'name': 'Imported', 'description': 'Notes', 'tracks': [102], 'type': 'playlist'}
        self.assertEqual(callback(Library(raw))[0]['status'], 'saved')
        raw['library']['playlists']['500']['tracks'] = [103]
        self.assertEqual(callback(Library(raw))[0]['status'], 'unverified')
        with self.assertRaises(LibraryError):
            self.importer.save(body)
        self.assertEqual(self.studio.client._jsonrequest.call_count, 1)

    def test_ambiguous_creation_cannot_be_retried_and_other_steps_cannot_trigger_writes(self):
        review = self.importer.review(self.body(self.matched(), name='Uncertain'))
        body = self.body(review, review_token=review['review_token'], approved=True)
        self.studio.client._jsonrequest.side_effect = RuntimeError('Connection lost after sending')
        with self.assertRaises(RuntimeError):
            self.importer.save(body)
        with self.assertRaises(LibraryError):
            self.importer.save(body)
        with self.assertRaises(LibraryError):
            self.importer.choose(self.body(review, position=0, track_id=101))
        self.assertEqual(self.studio.client._jsonrequest.call_count, 1)

    def test_stale_revisions_accounts_library_replacements_and_in_place_changes_are_rejected(self):
        matched = self.matched()
        changed = self.importer.choose(self.body(matched, position=0, track_id=102))
        with self.assertRaises(ConflictError):
            self.importer.choose(self.body(matched, position=0, skip=True))
        review = self.importer.review(self.body(changed, name='Current'))
        body = self.body(review, review_token=review['review_token'], approved=True)
        with self.assertRaises(LibraryError):
            self.importer.save({**body, 'approved': False})
        with self.assertRaises(ConflictError):
            self.importer.save({**body, 'session': 'other'})
        old = self.studio.library
        self.studio.library = Library(fixture())
        with self.assertRaises(ConflictError):
            self.importer.save(body)
        self.studio.library = old
        old.tracks.rows[102]['title'] = 'Changed in place'
        with self.assertRaises(ConflictError):
            self.importer.save(body)
        self.studio.client._jsonrequest.assert_not_called()

    def test_remote_changes_save_serialization_expiry_discard_and_bounded_drafts(self):
        review = self.importer.review(self.body(self.matched(), name='Check remote'))
        body = self.body(review, review_token=review['review_token'], approved=True)
        self.studio.save_lock.acquire()
        try:
            with self.assertRaisesRegex(LibraryError, 'Another save'):
                self.importer.save(body)
        finally:
            self.studio.save_lock.release()
        def reload(client):
            raw = fixture()
            raw['library']['tracks']['102']['title'] = 'Changed remotely'
            self.studio.library = Library(raw)
            return self.studio.library, 'download'
        self.studio._current.side_effect = reload
        with self.assertRaises(ConflictError):
            self.importer.save(body)
        self.studio.client._jsonrequest.assert_not_called()
        first = self.read()
        self.read()
        last = self.read()
        self.assertEqual(len(self.importer.drafts), 2)
        with self.assertRaises(LibraryError):
            self.importer.match(self.body(first, mapping=first['mapping']))
        self.importer.discard(self.body(last))
        self.assertNotIn(last['id'], self.importer.drafts)
        fresh = self.matched()
        created = self.importer.drafts[fresh['id']]['created']
        with patch('tagcast.playlist_import.time.monotonic', return_value=created + 3601), self.assertRaisesRegex(LibraryError, 'expired'):
            self.importer.view(self.body(fresh))
        for key in ([], None, 'wrong'):
            with self.subTest(key=key), self.assertRaises(LibraryError):
                self.importer.view({'id': key, 'revision': 1, 'session': 'session'})

    def test_drafts_bind_the_original_session_and_combine_setting_even_for_the_same_client(self):
        matched = self.matched()
        self.studio.playback_session = 'rotated'
        with self.assertRaises(ConflictError):
            self.importer.view({**self.body(matched), 'session': 'rotated'})
        self.studio.playback_session = 'session'
        self.studio.library.combine_sets = True
        with self.assertRaises(ConflictError):
            self.importer.view(self.body(matched))
        self.studio.client._jsonrequest.assert_not_called()

    def test_selected_membership_is_checked_again_even_if_a_cached_record_was_mutated_in_place(self):
        review = self.importer.review(self.body(self.matched(), name='Membership'))
        self.studio.library.tracks.rows[102]['trashed'] = True
        with self.assertRaises(ConflictError):
            self.importer.save(self.body(review, review_token=review['review_token'], approved=True))
        self.studio.client._jsonrequest.assert_not_called()

    def test_own_fresh_read_can_accept_unrelated_remote_edits_after_checking_chosen_identities(self):
        review = self.importer.review(self.body(self.matched(), name='Still valid'))
        def reload(client):
            raw = fixture()
            raw['status']['lastmodified'] = 'newer'
            raw['library']['tracks']['201']['title'] = 'An unselected track changed'
            self.studio.library = Library(raw)
            return self.studio.library, 'download'
        self.studio._current.side_effect = reload
        self.studio.client._jsonrequest.return_value = {'playlist_id': 500}
        saved = self.importer.save(self.body(review, review_token=review['review_token'], approved=True))
        self.assertEqual(saved['id'], '500')
        self.assertEqual(self.studio.client._jsonrequest.call_args.kwargs['tracks'], [102])
        self.importer.discard(self.body(review))
        self.assertEqual(self.importer.drafts, {})

    def test_remote_removed_track_is_a_conflict_and_never_creates_a_partial_playlist(self):
        review = self.importer.review(self.body(self.matched(), name='Removed'))
        def reload(client):
            raw = fixture()
            del raw['library']['tracks']['102']
            self.studio.library = Library(raw)
            return self.studio.library, 'download'
        self.studio._current.side_effect = reload
        with self.assertRaises(ConflictError):
            self.importer.save(self.body(review, review_token=review['review_token'], approved=True))
        self.studio.client._jsonrequest.assert_not_called()

    def test_automatic_exact_matching_and_manual_search_cover_copies_beyond_the_suggestion_sample(self):
        raw = fixture()
        ids = list(range(1000, 2100))
        raw['library']['albums']['10']['tracks'].extend(ids)
        for i in ids:
            raw['library']['tracks'][str(i)] = {'title': 'Shared song', 'artist_id': 1 if i == 2099 else 2, 'album_id': 10}
        self.studio.library = Library(raw)
        matched = self.matched('Title,Artist\nShared song,Kate Bush\n')
        self.assertEqual(matched['rows'][0]['choice']['id'], '2099')
        found = self.importer.search(self.body(matched, query='Shared song', offset=1050))
        self.assertEqual(found['total'], 1100)
        self.assertEqual(len(found['tracks']), 50)
        self.assertIn('2099', [row['id'] for row in found['tracks']])

    def test_account_changes_during_manual_search_discard_the_old_results(self):
        matched = self.matched()
        def changed(query, offset):
            self.studio.playback_session = 'new-session'
            return [102], 1
        with patch.object(self.importer.catalogue, 'search', side_effect=changed), self.assertRaises(ConflictError):
            self.importer.search(self.body(matched, query='Cloudbusting'))
        self.studio.client._jsonrequest.assert_not_called()


class PlaylistImportProtocolTests(unittest.TestCase):
    def test_csv_creation_uses_oauth_and_fresh_native_readback_without_changing_music(self):
        from test_client import client, mock_ibroadcast
        original = copy.deepcopy(mock_ibroadcast.STATE)
        home = tempfile.TemporaryDirectory()
        studio = client.Studio(home.name)
        try:
            mock_ibroadcast.STATE.update(playlists={}, writes=[], reject=set(), busy=0, frozen=False)
            studio.set_client_id('test')
            studio._connect(client.oauth.TokenSet(mock_ibroadcast.TOKEN, 'refresh-1', time.time() + 3600, client.SCOPES))
            studio.load_library()
            before = copy.deepcopy(mock_ibroadcast.STATE['tracks'])
            track = studio.library.track_view(900)
            content = f'Title,Artist\n"{track["title"]}","{track["artist"]}"\n'
            parsed = studio.playlist_import.read({'session': studio.playback_session, 'text': content, 'delimiter': ','})
            def body(data, **fields):
                return {'session': studio.playback_session, 'id': data['id'], 'revision': data['revision'], **fields}
            matched = studio.playlist_import.match(body(parsed, mapping=parsed['mapping']))
            chosen = studio.playlist_import.choose(body(matched, position=0, track_id=900))
            review = studio.playlist_import.review(body(chosen, name='Imported CSV', description='Local review'))
            self.assertEqual(mock_ibroadcast.STATE['writes'], [])
            saved = studio.playlist_import.save(body(review, approved=True, review_token=review['review_token']))
            for _ in range(200):
                result = studio.job(saved['job'])
                if result['state'] != 'checking':
                    break
                time.sleep(.01)
            self.assertEqual(result['results'], [{'id': saved['id'], 'status': 'saved'}])
            self.assertEqual([w['mode'] for w in mock_ibroadcast.STATE['writes']], ['createplaylist'])
            self.assertFalse(mock_ibroadcast.STATE['writes'][0]['make_public'])
            self.assertEqual(mock_ibroadcast.STATE['tracks'], before)
        finally:
            with studio.cache_lock:
                pass
            home.cleanup()
            mock_ibroadcast.STATE.clear()
            mock_ibroadcast.STATE.update(original)
