"""Lossless supported metadata, private streaming files and snapshot/session isolation."""

import csv
import io
import json
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import Mock, patch

from tagcast import app
from tagcast.client import Studio
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.metadata_export import COLUMNS, Snapshot, csv_cell, write_export


def fixture():
    return {"status": {"lastmodified": "revision-one"}, "combine_sets": False,
            "settings": {"token": "NEVER-EXPORT"}, "library": {
        "artists": {"map": {}, "4": {"name": "Björk", "rating": 4, "artwork_id": 88},
                    "5": {"name": "Guest; Whole Name", "trashed": True},
                    "6": {"name": "Composer", "rating": 0}},
        "albums": {"map": {}, "10": {"name": "Début, \"Live\"\nDisc", "artist_id": 4,
                    "artists_additional": [[5, "with", "band"]], "year": 1993, "disc": 1,
                    "rating": 5, "tracks": [101, 100, 103]},
                   "11": {"name": "Second disc", "artist_id": 0, "disc": 2, "tracks": [104]},
                   "12": {"name": "Trash", "artist_id": 4, "trashed": True, "tracks": [105]}},
        "tracks": {"map": {}, "100": {"title": "=1+1", "album_id": 10, "artist_id": 4,
                    "genre": "Pop;Rock", "genres_additional": ["Jazz / Blues", "Pop;Rock", "café"],
                    "year": "1993", "track": 2, "length": 240, "type": "audio/flac", "rating": 1,
                    "uploaded_on": "2026-10-15", "uploaded_time": "09:45:47", "artwork_id": 77,
                    "artists_additional": [[5, None, None], [6, "", "composer"],
                                            [5, "featuring é\nquote \"x\"", "future-role"]],
                    "file": "NEVER-EXPORT", "token": "NEVER-EXPORT"},
                   "101": {"title": "Other", "album_id": 10, "artist_id": 4, "track": 1,
                           "genre": "", "genres_additional": ["Only additional"]},
                   "103": {"title": "Trash", "album_id": 10, "artist_id": 4, "trashed": True},
                   "104": {"title": "Various", "album_id": 999, "artist_id": 0, "track": 10},
                   "105": {"title": "In trashed album", "album_id": 12, "artist_id": 4},
                   "106": {"title": "Unlisted", "album_id": 10, "artist_id": 4}},
        "tags": {"90": {"name": "Archived", "archived": True, "tracks": [100, 103]},
                 "91": {"name": "Empty", "tracks": []}},
        "playlists": {"map": {}, "50": {"name": "List", "description": "first\nsecond",
                      "tracks": [100, 100, 103, 999], "share_key": "NEVER-EXPORT"}},
        "expires": "NEVER-EXPORT"}}


class ExportTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.studio = Studio(self.temp.name)
        self.studio.client = Mock()
        self.studio.library = Library(fixture())
        self.studio.library_user = "account-one"
        self.studio.playback_session = "test-session"
        self.export = self.studio.metadata_export
        self.addCleanup(self.export.close)
        for name in ("_current", "_remote_state", "_write", "load_library", "album_details"):
            setattr(self.studio, name, Mock(side_effect=AssertionError("Export must not fetch or write")))

    def start(self, kind="json", **options):
        return self.export.start({"format": kind, "session": "test-session", **options})

    def ready(self, job):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.export.status(job["id"], "test-session")
            if status["state"] != "preparing":
                self.assertEqual(status["state"], "ready", status)
                return status
            time.sleep(0.005)
        self.fail("Export did not finish")

    def contents(self, job):
        self.ready(job)
        with self.export.download(job["id"], "test-session") as opened:
            return opened["file"].read()


