"""CSV text, conservative matching, bounded review and single-use playlist creation."""

import copy
import csv
import io
import json
import os
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from tagcast.client import Studio
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.playlist_import import (
    CSV_EXPORT_MARKER,
    MAX_ROWS,
    PlaylistImport,
    TrackCatalogue,
    duration_seconds,
    parse_csv,
)


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

    def test_export_marker_decodes_exactly_one_escape_and_preserves_real_line_numbers(self):
        content = '\ufeff' + CSV_EXPORT_MARKER + '\r\nTitle,Artist\r\n\'\'=literal,\'+Artist\r\n'
        columns, rows, delimiter, blank = parse_csv(content)
        self.assertEqual((columns, delimiter, blank), (['Title', 'Artist'], ',', 0))
        self.assertEqual(rows, [{'line': 3, 'cells': ["'=literal", '+Artist']}])
        self.assertEqual(parse_csv('Title,Artist\n\'=literal,\'+Artist\n', ',')[1][0]['cells'], ["'=literal", "'+Artist"])
        self.assertEqual(parse_csv(content.replace(CSV_EXPORT_MARKER, CSV_EXPORT_MARKER + ',,,'))[1], rows)
        with patch('tagcast.playlist_import.MAX_TEXT', 1), patch('tagcast.playlist_import.MAX_EXPORT_TEXT', 1000):
            self.assertEqual(parse_csv(content)[1], rows)
            with self.assertRaisesRegex(LibraryError, '12 MB'):
                parse_csv('Title,Artist\nA,B\n', ',')
        long_cell = '=' + 'x' * 1999
        exported = CSV_EXPORT_MARKER + '\r\nTitle,Artist\r\n\'' + long_cell + ',Unknown\r\n'
        self.assertEqual(parse_csv(exported)[1][0]['cells'][0], long_cell)
        with patch('tagcast.playlist_import.MAX_EXPORT_TEXT', 50), self.assertRaisesRegex(LibraryError, '12 MB'):
            parse_csv(exported)


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

    def test_copy_preferences_choose_only_eligible_copies_in_a_stable_order(self):
        raw = fixture()
        raw['library']['tracks']['101'].update(type='audio/mpeg', year=1980)
        raw['library']['tracks']['201'].update(type='audio/x-flac', year=2008)
        raw['library']['tracks']['202'] = {**raw['library']['tracks']['201'], 'year': 1987}
        raw['library']['albums']['11']['tracks'].append(202)
        self.studio.library = Library(raw)
        for policy, expected in [('manual', None), ('first', '101'), ('oldest', '101'),
                                 ('flac', '201'), ('flac_oldest', '202')]:
            with self.subTest(policy=policy):
                result = self.matched('Title,Artist,Duration\nRunning Up That Hill,Kate Bush,300\n', copy_preference=policy)
                row = result['rows'][0]
                self.assertEqual(row['choice']['id'] if row['choice'] else None, expected)
                self.assertEqual(row['eligible'], 3)
                if expected:
                    self.assertEqual(row['status'], 'automatic')
                    self.assertIn('Originally selected using', row['reasons'][0])
                    chosen = self.importer.choose(self.body(result, position=0, track_id=101))
                    self.assertEqual(chosen['rows'][0]['reasons'], row['reasons'])
        self.studio._current.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()

    def test_preferences_never_relax_mapped_fields_versions_or_invalid_cells(self):
        for policy in ('first', 'oldest', 'flac', 'flac_oldest'):
            for field, value in [('Album', 'Wrong album'), ('Album artist', 'Guest'),
                                 ('Year', '2020'), ('Track number', '99'),
                                 ('Duration', '304'), ('Duration', 'invalid')]:
                with self.subTest(policy=policy, field=field, value=value):
                    result = self.matched(f'Title,Artist,{field}\nRunning Up That Hill,Kate Bush,{value}\n', copy_preference=policy)
                    self.assertIsNone(result['rows'][0]['choice'])
            result = self.matched('Title,Artist\nRunning Up That Hill (Live),Kate Bush\n', copy_preference=policy)
            self.assertIsNone(result['rows'][0]['choice'])
            result = self.matched('Title,Artist\nRunning Up That Hill,Guest\n', copy_preference=policy)
            self.assertIsNone(result['rows'][0]['choice'])
        for value in ('random', None, [], {}):
            with self.subTest(value=value), self.assertRaisesRegex(LibraryError, 'preference'):
                self.matched(copy_preference=value)

    def test_preferences_cover_full_index_and_handle_unknown_formats_years_and_ties(self):
        raw = fixture()
        track = raw['library']['tracks']['101']
        track['year'] = 0
        raw['library']['albums']['10']['year'] = 0
        raw['library']['albums']['11']['year'] = 2000
        for i in range(202, 240):
            raw['library']['tracks'][str(i)] = {**track, 'album_id': 11}
            raw['library']['albums']['11']['tracks'].append(i)
        raw['library']['tracks']['239'].update(type='audio/flac', year=1985)
        self.studio.library = Library(raw)
        csv = 'Title,Artist\nRunning Up That Hill,Kate Bush\n'
        for policy, expected in [('first', '101'), ('oldest', '239'), ('flac', '239'), ('flac_oldest', '239')]:
            row = self.matched(csv, copy_preference=policy)['rows'][0]
            self.assertEqual(row['choice']['id'], expected)
            self.assertEqual(row['eligible'], 40)
        self.studio.library.tracks.rows[239]['type'] = 'unknown'
        self.assertEqual(self.matched(csv, copy_preference='flac')['rows'][0]['choice']['id'], '101')
        self.studio.library.tracks.rows[239]['year'] = 2000
        self.assertEqual(self.matched(csv, copy_preference='oldest')['rows'][0]['choice']['id'], '201')

    def test_artist_name_difference_explains_fire_without_changing_matching_or_duration_tolerance(self):
        raw = fixture()
        raw['library']['artists']['1']['name'] = 'Arthur Brown'
        raw['library']['albums']['10']['name'] = 'The Crazy World Of Arthur Brown'
        raw['library']['tracks']['102'].update(title='Fire', length=175)
        self.studio.library = Library(raw)
        result = self.matched('Title,Artist,Album,Duration\nFire,The Crazy World Of Arthur Brown,The Crazy World Of Arthur Brown,02:54\n')
        row = result['rows'][0]
        self.assertIsNone(row['choice'])
        self.assertEqual(row['eligible'], 0)
        self.assertEqual(row['reasons'], ['Compared with the first suggestion: Performing artist name differs.'])
        self.assertEqual(row['candidates'][0]['id'], '102')
        self.assertEqual(row['candidates'][0]['differences'], ['Performing artist name differs'])
        chosen = self.importer.choose(self.body(result, position=0, track_id=102))
        self.assertEqual(chosen['rows'][0]['reasons'], row['reasons'])
        exact = self.matched('Title,Artist,Album,Duration\nFire,Arthur Brown,The Crazy World Of Arthur Brown,02:54\n')
        self.assertEqual(exact['rows'][0]['choice']['id'], '102')
        self.assertEqual(exact['rows'][0]['reasons'], [])
        self.assertEqual(exact['rows'][0]['candidates'][0]['differences'], [])
        self.studio._current.assert_not_called()
        self.studio.client._jsonrequest.assert_not_called()

    def test_match_explanations_cover_versions_optional_fields_and_missing_library_values(self):
        for field, value, difference in [
                ('Title', 'Cloudbusting (Remastered 2008)', 'Track title differs (including version text)'),
                ('Album', 'Other album', 'Album title differs'),
                ('Album artist', 'Guest', 'Album artist name differs'),
                ('Year', '2000', 'Release year differs'),
                ('Track number', '9', 'Track number differs'),
                ('Duration', '05:14', 'Duration differs by more than 3 seconds')]:
            columns = ['Title', 'Artist'] + ([] if field == 'Title' else [field])
            values = [value if field == 'Title' else 'Cloudbusting', 'Kate Bush'] + ([] if field == 'Title' else [value])
            row = self.matched(','.join(columns) + '\n' + ','.join(values) + '\n')['rows'][0]
            with self.subTest(field=field):
                self.assertIsNone(row['choice'])
                candidate = next(c for c in row['candidates'] if c['id'] == '102')
                self.assertEqual(candidate['differences'], [difference])
                self.assertIn(difference, row['reasons'][0])
        for length, automatic in [(307, True), (313, True), (314, False)]:
            row = self.matched(f'Title,Artist,Duration\nCloudbusting,Kate Bush,{length}\n')['rows'][0]
            self.assertEqual(row['choice'] is not None, automatic)
        self.studio.library.tracks.rows[102].update(length=0, track=0)
        self.studio.library.albums.rows[10]['year'] = 0
        row = self.matched('Title,Artist,Duration,Year,Track number\nCloudbusting,Kate Bush,310,1985,2\n')['rows'][0]
        self.assertEqual(row['candidates'][0]['differences'], [
            'Library track has no release year', 'Library track has no track number', 'Library track has no duration'])

    def test_multiple_copies_invalid_csv_and_no_suggestions_have_honest_explanations(self):
        result = self.matched('Title,Artist\nRunning Up That Hill,Kate Bush\n')
        row = result['rows'][0]
        self.assertEqual(row['reasons'], ['2 library tracks match all mapped fields. Choose a copy.'])
        self.assertTrue(all(c['differences'] == [] for c in row['candidates']))
        skipped = self.importer.choose(self.body(result, position=0, skip=True))
        self.assertEqual(skipped['rows'][0]['reasons'], row['reasons'])
        row = self.matched('Title,Artist,Duration\nCloudbusting,Kate Bush,wrong\n')['rows'][0]
        self.assertEqual(row['reasons'], ['CSV fields need attention; check the warnings.'])
        self.assertTrue(row['source']['warnings'])
        self.assertEqual(row['candidates'][0]['differences'], [])
        row = self.matched('Title,Artist\nCloudbusting,\n')['rows'][0]
        self.assertEqual(row['reasons'][0], 'CSV fields need attention; check the warnings.')
        self.assertIn('No matching suggestion', row['reasons'][1])
        row = self.matched('Title,Artist\nNo such song,Unknown\n')['rows'][0]
        self.assertEqual(row['candidates'], [])
        self.assertEqual(row['reasons'], ['No matching suggestion was found in the loaded library. Search manually or check the CSV columns.'])

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

    def test_thousand_row_import_can_review_and_save_one_hundred_matches_omitting_the_rest(self):
        raw = fixture()
        ids = list(range(1000, 1100))
        raw['library']['albums']['10']['tracks'] = ids
        for track_id in ids:
            raw['library']['tracks'][str(track_id)] = {'title': f'Imported {track_id}', 'artist_id': 1, 'album_id': 10}
        self.studio.library = Library(raw)
        self.studio._current.return_value = (self.studio.library, 'memory')
        parsed = self.read('Title,Artist\n' + ''.join(f'Imported {i},Kate Bush\n' for i in ids) + 'Missing,Unknown\n' * 900)
        matched = self.importer.match(self.body(parsed, mapping=parsed['mapping'], show='unresolved', offset=0))
        self.assertEqual((matched['show'], matched['total'], len(matched['rows'])), ('unresolved', 900, 50))
        self.assertEqual(matched['rows'][0]['position'], 100)
        self.assertEqual((matched['summary']['automatic'], matched['summary']['unresolved']), (100, 900))
        with self.assertRaisesRegex(LibraryError, 'explicitly continue'):
            self.importer.review(self.body(matched, name='Partial'))
        for invalid in ('true', 1, None):
            with self.subTest(value=invalid), self.assertRaises(LibraryError):
                self.importer.review(self.body(matched, name='Partial', omit_unresolved=invalid))
        review = self.importer.review(self.body(matched, name='Partial', omit_unresolved=True))
        self.assertEqual((review['total'], review['omitted_unresolved'], len(review['tracks'])), (100, 900, 50))
        self.assertEqual(review['summary']['skipped'], 0, 'Omission does not silently skip or mutate unresolved rows')
        page = self.importer.view(self.body(review, review=True, offset=50))
        self.assertEqual(page['omitted_unresolved'], 900)
        self.assertEqual([t['id'] for t in page['tracks']], [str(i) for i in ids[50:]])
        self.studio.client._jsonrequest.assert_not_called()
        revised = self.importer.revise(self.body(review, show='unresolved', offset=850))
        self.assertEqual((revised['show'], revised['offset'], revised['summary']['unresolved']), ('unresolved', 850, 900))
        self.assertEqual(revised['rows'][0]['position'], 950)
        review = self.importer.review(self.body(revised, name='Partial', omit_unresolved=True))
        self.studio.client._jsonrequest.return_value = {'playlist_id': 500}
        self.importer.save(self.body(review, review_token=review['review_token'], approved=True))
        self.assertEqual(self.studio.client._jsonrequest.call_args.kwargs['tracks'], ids)

    def test_partial_review_keeps_manual_choices_skips_duplicates_and_csv_order_distinct(self):
        result = self.matched('Title,Artist\nCloudbusting,Kate Bush\nRunning Up That Hill,Kate Bush\nMissing,Unknown\nCloudbusting,Kate Bush\nSkip me,Unknown\n')
        result = self.importer.choose(self.body(result, position=1, track_id=201))
        result = self.importer.choose(self.body(result, position=4, skip=True))
        review = self.importer.review(self.body(result, name='Mixed', omit_unresolved=True))
        self.assertEqual([t['id'] for t in review['tracks']], ['102', '201'])
        self.assertEqual(review['omitted_unresolved'], 1)
        self.assertEqual((review['summary']['automatic'], review['summary']['manual'], review['summary']['duplicates'], review['summary']['skipped']), (2, 1, 1, 1))
        empty = self.matched('Title,Artist\nMissing,Unknown\n')
        with self.assertRaisesRegex(LibraryError, 'at least one track'):
            self.importer.review(self.body(empty, name='Empty', omit_unresolved=True))
        self.studio.client._jsonrequest.assert_not_called()

    def test_unresolved_export_keeps_original_columns_cells_order_and_all_pages_then_reimports(self):
        columns = ['Title', 'Artist', 'Release Date', 'Album', 'Duration (ms)', 'Notes', 'URL']
        records = [
            ['Cloudbusting', 'Kate Bush', '1985', 'Hounds of Love', '310000', 'matched', ''],
            ['Missing', 'Unknown', '2020-01-02', 'Some, album', '+123000', '=HYPERLINK("https://example.invalid")', 'https://example.invalid'],
            ['Skip me', 'Unknown', '', '', '', 'skipped', ''],
            ['Running Up That Hill', 'Kate Bush', '1985', '', '300000', "'literal\nsecond line", '\\N'],
            ['Cloudbusting', 'Kate Bush', '1985', 'Hounds of Love', '310000', 'matched again', ''],
        ]
        content = io.StringIO(newline='')
        writer = csv.writer(content, delimiter=';')
        writer.writerow(columns)
        writer.writerows(records)
        parsed = self.read(content.getvalue(), delimiter=';')
        result = self.importer.match(self.body(parsed, mapping=parsed['mapping'], duration_unit='milliseconds', show='automatic'))
        result = self.importer.choose(self.body(result, position=2, skip=True, show='automatic'))
        before = copy.deepcopy(self.importer.drafts[result['id']]['rows'])
        exported = self.importer.export(self.body(result))
        self.assertEqual((exported['count'], exported['filename']), (2, 'tagcast-unresolved-2.csv'))
        self.assertTrue(exported['text'].startswith('\ufeff' + CSV_EXPORT_MARKER + '\r\n'))
        raw = list(csv.reader(io.StringIO(exported['text'].split('\n', 1)[1], newline='')))
        self.assertTrue(raw[1][5].startswith("'=HYPERLINK"))
        decoded_columns, decoded, _, _ = parse_csv(exported['text'])
        self.assertEqual(decoded_columns, columns)
        self.assertEqual([r['cells'] for r in decoded], [records[1], records[3]])
        self.assertEqual(self.importer.drafts[result['id']]['rows'], before)
        reimported = self.read(exported['text'])
        matches = self.importer.match(self.body(reimported, mapping=reimported['mapping'], duration_unit='milliseconds'))
        self.assertEqual(matches['summary']['total'], 2)
        self.assertEqual(matches['rows'][0]['source']['duration'], '+123000')
        self.assertEqual(matches['rows'][0]['source']['warnings'], [])
        self.studio.client._jsonrequest.assert_not_called()
        self.studio._current.assert_not_called()

    def test_export_covers_every_unresolved_page_and_survives_own_save_readback_only_in_same_session(self):
        result = self.matched('Title,Artist\nCloudbusting,Kate Bush\n' + 'Missing,Unknown\n' * 125)
        exported = self.importer.export(self.body(result, offset=100, show='automatic'))
        self.assertEqual(len(parse_csv(exported['text'])[1]), 125)
        review = self.importer.review(self.body(result, name='Partial', omit_unresolved=True))
        self.studio.client._jsonrequest.return_value = {'playlist_id': 500}
        self.importer.save(self.body(review, review_token=review['review_token'], approved=True))
        self.studio.library = Library(fixture())  # read-back publishes a new library copy
        self.assertEqual(self.importer.export(self.body(review))['count'], 125)
        for changed in ('session', 'account', 'client', 'combine'):
            with self.subTest(changed=changed):
                original = (self.studio.playback_session, self.studio.library_user, self.studio.client, self.studio.library.combine_sets)
                if changed == 'session':
                    self.studio.playback_session = 'other'
                if changed == 'account':
                    self.studio.library_user = 'other'
                if changed == 'client':
                    self.studio.client = Mock()
                if changed == 'combine':
                    self.studio.library.combine_sets = True
                with self.assertRaises(ConflictError):
                    self.importer.export(self.body(review))
                self.studio.playback_session, self.studio.library_user, self.studio.client, self.studio.library.combine_sets = original
        self.importer.discard(self.body(review))
        with self.assertRaises(LibraryError):
            self.importer.export(self.body(review))
        complete = self.matched()
        with self.assertRaisesRegex(LibraryError, 'no unresolved'):
            self.importer.export(self.body(complete))

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


