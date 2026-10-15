"""Offline note capture must keep uncertain identities and user reviews out."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from import_album_notes import AlbumSummary, SourceIndex, compare, source_url  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class AlbumNoteTests(unittest.TestCase):
    def test_summary_excludes_reviews_and_requires_a_wikipedia_source(self):
        parser = AlbumSummary()
        parser.feed('<section><h3>Album Summary</h3><p class="card-text">A quiet album. ' +
                    'A voice &amp; orchestra.</p><a class="wiki-link" ' +
                    'href="https://en.wikipedia.org/wiki/An_Album">Read more</a></section>' +
                    '<section><h3>Reviews</h3><p class="card-text">Private opinion: do not copy.</p></section>')
        note = parser.note()
        self.assertEqual(note["text"], "A quiet album. A voice & orchestra.")
        self.assertNotIn("opinion", note["text"])
        self.assertEqual(note["attribution"], "Wikipedia contributors")
        self.assertEqual(note["license_url"], "https://creativecommons.org/licenses/by-sa/4.0/")
        missing = AlbumSummary()
        missing.feed('<section><h3>Album Summary</h3><p class="card-text">An unknown text.</p></section>')
        with self.assertRaisesRegex(ValueError, "no explicit Wikipedia"):
            missing.note()

    def test_excerpts_are_bounded_and_sentence_spacing_is_repaired(self):
        parser = AlbumSummary()
        parser.feed('<section><h3>Album Summary</h3><p class="card-text">One album.Another sentence. '
                    + 'word ' * 300 + '</p><a class="wiki-link" '
                    'href="https://en.wikipedia.org/wiki/Album">Read more</a></section>')
        note = parser.note()
        self.assertIn("album. Another", note["text"])
        self.assertLessEqual(len(note["text"].split()), 200)
        self.assertTrue(note["excerpt"])

    def test_only_unique_normalized_pairs_are_automatic(self):
        reference = [{"id": 1, "album": "One", "artist": "The Band", "year": 1970},
                     {"id": 2, "album": "Two", "artist": "Other", "year": 1980}]
        source = [{"album": "ONE!", "artist": "Band", "year": 1971,
                   "url": "https://1001albumsgenerator.com/albums/a/one"},
                  {"album": "Two", "artist": "Other Ensemble", "year": 1980,
                   "url": "https://1001albumsgenerator.com/albums/b/two"}]
        rows = compare(reference, source, {})
        self.assertEqual(rows[0]["status"], "matched")
        self.assertEqual(rows[1]["status"], "possible")
        self.assertIsNone(rows[1]["source"])
        rows = compare(reference, source + [{**source[0], "url": source[0]["url"] + "-edition"}], {})
        self.assertEqual(rows[0]["status"], "possible")
        rows = compare(reference, source, {"2": source[1]["url"]})
        self.assertEqual(rows[1]["status"], "manual")
        self.assertEqual([r["id"] for r in rows], [1, 2])
        with self.assertRaisesRegex(ValueError, "not in the source index"):
            compare(reference, source, {"2": "https://1001albumsgenerator.com/albums/c/wrong"})
        with self.assertRaises(ValueError):
            source_url("https://example.com/albums/b/two")
        reviewed = {"url": "https://1001albumsgenerator.com/albums/c/two-live",
                    "source": {"album": "Two live", "artist": "Other", "year": 1980},
                    "reason": "Individually reviewed public page absent from this index",
                    "context": "This source describes one part of the reference."}
        chosen = compare(reference, source, {"2": reviewed})[1]
        self.assertEqual(chosen["status"], "manual")
        self.assertEqual(chosen["context"], reviewed["context"])
        self.assertEqual(chosen["source"]["url"], reviewed["url"])
        with self.assertRaises(ValueError):
            compare(reference, source, {"2": {**reviewed, "url": "https://example.com/wrong"}})
        repair = {"text": "An album-specific background.", "source_url": "https://en.wikipedia.org/wiki/Two",
                  "reason": "The source summary describes only the artist."}
        chosen = compare(reference, source, {"2": {**reviewed, "note": repair}})[1]
        self.assertEqual(chosen["note"], repair)
        with self.assertRaises(ValueError):
            compare(reference, source, {"2": {**reviewed, "note": {**repair,
                    "source_url": "https://example.com/unlicensed"}}})

    def test_index_preserves_fields_and_bundled_notes_match_stable_reference_ids(self):
        parser = SourceIndex()
        parser.feed('<table><tr data-album="A &amp; B" data-artist="The Band" data-year="1970">'
                    '<td><a href="/albums/a/a-and-b">Album</a></td></tr></table>')
        self.assertEqual(parser.rows[0]["album"], "A & B")
        self.assertEqual(parser.rows[0]["year"], 1970)
        static = ROOT / "src/tagcast/static"
        reference = json.loads((static / "1001-albums.json").read_text(encoding="utf-8"))
        notes = json.loads((static / "1001-album-notes.json").read_text(encoding="utf-8"))
        self.assertEqual(notes["selection_sha256"], reference["source_sha256"])
        entries = {e["id"]: e for e in reference["entries"]}
        self.assertEqual(len({n["id"] for n in notes["entries"]}), len(notes["entries"]))
        self.assertEqual(len(notes["entries"]), len(entries))
        self.assertEqual({n["id"] for n in notes["entries"]}, set(entries))
        for note in notes["entries"]:
            with self.subTest(id=note["id"]):
                expected = entries[note["id"]]
                self.assertEqual((note["album"], note["artist"]), (expected["album"], expected["artist"]))
                self.assertLessEqual(len(note["text"].split()), 200)
                self.assertTrue(note["source_url"].startswith("https://en.wikipedia.org/wiki/"))
                self.assertEqual(note["license_url"], "https://creativecommons.org/licenses/by-sa/4.0/")
                self.assertEqual(source_url(note["captured_from"]), note["captured_from"])
