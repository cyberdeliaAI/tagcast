"""Metadata sources, tested with canned responses (no network)."""

import unittest

from ibroadcast_editor import sources
from ibroadcast_editor.sources import (
    Lookup,
    SourceError,
    album_score,
    normalize,
    search_title,
    tidy_genre,
)


class FakeHttp:
    def __init__(self, responses):
        self.responses, self.calls = responses, []

    def json(self, url, params=None, headers=None, ttl=3600):
        self.calls.append((url, params or {}, headers or {}))
        for fragment, data in self.responses:
            if fragment in url:
                return data
        return None


def lookup(responses, keys=None):
    result = Lookup(lambda: keys or {})
    result.http = FakeHttp(responses)
    return result


class MatchingTests(unittest.TestCase):
    def test_editions_accents_and_articles_do_not_matter(self):
        self.assertEqual(normalize("The Dark Side of the Moon (2011 Remaster)"), "dark side of the moon")
        self.assertEqual(normalize("Björk"), normalize("Bjork"))
        self.assertEqual(album_score("Simon & Garfunkel", "Bookends", "Simon and Garfunkel", "Bookends"), 1.0)

    def test_search_title_drops_edition_suffixes(self):
        self.assertEqual(search_title("Abbey Road - Remastered 2009"), "Abbey Road")
        self.assertEqual(search_title("Live at Leeds"), "Live at Leeds")
        self.assertEqual(search_title("(What's the Story) Morning Glory?"), "(What's the Story) Morning Glory?")

    def test_genres_are_tidied(self):
        self.assertEqual(tidy_genre("trip-hop"), "Trip-Hop")
        self.assertEqual(tidy_genre("80s"), "80s")
        self.assertEqual(tidy_genre("R&B"), "R&B")


class SourceTests(unittest.TestCase):
    def test_deezer_album_uses_details_for_year_and_genres(self):
        lk = lookup([
            ("search/album", {"data": [{"id": 5, "title": "Mezzanine", "artist": {"name": "Massive Attack"},
                                        "cover_xl": "https://x/1000.jpg", "cover_medium": "https://x/250.jpg",
                                        "link": "https://deezer/5"},
                                       {"id": 6, "title": "Something Else", "artist": {"name": "Nobody"}}]}),
            ("album/5", {"release_date": "1998-04-20", "genres": {"data": [{"name": "Electro"}]}}),
        ])
        [hit] = lk.album("deezer", "Massive Attack", "Mezzanine (Deluxe)")
        self.assertEqual((hit["year"], hit["genres"], hit["cover"]), (1998, ["Electro"], "https://x/1000.jpg"))
        self.assertIn('album:"Mezzanine"', lk.http.calls[0][1]["q"])  # searched without the edition

    def test_musicbrainz_prefers_albums_and_reads_genres(self):
        lk = lookup([
            ("release-group/rg-album", {"genres": [{"name": "art pop", "count": 5}, {"name": "rock", "count": 9}]}),
            ("release-group/rg-single", {"genres": []}),
            ("release-group", {"release-groups": [
                {"id": "rg-single", "title": "Hounds of Love", "primary-type": "Single",
                 "first-release-date": "1986-02", "artist-credit": [{"name": "Kate Bush"}]},
                {"id": "rg-album", "title": "Hounds of Love", "primary-type": "Album",
                 "first-release-date": "1985-09-16", "artist-credit": [{"name": "Kate Bush"}]}]}),
        ])
        hits = lk.album("musicbrainz", "Kate Bush", "Hounds of Love")
        self.assertEqual(hits[0]["kind"], "Album")
        self.assertEqual((hits[0]["year"], hits[0]["genres"]), (1985, ["Rock", "Art Pop"]))
        self.assertTrue(hits[0]["cover"].startswith("https://coverartarchive.org/release-group/rg-album/"))

    def test_keyed_sources_need_a_key_and_send_it(self):
        with self.assertRaises(SourceError):
            lookup([]).album("discogs", "A", "B")
        lk = lookup([("database/search", {"results": [
            {"type": "master", "title": "Kate Bush - The Dreaming", "year": "1982",
             "genre": ["Rock"], "style": ["Art Rock"], "cover_image": "https://i/c.jpg",
             "uri": "/master/1"}]})], keys={"discogs_token": "tok"})
        [hit] = lk.album("discogs", "Kate Bush", "The Dreaming")
        self.assertEqual(hit["genres"], ["Art Rock", "Rock"])
        self.assertEqual(lk.http.calls[0][2]["Authorization"], "Discogs token=tok")

    def test_lastfm_placeholder_images_are_dropped(self):
        lk = lookup([("audioscrobbler", {"album": {
            "name": "Blue Lines", "artist": "Massive Attack", "url": "https://last.fm/x",
            "image": [{"size": "extralarge",
                       "#text": f"https://lastfm/i/u/300x300/{sources.LASTFM_PLACEHOLDER}.png"}],
            "tags": {"tag": [{"name": "trip-hop"}]}}})], keys={"lastfm_api_key": "k"})
        [hit] = lk.album("lastfm", "Massive Attack", "Blue Lines")
        self.assertEqual((hit["cover"], hit["genres"]), ("", ["Trip-Hop"]))

    def test_deezer_artists_without_a_picture_are_skipped(self):
        lk = lookup([("search/artist", {"data": [
            {"name": "Massive Attack", "picture_xl": "https://dz/images/artist//1000x1000.jpg"},
            {"name": "Massive Attack", "picture_xl": "https://dz/images/artist/abc/1000x1000.jpg"}]})])
        hits = lk.artist("deezer", "Massive Attack")
        self.assertEqual([h["image"] for h in hits], ["https://dz/images/artist/abc/1000x1000.jpg"])

    def test_poor_matches_are_left_out(self):
        lk = lookup([("itunes", {"results": [{"collectionName": "Greatest Hits", "artistName": "Other"}]})])
        self.assertEqual(lk.album("itunes", "Kate Bush", "The Dreaming"), [])


if __name__ == "__main__":
    unittest.main()
