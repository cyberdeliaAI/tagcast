"""ListenBrainz discovery integrates with saved preferences and local genre fallback."""

import json
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

import requests
from test_discover import discovery_data

from tagcast.client import Studio
from tagcast.discover_listenbrainz import RADIO
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.sources import MusicBrainz

SEED = "fe0175bf-5a71-43e2-bb3c-2c2b569d3311"
RELATED = "fe0175bf-5a71-43e2-bb3c-2c2b569d3312"


def response(data, status=200):
    reply = MagicMock()
    reply.__enter__.return_value = reply
    reply.status_code = status
    reply.headers = {"Cache-Control": "max-age=60"}
    reply.iter_content.return_value = iter([json.dumps(data).encode()])
    return reply


class ListenBrainzDiscoveryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.studio = Studio(tmp.name)
        self.studio.client = Mock()
        self.studio.library = Library(discovery_data())
        self.studio.library_user = "private-account"
        self.studio.playback_session = "private-session"
        self.session = MagicMock()
        self.session.__enter__.return_value = self.session
        session_factory = patch("tagcast.discover_listenbrainz.requests.Session",
                                return_value=self.session)
        session_factory.start()
        self.addCleanup(session_factory.stop)

    def view(self, **changes):
        return self.studio.discover.view({
            "name": "Seed", "artists": ["1"], "session": "private-session", **changes,
        })

    def test_default_is_read_only_and_saved_source_takes_precedence(self):
        self.assertEqual(self.studio.settings()["discover_source"], "listenbrainz")
        self.session.get.assert_not_called()
        self.studio.config["discover_lastfm"] = True
        self.assertEqual(self.studio.settings()["discover_source"], "lastfm")
        self.assertEqual(self.studio.save_settings({"discover_source": "local"})[
            "discover_source"], "local")
        self.session.get.assert_not_called()

    def test_saved_selection_only_sends_the_public_name_and_public_artist_id(self):
        self.studio.config["discover_lastfm"] = False
        self.assertEqual(self.studio.settings()["discover_source"], "local")
        with self.assertRaises(LibraryError):
            self.view(source="listenbrainz")
        self.assertEqual(self.studio.save_settings({"discover_source": "listenbrainz"})[
            "discover_source"], "listenbrainz")
        self.session.get.assert_not_called()
        self.session.get.side_effect = [
            response({"count": 1, "artists": [{"id": SEED, "name": "Seed"}]}),
            response({RELATED: [{"similar_artist_mbid": RELATED, "similar_artist_name": "Artist 4"}]}),
        ]
        result = self.view()
        self.assertEqual(result["source"], "listenbrainz")
        self.assertEqual(result["albums"], [{
            "id": "4", "shared_genres": [], "playable": True,
            "related_artist": "Artist 4", "related_artist_mbid": RELATED,
        }])
        search, radio = self.session.get.call_args_list
        self.assertEqual(search.args, (f"{MusicBrainz.API}/artist",))
        self.assertEqual(search.kwargs["params"]["query"], 'artist:"Seed"')
        self.assertEqual(radio.args, (RADIO + SEED,))
        self.assertFalse(self.session.trust_env)
        for call in (search, radio):
            self.assertFalse(call.kwargs["allow_redirects"])
            self.assertTrue(call.kwargs["stream"])
            self.assertNotIn("private-", repr(call))
        self.assertEqual(self.view()["albums"], result["albums"])
        self.assertEqual(self.session.get.call_count, 2)
        self.studio.client._jsonrequest.assert_not_called()

    def test_ambiguous_seed_fails_locally_and_does_not_query_radio(self):
        self.studio.save_settings({"discover_source": "listenbrainz"})
        self.session.get.return_value = response({"count": 2, "artists": [
            {"id": SEED, "name": "Seed"}, {"id": RELATED, "name": "seed"},
        ]})
        result = self.view()
        self.assertTrue(result["fallback"])
        self.assertEqual(result["source"], "local")
        self.assertEqual([album["id"] for album in result["albums"]], ["2", "3"])
        self.session.get.assert_called_once()

    def test_disabled_musicbrainz_and_provider_errors_fall_back_without_retries(self):
        self.studio.save_settings({"discover_source": "listenbrainz", "disabled_sources": ["musicbrainz"]})
        self.assertTrue(self.view()["fallback"])
        self.session.get.assert_not_called()
        self.studio.save_settings({"disabled_sources": []})
        self.session.get.side_effect = requests.Timeout()
        self.assertTrue(self.view()["fallback"])
        self.session.get.assert_called_once()

    def test_preference_change_between_providers_rejects_the_result(self):
        self.studio.save_settings({"discover_source": "listenbrainz"})

        def replace(*_, **__):
            self.studio.save_settings({"discover_source": "local"})
            return response({"count": 1, "artists": [{"id": SEED, "name": "Seed"}]})

        self.session.get.side_effect = replace
        with self.assertRaises(ConflictError):
            self.view()
        self.session.get.assert_called_once()
