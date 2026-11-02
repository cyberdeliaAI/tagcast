"""Synthetic display fixtures only: no public lyrics, real account or audio requests."""

import copy
import json
import unittest
from unittest.mock import Mock, patch

import requests
import test_lyrics
import yaml

from tagcast.library import ConflictError, LibraryError
from tagcast.playback_lyrics import (
    _lrclib_lines,
    fetch_lrclib_display,
    fetch_unison,
    lyric_time,
    parse_lrc,
    parse_ttml,
)
from tagcast.sources import SourceError


class TimedLyricsTests(unittest.TestCase):
    def test_clock_and_offset_times_are_bounded(self):
        for value, expected in (("01:02.25", 62.25), ("1:02:03", 3723),
                                ("500ms", .5), ("1.5m", 90), ("2h", 7200)):
            self.assertEqual(lyric_time(value), expected)
        for value in (None, "NaN", "-1s", "01:99", "25h", "3f", "10t"):
            self.assertIsNone(lyric_time(value))

    def test_lrc_offsets_repeated_lines_word_markers_and_instrumental_breaks(self):
        result = parse_lrc("[ar:Synthetic]\n[re:Test]\n[offset:500]\n"
                           "[00:01.00][00:05.00]<00:01.00>First <00:01.50>line\n"
                           "[00:03.00]\n[00:07.00]Last line", 10)
        self.assertTrue(result["timed"])
        self.assertEqual([line["start"] for line in result["lines"]], [1.5, 3.5, 5.5, 7.5])
        self.assertEqual(result["lines"][0]["text"], "First line")
        self.assertEqual(result["lines"][1]["text"], "")
        self.assertEqual(result["lines"][0]["end"], 3.5)
        self.assertEqual(result["lines"][0]["words"], [
            {"start": 1.5, "end": 2, "text": "First "},
            {"start": 2, "end": 3.5, "text": "line"}])
        self.assertEqual(result["lines"][2]["words"][0]["start"], 5.5)

    def test_ttml_apple_absolute_song_times_and_plain_text(self):
        value = ('<tt xmlns="http://www.w3.org/ns/ttml" '
                 'xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" itunes:timing="Word">'
                 '<body><div begin="10s"><p begin="10s" end="12s">'
                 '<span begin="10s" end="11s">First </span><span begin="11s">line &amp; more</span>'
                 '</p><p begin="15s" end="18s">Next line</p></div></body></tt>')
        result = parse_ttml(value, 20)
        self.assertEqual(result["lines"][0], {"start": 10, "end": 12, "text": "First line & more",
            "words": [{"start": 10, "end": 11, "text": "First "},
                      {"start": 11, "end": 12, "text": "line & more"}]})
        self.assertTrue(result["timed"])
        self.assertFalse(parse_ttml('<tt><body><p>Plain line</p></body></tt>', 20)["timed"])

    def test_ttml_relative_times_and_duration(self):
        result = parse_ttml('<tt><body><div begin="20s"><p begin="1s" dur="2s">'
                            'Relative line</p></div></body></tt>', 30)
        self.assertEqual(result["lines"][0], {"start": 21, "end": 23, "text": "Relative line"})

    def test_ttml_breaks_and_equal_timestamps_keep_complete_lines(self):
        result = parse_ttml('<tt><p begin="1s">First<br/>Second</p>'
                            '<p begin="1s">Duet</p><p begin="3s">Ending</p></tt>', 10)
        self.assertEqual(result['lines'][0]['text'], 'First\nSecond')
        self.assertEqual([line['end'] for line in result['lines']], [3, 3, 10])
        with self.assertRaises(SourceError):
            parse_ttml('<tt><body begin="24h"><p begin="1s">Over limit</p></body></tt>', 0)

    def test_malformed_and_unbounded_timing_or_xml_are_rejected(self):
        for value in ('<!DOCTYPE tt [<!ENTITY a "test">]><tt><p>&a;</p></tt>', '<tt><p>Broken',
                      '<tt><body><p begin="10s" end="2s">Wrong end</p></body></tt>'):
            with self.subTest(value=value), self.assertRaises(SourceError):
                parse_ttml(value, 20)
        for value in ('[00:99]Invalid', '[00:40]Wrong recording', '[00:01]x\n' * 2001):
            with self.subTest(value=value[:30]), self.assertRaises(SourceError):
                parse_lrc(value, 20)

    def test_mixed_or_missing_timing_degrades_to_readable_text(self):
        result = parse_lrc('Untimed heading\n[00:01.00]First line', 20)
        self.assertFalse(result['timed'])
        self.assertTrue(all(line['start'] is None for line in result['lines']))


