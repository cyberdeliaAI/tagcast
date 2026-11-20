"""Last.fm discovery uses bounded explicit public reads, never account data or writes."""

import json
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import MagicMock, Mock, patch

import requests
from test_discover import discovery_data

from tagcast.client import Studio
from tagcast.discover_lastfm import (
    CACHE_BYTES,
    CACHE_ENTRIES,
    MAX_BODY,
    LastfmSimilar,
    cache_lifetime,
)
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.sources import LastFm, SourceError


def payload(names=None, seed="Seed"):
    return {
        "similarartists": {
            "@attr": {"artist": seed},
            "artist": [
                {
                    "name": name,
                    "match": score,
                    "url": "https://untrusted.example/ignored",
                    "image": [],
                }
                for name, score in (names or [])
            ],
        }
    }


class OnlineDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.studio = Studio(self.tmp.name)
        self.studio.client = Mock()
        self.studio.library_user = "account-a"
        self.studio.playback_session = "session-a"
        self.studio.config["lastfm_api_key"] = "private-fixture-key"
        self.studio.config["discover_lastfm"] = True
        self.data = discovery_data()
        self.studio.library = Library(self.data)

    def view(self, **changes):
        return self.studio.discover.view(
            {
                "artists": ["1"],
                "name": "Seed",
                "session": "session-a",
                **changes,
            }
        )

    def test_provider_similarity_chooses_artists_even_without_shared_genres(self):
        with patch.object(
            self.studio.discover.lastfm,
            "read",
            return_value=((("Artist 4", 0.9), ("Artist 2", 0.8)), 60),
        ) as read:
            result = self.view()
        self.assertEqual([a["id"] for a in result["albums"]], ["4", "6"])
        self.assertEqual(result["source"], "lastfm")
        self.assertFalse(result["fallback"])
        self.assertEqual(result["expires_in"], 60)
        self.assertEqual(result["albums"][0]["shared_genres"], [])
        self.assertEqual(result["albums"][0]["related_artist"], "Artist 4")
        self.assertEqual(result["albums"][0]["lastfm_url"], "https://www.last.fm/music/Artist%204")
        self.assertEqual(read.call_args.args[:2], ("Seed", "private-fixture-key"))
        self.studio.client._jsonrequest.assert_not_called()
        self.assertNotIn("private-fixture-key", json.dumps(result))

    def test_healthy_no_results_or_no_local_matches_fall_back_to_current_genres(self):
        for related in ((), (("Not owned", 0.9),)):
            with (
                self.subTest(related=related),
                patch.object(self.studio.discover.lastfm, "read", return_value=(related, 30)),
            ):
                result = self.view()
            self.assertEqual(result["requested_source"], "lastfm")
            self.assertEqual(result["source"], "local")
            self.assertTrue(result["fallback"])
            self.assertEqual([a["id"] for a in result["albums"]], ["2", "3"])
        self.data["library"]["tracks"]["1"][1:3] = ["", []]
        self.studio.library = Library(self.data)
        with patch.object(self.studio.discover.lastfm, "read", return_value=((), 30)):
            result = self.view()
        self.assertEqual(result["status"], "missing_genres")
        self.assertTrue(result["fallback"])

    def test_strict_matching_rejects_ambiguous_and_partial_names_and_seed(self):
        self.data["library"]["artists"]["3"][0] = " artist 2 "
        self.studio.library = Library(self.data)
        related = (("Seed", 1), ("Artist", 0.95), ("Artist 2", 0.9), ("Artist 4", 0.8))
        with patch.object(self.studio.discover.lastfm, "read", return_value=(related, 30)):
            self.assertEqual([a["id"] for a in self.view()["albums"]], ["4"])

    def test_missing_key_disabled_or_invalid_source_never_contacts_provider(self):
        for changes, config, code in [
            ({}, {}, "discover.lastfm_missing_key"),
            (
                {},
                {"lastfm_api_key": "k", "disabled_sources": ["lastfm"]},
                "discover.lastfm_disabled",
            ),
            ({"source": "unknown"}, {}, "discover.invalid_source"),
        ]:
            self.studio.config = {"discover_lastfm": True, **config}
            with self.subTest(code=code), patch.object(self.studio.discover.lastfm, "read") as read:
                with self.assertRaises(LibraryError) as error:
                    self.view(**changes)
                self.assertEqual(error.exception.code, code)
                read.assert_not_called()

    def test_errors_never_become_healthy_empty_fallbacks(self):
        with patch.object(
            self.studio.discover.lastfm, "read", side_effect=SourceError("Unavailable")
        ):
            with self.assertRaises(SourceError):
                self.view()

    def test_disabled_discovery_uses_local_genres_without_provider_even_with_a_key(self):
        self.studio.config["discover_lastfm"] = False
        with patch.object(self.studio.discover.lastfm, "read") as read:
            result = self.view()
            self.assertEqual(result["source"], "local")
            self.assertEqual(result["requested_source"], "local")
            self.assertFalse(result["fallback"])
            self.assertEqual([a["id"] for a in result["albums"]], ["2", "3"])
            with self.assertRaises(LibraryError) as error:
                self.view(source="lastfm")
            self.assertEqual(error.exception.code, "discover.lastfm_discovery_disabled")
            read.assert_not_called()

    def test_account_library_source_key_or_generation_change_rejects_late_answers(self):
        for kind in ("account", "library", "key", "disabled", "preference", "generation"):
            self.setUp()

            def changed(*args):
                self.assertFalse(self.studio.lock._is_owned())
                if kind == "account":
                    self.studio.library_user = "other"
                elif kind == "library":
                    self.studio.library = Library(deepcopy(self.data))
                elif kind == "key":
                    self.studio.config["lastfm_api_key"] = "other"
                elif kind == "disabled":
                    self.studio.config["disabled_sources"] = ["lastfm"]
                elif kind == "preference":
                    self.studio.save_settings({"discover_lastfm": False})
                else:
                    self.studio.discover.generation += 1
                return (("Artist 4", 0.9),), 60

            with (
                self.subTest(kind=kind),
                patch.object(self.studio.discover.lastfm, "read", side_effect=changed),
            ):
                with self.assertRaises(ConflictError):
                    self.view()

    def test_saving_source_changes_invalidates_inflight_generation_but_language_does_not(self):
        generation = self.studio.discover.generation
        self.studio.save_settings({"lastfm_api_key": "new-key"})
        self.assertEqual(self.studio.discover.generation, generation + 1)
        self.studio.save_settings({"disabled_sources": ["lastfm"]})
        self.assertEqual(self.studio.discover.generation, generation + 2)
        self.studio.save_interface_language({"language": "nl"})
        self.assertEqual(self.studio.discover.generation, generation + 2)
        self.studio.save_settings({"discover_lastfm": False})
        self.assertEqual(self.studio.discover.generation, generation + 3)
        self.studio.save_settings({"discover_lastfm": False})
        self.assertEqual(self.studio.discover.generation, generation + 3)
        self.studio.save_settings({"discover_lastfm": True})
        self.assertEqual(self.studio.discover.generation, generation + 4)

    def test_preference_change_during_local_ranking_rejects_the_old_result(self):
        self.studio.config["discover_lastfm"] = False
        self.view()
        index = self.studio.library._discover_index
        original = index.recommendations

        def changed(name):
            self.studio.save_settings({"discover_lastfm": True})
            return original(name)

        with patch.object(index, "recommendations", side_effect=changed), self.assertRaises(ConflictError):
            self.view()