class PausedImportTests(unittest.TestCase):
    setUp = PlaylistImportTests.setUp
    body = PlaylistImportTests.body
    read = PlaylistImportTests.read
    matched = PlaylistImportTests.matched

    def paused(self, matched=None, **fields):
        matched = matched or self.matched()
        return self.importer.pause(self.body(matched, name='Saved CSV', show='all', **fields))['saved']

    def saved_body(self, saved, **fields):
        return {'saved_id': saved['id'], 'saved_token': saved['token'],
                'session': self.studio.playback_session, **fields}

    def test_pause_survives_restart_and_new_uploads_without_losing_manual_choices_or_skips(self):
        data = self.matched('Title,Artist\nCloudbusting,Kate Bush\nNew song,Kate Bush\nRunning Up That Hill,Kate Bush\nSkip me,Kate Bush\n')
        data = self.importer.choose(self.body(data, position=2, track_id='101'))
        data = self.importer.choose(self.body(data, position=3, skip=True))
        saved = self.paused(data, description='Keep these notes')
        self.assertNotIn(data['id'], self.importer.drafts)
        self.assertIsNone(self.importer.catalogue)
        path = self.studio.home / self.importer.paused_store.filename('one')
        raw = path.read_text()
        self.assertIn('New song', raw)
        for secret in ('playback_session', 'review_token', 'access_token', 'refresh_token', 'combine_sets', 'library'):
            self.assertNotIn('"' + secret + '"', raw)
        if os.name != 'nt':
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        fresh = fixture()
        fresh['library']['tracks']['106'] = {'album_id': 10, 'artist_id': 1, 'title': 'New song', 'length': 180}
        fresh['library']['albums']['10']['tracks'].append(106)
        self.studio.library = Library(fresh)
        self.studio.client = Mock()
        self.studio.playback_session = 'after-restart'
        self.importer = PlaylistImport(self.studio)
        with patch('tagcast.playlist_import.time.monotonic', return_value=99999999):
            result = self.importer.resume(self.saved_body(saved))
        view = result['view']
        self.assertEqual((result['name'], result['description']), ('Saved CSV', 'Keep these notes'))
        self.assertEqual([r['status'] for r in view['rows']], ['automatic', 'automatic', 'manual', 'skipped'])
        self.assertEqual(view['rows'][1]['choice']['id'], '106')
        self.assertEqual((view['summary']['unresolved'], view['summary']['manual']), (0, 1))
        self.studio.client._jsonrequest.assert_not_called()
        self.studio._current.assert_not_called()
        self.importer.discard({'id': view['id'], 'session': self.studio.playback_session})
        self.assertEqual(len(self.importer.paused({'session': self.studio.playback_session})['imports']), 1)

    def test_changed_manual_choice_stays_unresolved_even_after_another_pause(self):
        data = self.matched()
        data = self.importer.choose(self.body(data, position=0, track_id=102))
        saved = self.paused(data)
        fresh = fixture()
        fresh['library']['tracks']['102']['length'] = 311
        self.studio.library = Library(fresh)
        result = self.importer.resume(self.saved_body(saved))['view']
        self.assertIsNone(result['rows'][0]['choice'])
        self.assertIn('previous manual choice changed', ' '.join(result['rows'][0]['reasons']))
        again = self.paused(result)
        self.assertEqual(again['id'], saved['id'])
        result = self.importer.resume(self.saved_body(again))['view']
        self.assertIsNone(result['rows'][0]['choice'])
        chosen = self.importer.choose(self.body(result, position=0, track_id=102))
        self.assertEqual(chosen['rows'][0]['status'], 'manual')
        self.assertNotIn('previous manual choice changed', ' '.join(chosen['rows'][0]['reasons']))

    def test_mapping_and_review_checkpoints_resume_without_reusing_approval(self):
        parsed = self.read()
        saved = self.paused(parsed, mapping={'title': 0, 'artist': None}, duration_unit='milliseconds')
        restored = self.importer.resume(self.saved_body(saved))
        self.assertEqual(restored['view']['phase'], 'mapping')
        self.assertEqual(restored['mapping'], {'title': 0, 'artist': None})
        self.assertEqual(restored['duration_unit'], 'milliseconds')
        data = self.matched()
        review = self.importer.review(self.body(data, name='Reviewed'))
        saved = self.paused(review)
        raw = (self.studio.home / self.importer.paused_store.filename('one')).read_text()
        self.assertNotIn(review['review_token'], raw)
        restored = self.importer.resume(self.saved_body(saved))['view']
        self.assertEqual(restored['phase'], 'matched')
        with self.assertRaises(LibraryError):
            self.importer.save(self.body(restored, approved=True, review_token=review['review_token']))

    def test_paused_copy_preference_survives_restart_and_older_checkpoints_default_to_manual(self):
        data = self.matched('Title,Artist\nRunning Up That Hill,Kate Bush\n', copy_preference='flac_oldest')
        saved = self.paused(data)
        self.importer = PlaylistImport(self.studio)
        result = self.importer.resume(self.saved_body(saved))
        self.assertEqual(result['copy_preference'], 'flac_oldest')
        self.assertEqual(result['file']['copy_preference'], 'flac_oldest')
        self.assertEqual(result['view']['rows'][0]['choice']['id'], '101')
        saved = self.paused(result['view'])
        rows = self.importer.paused_store.load('one')
        del rows[saved['id']]['copy_preference']
        self.importer.paused_store.write('one', rows)
        result = self.importer.resume(self.saved_body(saved))
        self.assertEqual(result['copy_preference'], 'manual')
        self.assertIsNone(result['view']['rows'][0]['choice'])
        with self.assertRaisesRegex(LibraryError, 'preference'):
            self.paused(result['view'], copy_preference='unknown')
        rows[saved['id']]['copy_preference'] = 'unknown'
        self.importer.paused_store.write('one', rows)
        with self.assertRaisesRegex(LibraryError, 'could not be read'):
            self.importer.resume(self.saved_body(saved))

    def test_unfinished_mapping_keeps_preference_and_changed_preference_resets_choices(self):
        parsed = self.read()
        saved = self.paused(parsed, copy_preference='oldest')
        result = self.importer.resume(self.saved_body(saved))
        self.assertEqual(result['view']['phase'], 'mapping')
        self.assertEqual(result['view']['copy_preference'], 'oldest')
        data = self.matched(copy_preference='flac')
        data = self.importer.choose(self.body(data, position=0, track_id=102))
        saved = self.paused(data, copy_preference='first')
        result = self.importer.resume(self.saved_body(saved))
        self.assertEqual(result['view']['phase'], 'mapping')
        self.assertEqual(result['copy_preference'], 'first')

    def test_ten_checkpoints_are_never_evicted_and_repause_uses_compare_and_swap(self):
        saved = [self.paused() for _ in range(10)]
        active = self.matched()
        with self.assertRaisesRegex(LibraryError, '10 paused'):
            self.paused(active)
        self.assertIn(active['id'], self.importer.drafts)
        self.assertEqual(len(self.importer.paused({'session': 'session'})['imports']), 10)
        with self.assertRaises(ConflictError):
            self.importer.remove_paused(self.saved_body(saved[0], saved_token='stale'))
        self.importer.remove_paused(self.saved_body(saved[0]))
        self.paused(active)
        view = self.importer.resume(self.saved_body(saved[-1]))['view']
        updated = self.paused(view)
        self.assertEqual(updated['id'], saved[-1]['id'])
        self.assertNotEqual(updated['token'], saved[-1]['token'])
        with self.assertRaises(ConflictError):
            self.importer.resume(self.saved_body(saved[-1]))

    def test_mapping_changes_never_reuse_choices_made_for_different_columns(self):
        data = self.matched()
        data = self.importer.choose(self.body(data, position=0, track_id=102))
        saved = self.paused(data, mapping={'title': 1, 'artist': 0})
        restored = self.importer.resume(self.saved_body(saved))
        self.assertEqual(restored['view']['phase'], 'mapping')
        self.assertEqual(restored['mapping'], {'title': 1, 'artist': 0})
        self.assertNotIn('rows', self.importer.drafts[restored['view']['id']])

    def test_saved_imports_are_account_scoped_and_do_not_follow_connection_changes(self):
        saved = self.paused()
        self.studio.library_user = 'another-account'
        self.studio.playback_session = 'other-session'
        self.assertEqual(self.importer.paused({'session': 'other-session'})['imports'], [])
        with self.assertRaises(ConflictError):
            self.importer.resume(self.saved_body(saved))
        with self.assertRaises(ConflictError):
            self.importer.paused({'session': 'session'})
        self.studio.library_user = 'one'
        self.assertEqual(len(self.importer.paused({'session': 'other-session'})['imports']), 1)

    def test_creation_intent_survives_an_ambiguous_request_and_cannot_resume_or_resend(self):
        saved = self.paused()
        restored = self.importer.resume(self.saved_body(saved))['view']
        review = self.importer.review(self.body(restored, name='Create once'))
        self.studio.client._jsonrequest.side_effect = RuntimeError('Lost response')
        body = self.body(review, approved=True, review_token=review['review_token'])
        with self.assertRaises(RuntimeError):
            self.importer.save(body)
        with self.assertRaises(LibraryError):
            self.importer.save(body)
        self.importer = PlaylistImport(self.studio)
        entry = self.importer.paused({'session': 'session'})['imports'][0]
        self.assertEqual((entry['state'], entry['name']), ('submitted', 'Create once'))
        with self.assertRaises(ConflictError):
            self.importer.resume(self.saved_body(saved))
        self.studio.client._jsonrequest.assert_called_once()

    def test_concurrent_resumes_can_create_only_once_and_confirmed_readback_removes_the_checkpoint(self):
        saved = self.paused()
        first = self.importer.resume(self.saved_body(saved))['view']
        second = self.importer.resume(self.saved_body(saved))['view']
        first = self.importer.review(self.body(first, name='Create once'))
        second = self.importer.review(self.body(second, name='Create once'))
        self.studio.client._jsonrequest.return_value = {'playlist_id': 999}
        self.importer.save(self.body(first, approved=True, review_token=first['review_token']))
        with self.assertRaises(ConflictError):
            self.importer.save(self.body(second, approved=True, review_token=second['review_token']))
        self.studio.client._jsonrequest.assert_called_once()
        after = fixture()
        after['library']['playlists']['999'] = {'name': 'Create once', 'description': '', 'tracks': [102]}
        results = self.studio._check_later.call_args.args[2](Library(after))
        self.assertEqual(results, [{'id': '999', 'status': 'saved'}])
        self.assertEqual(self.importer.paused({'session': 'session'})['imports'], [])

    def test_storage_errors_keep_open_drafts_and_corrupt_files_are_never_overwritten(self):
        active = self.matched()
        with patch.object(self.studio, '_write_bytes', side_effect=OSError), self.assertRaises(LibraryError):
            self.paused(active)
        self.assertIn(active['id'], self.importer.drafts)
        saved = self.paused(active)
        path = self.studio.home / self.importer.paused_store.filename('one')
        original = path.read_bytes()
        for mutation in ('not json', json.dumps({'version': 1, 'account': 'wrong', 'imports': []})):
            path.write_text(mutation)
            with self.assertRaises(LibraryError):
                self.importer.paused({'session': 'session'})
            with self.assertRaises(LibraryError):
                self.paused()
            self.assertEqual(path.read_text(), mutation)
        path.write_bytes(original)
        with patch('tagcast.playlist_import_store.MAX_PAUSED_BYTES', 1), self.assertRaises(LibraryError):
            self.importer.resume(self.saved_body(saved))