class MetadataExportTests(ExportTestCase):
    def test_json_preserves_native_relationships_values_and_active_membership(self):
        library = self.studio.library
        with patch.object(library, "track_view", side_effect=AssertionError("No track views")), \
                patch.object(library, "album_view", side_effect=AssertionError("No album views")):
            data = json.loads(self.contents(self.start()))
        self.assertEqual(data["manifest"]["counts"], {key: len(data[key]) for key in COLUMNS})
        self.assertEqual(data["manifest"]["library_revision"], "revision-one")
        self.assertFalse(data["manifest"]["combine_sets"])
        self.assertEqual([a["album_id"] for a in data["albums"]], ["10", "11"])
        self.assertEqual([t["track_id"] for t in data["tracks"]], ["100", "101", "104"])
        self.assertEqual([t["track_id"] for t in data["album_tracks"]], ["101", "100", "104"])
        self.assertEqual(data["tracks"][2]["album_id"], "11")
        self.assertEqual(data["tracks"][2]["source_album_id"], "999")
        track = data["tracks"][0]
        self.assertEqual(track["title"], "=1+1")
        self.assertEqual(track["rating"], 1)
        self.assertEqual(track["format"], "FLAC")
        self.assertEqual(track["uploaded_at"], "2026-10-15T09:45:47")
        self.assertEqual(track["year"], "1993")
        self.assertEqual(data["tracks"][1]["genre"], "")
        self.assertEqual([g["label"] for g in data["genres"]],
                         ["Pop;Rock", "Jazz / Blues", "Pop;Rock", "café", "Only additional"])
        self.assertEqual(data["genres"][-1]["position"], 1)
        album = [c for c in data["credits"] if c["entity_type"] == "album" and c["entity_id"] == "10"]
        self.assertEqual([(c["artist_id"], c["primary"], c["role"], c["phrase"]) for c in album],
                         [("4", True, None, None), ("5", False, "band", "with")])
        credits = [c for c in data["credits"] if c["entity_type"] == "track" and c["entity_id"] == "100"]
        self.assertEqual([(c["artist_id"], c["role"], c["phrase"]) for c in credits],
                         [("4", None, None), ("5", None, None), ("6", "composer", ""),
                          ("5", "future-role", 'featuring é\nquote "x"')])
        self.assertEqual(data["artists"][0]["name"], "Various Artists")
        self.assertEqual(data["artists"][2]["trashed"], True)
        self.assertEqual(data["albums"][0]["artwork_id"], 77)
        self.assertNotIn("NEVER-EXPORT", json.dumps(data))
        self.assertEqual(set(data), set(COLUMNS) | {"manifest"})
        for table in COLUMNS:
            for row in data[table]:
                self.assertEqual(set(row), set(COLUMNS[table]))

    def test_csv_zip_matches_json_including_nulls_unicode_escaping_and_manifest(self):
        data = json.loads(self.contents(self.start()))
        with zipfile.ZipFile(io.BytesIO(self.contents(self.start("csv")))) as archive:
            self.assertEqual(set(archive.namelist()), {f"{name}.csv" for name in COLUMNS} | {"manifest.json", "README.txt"})
            self.assertIsNone(archive.testzip())
            for table in COLUMNS:
                payload = archive.read(table + ".csv")
                self.assertTrue(payload.startswith(b"\xef\xbb\xbf"))
                rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"), newline="")))
                self.assertEqual(rows, [{key: str(csv_cell(value)) for key, value in row.items()} for row in data[table]])
            self.assertEqual(json.loads(archive.read("manifest.json"))["counts"], data["manifest"]["counts"])
            self.assertIn("Null is \\N", archive.read("README.txt").decode())
        for original in ["=1+1", "+cmd", "  @formula", "-5", "\tstuff", "\nhi", "\x00control", "\ufeff=formula", "\\N", "'apostrophe", "é" * 5000, ""]:
            encoded = csv_cell(original)
            decoded = encoded[1:] if encoded.startswith("'") else encoded
            self.assertEqual(decoded, original)
            if original.lstrip().startswith(("=", "+", "-", "@")):
                self.assertTrue(encoded.startswith("'"))
        self.assertEqual(csv_cell(None), "\\N")
        self.assertEqual(csv_cell(False), "false")

    def test_nested_credit_maps_empty_roles_and_missing_primary_genre_are_preserved(self):
        data = fixture()
        rows = data["library"]["tracks"]
        rows["map"] = {"artists_additional_map": {"artist_id": 2, "phrase": 0, "type": 1}}
        rows["100"]["artists_additional"] = [["", "", 5], [None, "composer", 6]]
        del rows["101"]["genre"]
        self.studio.library = Library(data)
        exported = json.loads(self.contents(self.start()))
        credits = [c for c in exported["credits"] if c["entity_type"] == "track" and c["entity_id"] == "100"]
        self.assertEqual([(c["role"], c["phrase"]) for c in credits[1:]], [("", ""), ("composer", None)])
        self.assertIsNone(exported["tracks"][1]["genre"])

    def test_optional_data_favourites_are_account_scoped_and_never_migrated(self):
        for kind, ids in [("album", ["10", "999"]), ("artist", ["5"])]:
            (Path(self.temp.name) / f"{kind}-favourites.json").write_text(json.dumps(
                {"version": 1, "accounts": {"account-one": ids, "NEVER-EXPORT": ["444"]}}))
        data = json.loads(self.contents(self.start()))
        self.assertEqual(data["favourites"], [{"entity_type": "album", "entity_id": "10", "in_export": True},
                                            {"entity_type": "album", "entity_id": "999", "in_export": False},
                                            {"entity_type": "artist", "entity_id": "5", "in_export": True}])
        self.assertEqual([row["track_id"] for row in data["playlist_tracks"]], ["100", "100", "103", "999"])
        self.assertEqual([row["in_export"] for row in data["tag_tracks"]], [True, False])
        self.assertEqual(len(data["tags"]), 2)
        self.assertNotIn("NEVER-EXPORT", json.dumps(data))
        excluded = json.loads(self.contents(self.start(include_tags=False, include_playlists=False, include_favourites=False)))
        for table in ("tags", "tag_tracks", "playlists", "playlist_tracks", "favourites"):
            self.assertEqual(excluded[table], [])
        self.assertTrue(all(row["status"] == "not_requested" for row in excluded["manifest"]["optional"].values()))

    def test_unloaded_optional_data_and_corrupt_local_file_are_reported_honestly(self):
        data = fixture()
        del data["library"]["tags"], data["library"]["playlists"]
        self.studio.library = Library(data)
        path = Path(self.temp.name) / "album-favourites.json"
        path.write_text("broken JSON")
        exported = json.loads(self.contents(self.start()))
        self.assertEqual(exported["manifest"]["optional"]["tags"]["status"], "not_loaded")
        self.assertEqual(exported["manifest"]["optional"]["playlists"]["status"], "not_loaded")
        self.assertEqual(exported["manifest"]["optional"]["album_favourites"]["status"], "unavailable")
        self.assertEqual(path.read_text(), "broken JSON")
        self.assertFalse((Path(self.temp.name) / "artist-favourites.json").exists())

    def test_large_playlist_is_not_capped_at_ten_thousand_and_rows_are_streamed(self):
        data = fixture()
        ids = [100, 104, 100] * 6000
        data["library"]["playlists"]["50"]["tracks"] = ids
        self.studio.library = Library(data)
        exported = json.loads(self.contents(self.start()))
        self.assertEqual([r["track_id"] for r in exported["playlist_tracks"]], list(map(str, ids)))
        self.assertEqual(exported["playlist_tracks"][-1]["position"], len(ids) - 1)
        snapshot = Snapshot(self.studio.library, {"tags": True, "playlists": True}, {}, {})
        self.assertFalse(isinstance(snapshot.rows("tracks"), list))

    def test_validation_session_and_library_replacements_block_old_downloads(self):
        for body in ({}, {"format": "xml"}, {"format": "json", "include_tags": 1}):
            with self.assertRaises(LibraryError):
                self.export.start(body)
        with self.assertRaises(ConflictError):
            self.export.start({"format": "json", "session": "old-session"})
        for key, value in [("library", Library(fixture())), ("library_user", "other-account"),
                           ("client", Mock()), ("combine_sets", True), ("playback_session", "new-session")]:
            job = self.start()
            self.ready(job)
            previous = getattr(self.studio, key)
            setattr(self.studio, key, value)
            with self.subTest(key=key), self.assertRaises(ConflictError):
                with self.export.download(job["id"], "test-session"):
                    self.fail("Stale export was opened")
            setattr(self.studio, key, previous)
        for invalid in ([], {}, None, "no", "A" * 32):
            with self.subTest(id=invalid), self.assertRaises(LibraryError):
                self.export.status(invalid, "test-session")

    def test_cancellation_error_expiry_and_shutdown_close_private_files(self):
        job = self.start()
        self.ready(job)
        handle = self.export.jobs[job["id"]]["file"]
        with self.export.download(job["id"], "test-session"):
            self.export.cancel({"id": job["id"], "session": "test-session"})
            self.assertFalse(handle.closed)
        self.assertTrue(handle.closed)
        with self.assertRaises(LibraryError):
            self.export.status(job["id"], "test-session")
        job = self.start()
        self.ready(job)
        handle = self.export.jobs[job["id"]]["file"]
        self.export._expire(job["id"])
        self.assertTrue(handle.closed)
        with patch("tagcast.metadata_export.write_export", side_effect=OSError("NEVER-EXPORT")):
            broken = self.start()
            deadline = time.monotonic() + 5
            while self.export.status(broken["id"], "test-session")["state"] == "preparing" and time.monotonic() < deadline:
                time.sleep(0.005)
            status = self.export.status(broken["id"], "test-session")
        self.assertEqual(status["state"], "error")
        self.assertNotIn("NEVER-EXPORT", status["error"])
        job = self.start()
        self.ready(job)
        handle = self.export.jobs[job["id"]]["file"]
        self.export.close()
        self.assertTrue(handle.closed)
        self.assertFalse(self.export.jobs)
        with self.assertRaises(LibraryError):
            self.start()

    def test_overlapping_preparations_are_rejected_and_late_build_is_discarded(self):
        entered, release = threading.Event(), threading.Event()
        handles = []

        def slow(snapshot, output, kind, check):
            handles.append(output)
            entered.set()
            release.wait(5)
            return write_export(snapshot, output, kind, check)

        with patch("tagcast.metadata_export.write_export", slow):
            job = self.start()
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaises(LibraryError):
                    self.start()
                self.studio.library = Library(fixture())
                release.set()
                deadline = time.monotonic() + 5
                while not handles[0].closed and time.monotonic() < deadline:
                    time.sleep(0.005)
                self.assertTrue(handles[0].closed)
                self.assertNotIn("file", self.export.jobs[job["id"]])
            finally:
                release.set()

    def test_downloads_share_a_serialized_read_lease_and_only_two_files_are_retained(self):
        jobs = [self.start()]
        self.ready(jobs[0])
        first = self.export.jobs[jobs[0]["id"]]["file"]
        for _ in range(2):
            jobs.append(self.start())
            self.ready(jobs[-1])
        self.assertTrue(first.closed)
        self.assertEqual(len(self.export.jobs), 2)

        def read():
            with self.export.download(jobs[-1]["id"], "test-session") as opened:
                return json.loads(opened["file"].read())["manifest"]["counts"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(*list(pool.map(lambda _: read(), range(2))))


class MetadataExportHTTPTests(ExportTestCase):
    def test_download_routes_security_headers_attachment_and_exact_json_zip(self):
        handler = type("ExportHandler", (app.Handler,), {"studio": self.studio, "port": 0})
        server = app.Server(("127.0.0.1", 0), handler)
        handler.port = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(method, path, body=None, headers=None):
            connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request(method, path, json.dumps(body) if body is not None else None, headers or {})
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), response.read()
            finally:
                connection.close()

        start = {"format": "json", "session": "test-session"}
        self.assertEqual(request("POST", "/api/metadata-export", start)[0], 403)
        self.assertEqual(request("POST", "/api/metadata-export/cancel", {})[0], 403)
        for path in ("/api/metadata-export/status", "/api/metadata-export/download"):
            self.assertEqual(request("GET", path, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
            self.assertEqual(request("GET", path, headers={"Host": "evil.test"})[0], 403)
        for kind in ("json", "csv"):
            status, _, body = request("POST", "/api/metadata-export", {**start, "format": kind}, {"X-Tagcast": "1"})
            self.assertEqual(status, 200)
            job = json.loads(body)
            self.ready(job)
            query = f'?id={job["id"]}&session=test-session'
            status, _, body = request("GET", "/api/metadata-export/status" + query)
            self.assertEqual(status, 200)
            self.assertNotIn("file", json.loads(body))
            status, headers, body = request("GET", "/api/metadata-export/download" + query)
            self.assertEqual(status, 200)
            self.assertEqual(int(headers["Content-Length"]), len(body))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertIn('attachment; filename="tagcast-metadata-', headers["Content-Disposition"])
            if kind == "json":
                self.assertEqual(json.loads(body)["manifest"]["counts"]["tracks"], 3)
            else:
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    self.assertIn("credits.csv", archive.namelist())
            self.assertEqual(request("GET", f'/api/metadata-export/download?id={job["id"]}&session=old')[0], 409)
        self.assertEqual(request("POST", "/api/metadata-export/cancel", {"id": []}, {"X-Tagcast": "1"})[0], 400)