class WordLyricsTests(unittest.TestCase):
    def setUp(self):
        self.document = {"version": "1.0", "metadata": {
            "title": "Synthetic (Live)", "artist": "Test Artist", "duration_ms": 10000},
            "lines": [{"text": "First line", "start_ms": 1000, "end_ms": 4000, "words": [
                {"text": "First ", "start_ms": 1000, "end_ms": 2000},
                {"text": "line", "start_ms": 2000, "end_ms": 3500}]}]}
        self.record = {"trackName": "Synthetic (Live)", "artistName": "Test Artist", "duration": 10,
                       "syncedLyrics": "[00:01]Legacy line", "plainLyrics": "Legacy text"}

    def read(self, document=None, **record):
        value = self.document if document is None else document
        return _lrclib_lines({**self.record, "lyricsfile": value if isinstance(value, str)
                             else yaml.safe_dump(value, allow_unicode=True), **record}, 10)

    def test_lyricsfile_words_are_seconds_and_work_without_legacy_fields_or_hint(self):
        result = self.read(syncedLyrics=None, plainLyrics=None, hasWordSync=True)
        self.assertEqual(result["lines"][0], {"text": "First line", "start": 1, "end": 4,
            "words": [{"text": "First ", "start": 1, "end": 2},
                      {"text": "line", "start": 2, "end": 3.5}]})
        self.assertTrue(result["timed"])
        self.assertEqual(result["source"], "lrclib")
        self.assertIn("words", self.read(hasWordSync=False)["lines"][0])

    def test_unicode_segments_overlap_and_missing_ends_preserve_text_and_line_timing(self):
        self.document["lines"] = [
            {"text": "日本語 & <test>", "start_ms": 1000, "end_ms": 4000, "words": [
                {"text": "日本", "start_ms": 1000, "end_ms": 2500},
                {"text": "語 & <test>", "start_ms": 2000}]},
            {"text": "Other singer", "start_ms": 2000, "end_ms": 5000}]
        lines = self.read()["lines"]
        self.assertEqual([line["end"] for line in lines], [4, 5])
        self.assertEqual(lines[0]["words"][1]["end"], 4)
        self.assertEqual("".join(word["text"] for word in lines[0]["words"]), lines[0]["text"])

    def test_bad_optional_word_data_falls_back_to_the_complete_line(self):
        for change in ({"start_ms": True}, {"start_ms": -1}, {"start_ms": 20000},
                       {"end_ms": 6000}, {"end_ms": 500}, {"text": "Wrong text"},
                       {"start_ms": 2500}):
            document = copy.deepcopy(self.document)
            document["lines"][0]["words"][0].update(change)
            with self.subTest(change=change):
                line = self.read(document)["lines"][0]
                self.assertEqual(line["text"], "First line")
                self.assertNotIn("words", line)
                self.assertEqual((line["start"], line["end"]), (1, 4))

    def test_unknown_versions_identity_duration_offsets_and_invalid_lines_use_legacy(self):
        changes = [({"version": "2.0"}, {}), ({"version": 1}, {}),
                   ({}, {"title": "Synthetic"}), ({}, {"artist": "Wrong artist"}),
                   ({}, {"duration_ms": 13000}), ({}, {"duration_ms": True}),
                   ({}, {"offset_ms": 10}), ({}, {"offset_ms": False})]
        for fields, meta in changes:
            document = copy.deepcopy(self.document)
            document.update(fields)
            document["metadata"].update(meta)
            self.assertEqual(self.read(document)["lines"][0]["text"], "Legacy line")
        for value in (True, -1, "1000", 90000000):
            document = copy.deepcopy(self.document)
            document["lines"][0]["start_ms"] = value
            self.assertEqual(self.read(document)["lines"][0]["text"], "Legacy line")

    def test_yaml_is_bounded_and_rejects_objects_aliases_duplicates_and_extra_documents(self):
        valid = yaml.safe_dump(self.document)
        bad = [valid + "\nversion: '2.0'", valid + "\n---\nversion: '1.0'",
               valid + "\nextra: &a [1, 2]\ncopy: *a", valid + "\nextra: !!python/object/apply:os.system ['false']",
               valid + "\nextra: !!binary SGVsbG8=", valid + "\nextra: " + "[" * 50 + "]" * 50,
               valid + "\nextra: {key: first, key: second}", "x" * 512001, "\x00"]
        for value in bad:
            with self.subTest(value=value[-65:]):
                self.assertEqual(self.read(value)["lines"][0]["text"], "Legacy line")
        self.assertEqual(self.read(valid + "\nextra: [1, true, null, text]")["lines"][0]["text"], "First line")

    def test_plain_lyricsfile_does_not_displace_legacy_timing(self):
        self.document.update(lines=[], plain="Plain words\n\nAnother verse")
        self.assertEqual(self.read()["lines"][0]["text"], "Legacy line")
        result = self.read(syncedLyrics=None, plainLyrics=None)
        self.assertFalse(result["timed"])
        self.assertEqual([line["text"] for line in result["lines"]], ["Plain words", "", "Another verse"])

    def test_optional_word_and_line_limits_do_not_expand_the_display(self):
        self.document["lines"][0]["words"] *= 1001
        self.assertNotIn("words", self.read()["lines"][0])
        self.document["lines"] *= 2001
        self.assertEqual(self.read()["lines"][0]["text"], "Legacy line")

    def test_ttml_nested_relative_spans_and_spaces(self):
        result = parse_ttml('<tt><body begin="10s"><p begin="1s" dur="5s"> '
            '<span><span begin="0s" dur="1s"><span>One</span></span> '
            '<span begin="1s" dur="2s">two</span></span> </p></body></tt>', 20)
        line = result["lines"][0]
        self.assertEqual(line, {"text": "One two", "start": 11, "end": 16,
            "words": [{"text": "One ", "start": 11, "end": 12},
                      {"text": "two", "start": 12, "end": 14}]})

    def test_ttml_incomplete_invalid_or_unordered_spans_keep_readable_lines(self):
        for content in ('Unmarked <span begin="1s">word</span>',
                        '<span begin="1s" end="9s">Outside</span>',
                        '<span begin="2s">Two </span><span begin="1s">one</span>',
                        '<span begin="1s" end="NaN">Unknown end</span>',
                        '<span begin="NaN">Unknown</span>'):
            result = parse_ttml('<tt><p begin="0s" end="5s">' + content + '</p></tt>', 10)
            self.assertTrue(result["timed"])
            self.assertNotIn("words", result["lines"][0])
            self.assertTrue(result["lines"][0]["text"])
        with self.assertRaises(SourceError):
            parse_ttml('<tt><p begin="1s">' + '<span>' * 42 + 'Text' + '</span>' * 42 + '</p></tt>', 10)
        with self.assertRaises(SourceError):
            parse_ttml('<tt><p begin="1s"><span begin="0s">' + '<span>' * 42
                       + 'Text' + '</span>' * 42 + '</span></p></tt>', 10)

    def test_enhanced_lrc_end_marker_and_missing_or_invalid_words(self):
        result = parse_lrc('[00:01]<00:01>First <00:02>line<00:03>', 10)
        self.assertEqual([word["end"] for word in result["lines"][0]["words"]], [2, 3])
        for value in ('[00:01]Prefix <00:02>line', '[00:01]<00:99>Invalid',
                      'Heading\n[00:01]<00:01>Word'):
            self.assertNotIn("words", parse_lrc(value, 10)["lines"][0])


