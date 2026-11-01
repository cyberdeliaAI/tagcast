"""Synthetic display fixtures only: no public lyrics, real account or audio requests."""

import copy
import json
import unittest
from unittest.mock import Mock, patch

import requests
import test_lyrics

from tagcast.library import ConflictError, LibraryError
from tagcast.playback_lyrics import fetch_unison, lyric_time, parse_lrc, parse_ttml
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

    def test_ttml_apple_absolute_song_times_and_plain_text(self):
        value = ('<tt xmlns="http://www.w3.org/ns/ttml" '
                 'xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" itunes:timing="Word">'
                 '<body><div begin="10s"><p begin="10s" end="12s">'
                 '<span begin="10s" end="11s">First </span><span begin="11s">line &amp; more</span>'
                 '</p><p begin="15s" end="18s">Next line</p></div></body></tt>')
        result = parse_ttml(value, 20)
        self.assertEqual(result["lines"][0], {"start": 10, "end": 12, "text": "First line & more"})
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


class UnisonRequestTests(unittest.TestCase):
    def setUp(self):
        self.track = {'title': 'Test Song (Live)', 'artist': 'U2', 'length': 200}
        self.data = {'success': True, 'data': {'song': 'Test Song (Live)', 'artist': 'U2',
                     'duration': 200, 'format': 'lrc', 'lyrics': '[00:01.00]Synthetic test line'}}

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

    def test_partial_title_short_artist_and_wrong_or_missing_duration_never_match(self):
        for change in ({'song': 'Test Song'}, {'artist': 'Different artist'}, {'duration': 204},
                       {'duration': None}, {'duration': True}, {'duration': float('nan')}):
            result = self.fetch({'success': True, 'data': {**self.data['data'], **change}})
            self.assertEqual(result['status'], 'missing')

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