class LastfmTransportTests(unittest.TestCase):
    def setUp(self):
        self.http = Mock()
        self.provider = LastfmSimilar(self.http)
        self.session = MagicMock()
        self.session.__enter__.return_value = self.session
        self.response = MagicMock()
        self.response.__enter__.return_value = self.response
        self.response.status_code = 200
        self.response.headers = {"Cache-Control": "max-age=60"}
        self.session.get.return_value = self.response
        self.factory = patch(
            "tagcast.discover_lastfm.requests.Session", return_value=self.session
        ).start()
        self.addCleanup(patch.stopall)
        self.valid = Mock()
        self.body = payload([("Artist 4", 0.9), ("Artist 2", 0.8)])
        self.response.iter_content.side_effect = lambda size: iter([json.dumps(self.body).encode()])

    def read(self, artist="Seed", key="secret-key", context="account-session"):
        return self.provider.read(artist, key, context, self.valid)

    def test_one_fixed_https_request_without_redirects_login_cookies_or_audio(self):
        artists, ttl = self.read()
        self.assertEqual(artists, (("Artist 4", 0.9), ("Artist 2", 0.8)))
        self.assertEqual(ttl, 60)
        args, kwargs = self.session.get.call_args
        self.assertEqual(args, (LastFm.API,))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["timeout"], (4, 8))
        self.assertEqual(
            set(kwargs["params"]), {"method", "artist", "autocorrect", "limit", "api_key", "format"}
        )
        self.assertEqual(kwargs["params"]["autocorrect"], 0)
        self.assertEqual(kwargs["params"]["method"], "artist.getSimilar")
        self.http._wait.assert_called_once_with("ws.audioscrobbler.com")

    def test_fresh_cache_coalesces_and_no_store_does_not_survive_next_read(self):
        self.read()
        self.read()
        self.assertEqual(self.session.get.call_count, 1)
        self.response.headers = {"Cache-Control": "no-store"}
        with patch("tagcast.discover_lastfm.time.sleep"):
            self.read(context="other")
            self.read(context="other")
        self.assertEqual(self.session.get.call_count, 3)
        self.assertEqual(len(self.provider.cache), 1)

    def test_disabled_or_replaced_context_is_checked_even_for_cached_results(self):
        self.read()
        self.valid.side_effect = ConflictError("Changed")
        with self.assertRaises(ConflictError):
            self.read()
        self.assertEqual(self.session.get.call_count, 1)

    def test_errors_redirects_malformed_or_oversized_responses_are_not_cached(self):
        scenarios = [
            ("http", 302),
            ("http", 500),
            ("http", 401),
            ("http", 403),
            ("data", {"error": 10}),
            ("data", {"error": 26}),
            ("data", {"error": 29}),
            ("data", {"error": 6}),
            ("data", {"error": 11}),
            ("data", []),
            ("data", payload(seed="Different")),
            ("data", {"similarartists": []}),
            ("data", {"similarartists": {"@attr": {"artist": "Seed"}, "artist": [False]}}),
            ("raw", b"x"),
            ("raw", b"x" * (MAX_BODY + 1)),
        ]
        for kind, value in scenarios:
            self.provider.cache.clear()
            self.provider.retry_at = 0
            self.provider.next_request = 0
            self.response.status_code = value if kind == "http" else 200
            self.body = value if kind == "data" else payload()
            self.response.iter_content.side_effect = lambda size: iter(
                [value if kind == "raw" else json.dumps(self.body).encode()]
            )
            with self.subTest(kind=kind, value=str(value)[:30]), self.assertRaises(SourceError):
                self.read()
            self.assertFalse(self.provider.cache)

    def test_busy_backoff_and_network_failure_are_explicit_without_retries(self):
        self.response.status_code = 429
        self.response.headers = {"Retry-After": "120"}
        with self.assertRaises(SourceError):
            self.read()
        with self.assertRaises(SourceError):
            self.read()
        self.assertEqual(self.session.get.call_count, 1)
        self.provider.retry_at = 0
        self.provider.next_request = 0
        self.session.get.side_effect = requests.Timeout("secret-key must never appear in errors")
        with self.assertRaises(SourceError) as error:
            self.read()
        self.assertNotIn("secret-key", str(error.exception))
        self.assertEqual(self.session.get.call_count, 2)

    def test_late_replacement_during_body_read_is_never_published(self):
        def replaced(size):
            self.valid.side_effect = ConflictError("Changed")
            yield json.dumps(self.body).encode()

        self.response.iter_content.side_effect = replaced
        with self.assertRaises(ConflictError):
            self.read()
        self.assertFalse(self.provider.cache)

    def test_cache_stays_bounded_and_separates_keys_accounts_and_artist_identity(self):
        with patch("tagcast.discover_lastfm.time.sleep"):
            for i in range(70):
                self.read(context=str(i))
        self.assertLessEqual(len(self.provider.cache), CACHE_ENTRIES)
        self.assertLessEqual(self.provider.size, CACHE_BYTES)
        self.assertNotIn("secret-key", repr(list(self.provider.cache)))
        self.assertGreater(self.session.get.call_count, CACHE_ENTRIES)

    def test_invalid_scores_and_duplicate_seed_artists_are_never_recommended(self):
        self.body = payload(
            [
                ("Artist 4", "NaN"),
                ("Artist 3", -1),
                ("Seed", 1),
                ("Artist 2", 0.8),
                ("ARTIST 2", 0.7),
            ]
        )
        artists, _ = self.read()
        self.assertEqual(artists, (("Artist 2", 0.8),))

    def test_cache_headers_bound_expiry_and_disable_storage(self):
        for value in ("no-store", "no-cache", "private", "max-age=0"):
            self.assertEqual(cache_lifetime({"Cache-Control": value}), 0)
        self.assertEqual(cache_lifetime({"Cache-Control": "max-age=60", "Age": "10"}), 50)
        self.assertEqual(cache_lifetime({"Cache-Control": "max-age=999999999"}), 21600)
        self.assertEqual(cache_lifetime({"Expires": "bad date"}), 0)