class UnisonRequestTests(unittest.TestCase):
    def setUp(self):
        self.track = {'title': 'Test Song (Live)', 'artist': 'U2', 'length': 200}
        # GET /lyrics omits duration (unlike /lyrics/search). Synthetic text only.
        self.data = {'success': True, 'data': {'song': 'Test Song (Live)', 'artist': 'U2',
                     'album': 'Test album', 'confidence': 'high', 'effectiveScore': 1,
                     'format': 'lrc', 'hidden': False, 'id': 1, 'language': 'en',
                     'lyrics': '[00:01.00]Synthetic test line', 'score': 1, 'submitter': None,
                     'syncType': 'linesync', 'userVote': None, 'videoId': '', 'voteCount': 1}}

    def fetch(self, data=None, status=200, headers=None, chunks=None):
        response = Mock(status_code=status, headers=headers or {})
        response.iter_content.return_value = chunks if chunks is not None else [json.dumps(data or self.data).encode()]
        session = Mock()
        session.get.return_value.__enter__ = Mock(return_value=response)
        session.get.return_value.__exit__ = Mock(return_value=False)
        with patch('tagcast.playback_lyrics.requests.Session') as create:
            create.return_value.__enter__.return_value = session
            result = fetch_unison(self.track, 'Test album')
        self.assertFalse(session.trust_env)
        kwargs = session.get.call_args.kwargs
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['params'], {'song': 'Test Song (Live)', 'artist': 'U2',
                                           'album': 'Test album', 'duration': 200})
        self.assertEqual(set(kwargs['headers']), {'User-Agent', 'Accept'})
        session.get.assert_called_once()
        return result

    def test_exact_metadata_supported_formats_and_no_credentials(self):
        self.assertTrue(self.fetch()['timed'])
        for fmt, lyrics in (('plain', 'Synthetic plain text'),
                            ('ttml', '<tt><body><p begin="1s" end="3s">Synthetic line</p></body></tt>')):
            result = self.fetch({'success': True, 'data': {**self.data['data'], 'format': fmt, 'lyrics': lyrics}})
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(result['source'], 'unison')

    def test_partial_title_short_artist_and_present_invalid_duration_never_match(self):
        for change in ({'song': 'Test Song'}, {'artist': 'Different artist'}, {'duration': 204},
                       {'duration': None}, {'duration': True}, {'duration': float('nan')}):
            result = self.fetch({'success': True, 'data': {**self.data['data'], **change}})
            self.assertEqual(result['status'], 'missing')

    def test_real_response_shape_without_duration_accepts_the_server_duration_filter(self):
        self.assertNotIn('duration', self.data['data'])
        self.assertEqual(self.fetch()['status'], 'ready')

    def test_404_is_missing_but_failures_redirects_and_oversize_are_errors(self):
        self.assertEqual(self.fetch(status=404)['status'], 'missing')
        for status in (302, 307, 308, 403, 429, 503):
            with self.subTest(status=status), self.assertRaises(SourceError):
                self.fetch(status=status)
        for data in ({'success': False}, {'success': True, 'data': {}},
                     {'success': True, 'data': {**self.data['data'], 'format': 'unknown'}}):
            with self.assertRaises(SourceError):
                self.fetch(data)
        with self.assertRaises(SourceError):
            self.fetch(chunks=[b'x' * 512001])
        with self.assertRaises(SourceError):
            self.fetch(chunks=[b'{broken'])

    def test_timeout_and_rate_limit_are_distinct_from_a_missing_song(self):
        with patch('tagcast.playback_lyrics.requests.Session') as create:
            create.return_value.__enter__.return_value.get.side_effect = requests.Timeout()
            with self.assertRaises(SourceError):
                fetch_unison(self.track, 'Album')
        with self.assertRaises(SourceError) as raised:
            self.fetch(status=429, headers={'Retry-After': '180'})
        self.assertEqual(raised.exception.retry_after, 180)