class PlaylistImportProtocolTests(unittest.TestCase):
    def test_csv_creation_uses_oauth_and_fresh_native_readback_without_changing_music(self):
        self.check_csv_creation(paused=False)

    def test_resumed_creation_consumes_and_removes_its_checkpoint_after_native_readback(self):
        self.check_csv_creation(paused=True)

    def check_csv_creation(self, paused):
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
            content = f'Title,Artist\n"{track["title"]}","{track["artist"]}"\nMissing CSV song,Unknown performer\n'
            parsed = studio.playlist_import.read({'session': studio.playback_session, 'text': content, 'delimiter': ','})
            def body(data, **fields):
                return {'session': studio.playback_session, 'id': data['id'], 'revision': data['revision'], **fields}
            matched = studio.playlist_import.match(body(parsed, mapping=parsed['mapping']))
            chosen = studio.playlist_import.choose(body(matched, position=0, track_id=900))
            if paused:
                checkpoint = studio.playlist_import.pause(body(chosen, name='Saved protocol import'))['saved']
                studio.playlist_import = PlaylistImport(studio)
                chosen = studio.playlist_import.resume({'session': studio.playback_session,
                    'saved_id': checkpoint['id'], 'saved_token': checkpoint['token']})['view']
            review = studio.playlist_import.review(body(chosen, name='Imported CSV', description='Local review', omit_unresolved=True))
            self.assertEqual(review['omitted_unresolved'], 1)
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
            if paused:
                self.assertEqual(studio.playlist_import.paused({'session': studio.playback_session})['imports'], [])
        finally:
            with studio.cache_lock:
                pass
            home.cleanup()
            mock_ibroadcast.STATE.clear()
            mock_ibroadcast.STATE.update(original)