class LRCLIBDisplayTests(unittest.TestCase):
    def setUp(self):
        self.track = {'title': 'Test Song (Live)', 'artist': 'U2', 'length': 200}
        self.record = {'id': 1, 'trackName': self.track['title'], 'artistName': 'U2',
                       'albumName': 'Test album', 'duration': 200, 'instrumental': False,
                       'syncedLyrics': '[00:01.00]Synthetic timed line',
                       'plainLyrics': 'Synthetic plain line'}
        self.current = Mock()

    def fetch(self, replies, track=None, album='Test album', current=None):
        self.session = Mock(headers={})
        contexts = []
        for reply in replies:
            if len(reply) == 2:
                status, data = reply
                headers, chunks = {'Content-Type': 'application/json'}, None
            else:
                status, data, headers, chunks = reply
            response = Mock(status_code=status, headers=headers)
            response.iter_content.return_value = chunks if chunks is not None else [json.dumps(data).encode()]
            context = Mock()
            context.__enter__ = Mock(return_value=response)
            context.__exit__ = Mock(return_value=False)
            contexts.append(context)
        self.session.get.side_effect = contexts
        with patch('tagcast.playback_lyrics.requests.Session') as create, \
                patch('tagcast.playback_lyrics.time.monotonic', return_value=100), \
                patch('tagcast.playback_lyrics.time.sleep') as sleep:
            create.return_value.__enter__.return_value = self.session
            result = fetch_lrclib_display(track or self.track, album, current or self.current)
            self.sleep = sleep
        return result

    def test_exact_request_contains_album_duration_but_no_account_or_redirects(self):
        result = self.fetch([(200, self.record)])
        self.assertEqual(result['source'], 'lrclib')
        self.assertTrue(result['timed'])
        self.assertEqual(result['lines'][0]['text'], 'Synthetic timed line')
        self.session.get.assert_called_once()
        args, kwargs = self.session.get.call_args
        self.assertEqual(args, ('https://lrclib.net/api/get',))
        self.assertEqual(kwargs['params'], {'track_name': 'Test Song (Live)', 'artist_name': 'U2',
                                           'album_name': 'Test album', 'duration': 200})
        self.assertFalse(kwargs['allow_redirects'])
        self.assertTrue(kwargs['stream'])
        self.assertFalse(self.session.trust_env)
        self.assertEqual(set(self.session.headers), {'User-Agent', 'Accept'})
        self.assertEqual(self.current.call_count, 2)

    def test_exact_request_reads_word_timing_without_extra_network_or_legacy_text(self):
        document = {"version": "1.0", "metadata": {"title": self.track["title"], "artist": "U2"},
                    "lines": [{"text": "Synthetic timing", "start_ms": 1000, "end_ms": 4000,
                               "words": [{"text": "Synthetic ", "start_ms": 1000, "end_ms": 2000},
                                         {"text": "timing", "start_ms": 2000, "end_ms": 4000}]}]}
        result = self.fetch([(200, {**self.record, "hasWordSync": True,
                                   "lyricsfile": yaml.safe_dump(document),
                                   "plainLyrics": None, "syncedLyrics": None})])
        self.assertEqual([word["start"] for word in result["lines"][0]["words"]], [1, 2])
        self.session.get.assert_called_once()

    def test_search_chooses_nearest_duration_only_with_full_title_and_artist(self):
        hits = [{**self.record, 'id': 2, 'duration': 199},
                {**self.record, 'id': 3, 'duration': 200.25, 'syncedLyrics': '[00:01]Closest line'},
                {**self.record, 'id': 4, 'duration': 200, 'trackName': 'Test Song'},
                {**self.record, 'id': 5, 'duration': 200, 'artistName': 'U2 Tribute'},
                {**self.record, 'id': 6, 'duration': 206}]
        result = self.fetch([(404, {}), (200, hits)])
        self.assertEqual(result['lines'][0]['text'], 'Closest line')
        args, kwargs = self.session.get.call_args_list[1]
        self.assertEqual(args, ('https://lrclib.net/api/search',))
        self.assertEqual(kwargs['params'], {'track_name': 'Test Song (Live)', 'artist_name': 'U2'})
        self.sleep.assert_called_once_with(.25)

    def test_typography_variants_are_bounded_and_keep_version_text(self):
        track = {'title': 'Test Song – Live', 'artist': 'O’Flynn', 'length': 200}
        record = {**self.record, 'trackName': 'Test Song - Live', 'artistName': "O'Flynn"}
        result = self.fetch([(404, {}), (200, [{**record, 'duration': 201}]),
                             (200, [{**record, 'id': 2, 'duration': 200,
                                     'syncedLyrics': '[00:01]Exact duration'}])], track)
        self.assertEqual(result['lines'][0]['text'], 'Exact duration')
        self.assertEqual(self.session.get.call_count, 3)
        query = self.session.get.call_args.kwargs['params']
        self.assertEqual(query, {'track_name': 'test song - live', 'artist_name': "o'flynn"})
        self.assertIn('live', query['track_name'])

    def test_empty_or_wrong_exact_hit_can_search_but_empty_search_is_missing(self):
        for change in ({'trackName': 'Different song'}, {'syncedLyrics': '', 'plainLyrics': ''}):
            result = self.fetch([(200, {**self.record, **change}), (200, [self.record])])
            self.assertEqual(result['status'], 'ready')
        result = self.fetch([(404, {}), (200, [])])
        self.assertEqual(result, {'status': 'missing', 'source': 'lrclib', 'timed': False, 'lines': []})

    def test_plain_text_and_instrumental_remain_distinct(self):
        result = self.fetch([(200, {**self.record, 'syncedLyrics': None})])
        self.assertFalse(result['timed'])
        self.assertEqual(result['lines'][0]['text'], 'Synthetic plain line')
        result = self.fetch([(200, {**self.record, 'instrumental': True,
                                    'plainLyrics': None, 'syncedLyrics': None})])
        self.assertEqual(result['status'], 'instrumental')
        self.assertEqual(result['lines'], [])
        self.session.get.assert_called_once()

    def test_missing_invalid_or_far_duration_never_wins_a_search(self):
        for duration in (None, True, float('nan'), float('inf'), '200', -1, 203):
            with self.subTest(duration=duration):
                result = self.fetch([(404, {}), (200, [{**self.record, 'duration': duration}])])
                self.assertEqual(result['status'], 'missing')

    def test_unknown_duration_requires_unique_album_identity(self):
        track = {**self.track, 'length': 0}
        result = self.fetch([(404, {}), (200, [self.record, {**self.record, 'id': 2}])], track)
        self.assertEqual(result['status'], 'missing')
        result = self.fetch([(200, self.record)], track)
        self.assertEqual(result['status'], 'ready')
        self.assertNotIn('duration', self.session.get.call_args.kwargs['params'])
        result = self.fetch([(404, {}), (200, [self.record])], track, album='Different album')
        self.assertEqual(result['status'], 'missing')

    def test_invalid_json_oversize_and_redirects_stop_without_search_retries(self):
        for status in (302, 307, 308, 429, 503):
            with self.subTest(status=status), self.assertRaises(SourceError):
                self.fetch([(status, {})])
            self.session.get.assert_called_once()
        for status, data, headers, chunks in [
            (200, {}, {'Content-Type': 'text/html'}, None),
            (200, None, {'Content-Type': 'application/json'}, [b'{broken']),
            (200, None, {'Content-Type': 'application/json'}, [b'null']),
            (200, None, {'Content-Type': 'application/json'}, [b'x' * 512001]),
            (200, [], {'Content-Type': 'application/json'}, None),
            (200, {}, {'Content-Type': 'application/json'}, None),
            (200, {**self.record, 'plainLyrics': 'x' * 50001}, {'Content-Type': 'application/json'}, None),
            (200, {**self.record, 'syncedLyrics': '[00:99]Bad timing'}, {'Content-Type': 'application/json'}, None),
        ]:
            with self.subTest(headers=headers, chunks=bool(chunks)), self.assertRaises(SourceError):
                self.fetch([(status, data, headers, chunks)])

    def test_retry_after_is_not_shortened_and_stale_selection_blocks_next_request(self):
        with self.assertRaises(SourceError) as raised:
            self.fetch([(429, {}, {'Retry-After': '7200'}, None)])
        self.assertEqual(raised.exception.retry_after, 7200)
        current = Mock(side_effect=[None, ConflictError('Replaced session')])
        with self.assertRaises(ConflictError):
            self.fetch([(404, {}), (200, [self.record])], current=current)
        self.session.get.assert_called_once()

    def test_timeouts_are_errors_and_duration_outside_api_range_is_not_sent(self):
        with patch('tagcast.playback_lyrics.requests.Session') as create:
            create.return_value.__enter__.return_value.get.side_effect = requests.Timeout()
            with self.assertRaises(SourceError):
                fetch_lrclib_display(self.track, 'Test album', self.current)
        self.fetch([(404, {}), (200, [])], {**self.track, 'length': 4000})
        self.assertNotIn('duration', self.session.get.call_args_list[0].kwargs['params'])


class PlaybackLyricsIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_lyrics.LyricsTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service = self.fixture.service.display
        self.body = {**self.fixture.body, 'enabled': True}
        self.result = parse_lrc('[00:01.00]Synthetic line', 200)

    def test_consent_and_fresh_account_track_identity_precede_any_network(self):
        with patch('tagcast.playback_lyrics.fetch_unison') as fetch:
            for change in ({'enabled': False}, {'enabled': 'true'}, {'session': 'old'}, {'title': 'Wrong'}):
                with self.subTest(change=change), self.assertRaises((LibraryError, ConflictError)):
                    self.service.view({**self.body, **change})
            fetch.assert_not_called()
        self.fixture.studio.client._jsonrequest.assert_not_called()

    def test_results_and_missing_responses_are_ram_only_and_never_call_ibroadcast(self):
        for result in (self.result, parse_lrc('', 200)):
            self.service.cache.clear()
            self.service.next_request = 0
            with patch('tagcast.playback_lyrics.fetch_unison', return_value=result) as fetch:
                self.assertEqual(self.service.view(self.body), result)
                self.assertEqual(self.service.view(self.body), result)
                fetch.assert_called_once()
        self.assertEqual(list(self.fixture.studio.home.iterdir()), [])
        self.fixture.studio.client._jsonrequest.assert_not_called()
        self.assertFalse(self.fixture.service.reviews)

    def test_replaced_session_discards_late_lyrics(self):
        def replace(*args):
            self.fixture.studio.playback_session = 'new-session'
            return self.result
        with patch('tagcast.playback_lyrics.fetch_unison', side_effect=replace):
            with self.assertRaises(ConflictError):
                self.service.view(self.body)
        self.assertFalse(self.service.cache)

    def test_error_backoff_and_retry_after_prevent_repeated_external_requests(self):
        error = SourceError('Unavailable')
        error.retry_after = 180
        with patch('tagcast.playback_lyrics.time.monotonic', return_value=100), \
                patch('tagcast.playback_lyrics.fetch_unison', side_effect=error) as fetch:
            for _ in range(2):
                with self.assertRaises(SourceError):
                    self.service.view(self.body)
            fetch.assert_called_once()
        self.assertEqual(self.service.next_request, 280)

    def test_library_replacement_does_not_reuse_previous_cache(self):
        with patch('tagcast.playback_lyrics.fetch_unison', return_value=self.result) as fetch:
            self.service.view(self.body)
            self.fixture.studio.library = copy.copy(self.fixture.studio.library)
            self.service.next_request = 0
            self.service.view(self.body)
            self.assertEqual(fetch.call_count, 2)

    def test_lrclib_is_only_a_consented_missing_result_fallback(self):
        missing = parse_lrc('', 200)
        public = {**self.result, 'source': 'lrclib'}
        for consent, disabled, status in ((False, False, 'missing'), (True, True, 'missing'),
                                           (True, False, 'ready')):
            self.service.cache.clear()
            self.service.next_request = 0
            self.fixture.disabled[:] = ['lrclib'] if disabled else []
            with patch('tagcast.playback_lyrics.fetch_unison', return_value=missing), \
                    patch('tagcast.playback_lyrics.fetch_lrclib_display', return_value=public) as fetch:
                result = self.service.view({**self.body, 'fallback_lrclib': consent})
                self.assertEqual(result['status'], status)
                self.assertEqual(fetch.call_count, int(consent and not disabled))
        self.fixture.studio.client._jsonrequest.assert_not_called()
        self.assertEqual(list(self.fixture.studio.home.iterdir()), [])
        self.assertFalse(self.fixture.service.reviews)

    def test_unison_result_and_service_error_never_trigger_lrclib(self):
        with patch('tagcast.playback_lyrics.fetch_lrclib_display') as fetch:
            with patch('tagcast.playback_lyrics.fetch_unison', return_value=self.result):
                self.service.view({**self.body, 'fallback_lrclib': True})
            self.service.cache.clear()
            self.service.next_request = 0
            with patch('tagcast.playback_lyrics.fetch_unison', side_effect=SourceError('Offline')):
                with self.assertRaises(SourceError):
                    self.service.view({**self.body, 'fallback_lrclib': True})
            fetch.assert_not_called()

    def test_disabled_lrclib_cannot_reuse_a_previous_online_result(self):
        body = {**self.body, 'fallback_lrclib': True}
        with patch('tagcast.playback_lyrics.fetch_unison', return_value=parse_lrc('', 200)) as unison, \
                patch('tagcast.playback_lyrics.fetch_lrclib_display',
                      return_value={**self.result, 'source': 'lrclib'}) as fetch:
            self.assertEqual(self.service.view(body)['source'], 'lrclib')
            self.assertEqual(self.service.view(body)['source'], 'lrclib')
            self.assertEqual(unison.call_count, 1)
            self.fixture.disabled.append('lrclib')
            self.service.next_request = 0
            self.assertEqual(self.service.view(body)['status'], 'missing')
            fetch.assert_called_once()

    def test_session_replacement_blocks_the_fallback_before_any_lrclib_request(self):
        def replace(*args):
            self.fixture.studio.playback_session = 'new-session'
            return parse_lrc('', 200)
        with patch('tagcast.playback_lyrics.fetch_unison', side_effect=replace), \
                patch('tagcast.playback_lyrics.requests.Session') as session:
            with self.assertRaises(ConflictError):
                self.service.view({**self.body, 'fallback_lrclib': True})
            session.return_value.__enter__.return_value.get.assert_not_called()
        self.assertFalse(self.service.cache)

    def test_invalid_fallback_consent_is_rejected_before_lookup(self):
        with patch('tagcast.playback_lyrics.fetch_unison') as fetch:
            with self.assertRaises(LibraryError):
                self.service.view({**self.body, 'fallback_lrclib': 'true'})
            fetch.assert_not_called()

    def test_disabling_source_while_fallback_finishes_rejects_the_late_result(self):
        def disable(*args):
            self.fixture.disabled.append('lrclib')
            return {**self.result, 'source': 'lrclib'}
        with patch('tagcast.playback_lyrics.fetch_unison', return_value=parse_lrc('', 200)), \
                patch('tagcast.playback_lyrics.fetch_lrclib_display', side_effect=disable):
            with self.assertRaises(ConflictError):
                self.service.view({**self.body, 'fallback_lrclib': True})
        self.assertFalse(self.service.cache)
