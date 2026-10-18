"""Read-only, account-bound metadata snapshots and bounded temporary downloads."""

import csv
import io
import json
import math
import secrets
import tempfile
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone

from . import __version__
from .library import (
    FORMATS,
    ConflictError,
    LibraryError,
    additional_artists,
    number,
    text,
    uploaded_at,
)

LIFETIME = 15 * 60
COLUMNS = {
    "artists": ("artist_id", "name", "rating", "artwork_id", "trashed"),
    "albums": ("album_id", "title", "primary_artist_id", "primary_artist_name", "album_artists", "year", "disc", "rating", "artwork_id"),
    "album_tracks": ("album_id", "track_id", "position"),
    "tracks": ("track_id", "album_id", "source_album_id", "album_title", "album_artists", "title", "primary_artist_id", "primary_artist_name", "track_artists", "composers", "genres", "genre", "year", "track", "length", "rating", "type", "format", "artwork_id", "uploaded_on", "uploaded_time", "uploaded_at"),
    "credits": ("entity_type", "entity_id", "position", "primary", "artist_id", "artist_name", "role", "phrase"),
    "genres": ("track_id", "position", "main", "label"),
    "tags": ("tag_id", "name", "archived"),
    "tag_tracks": ("tag_id", "track_id", "in_export"),
    "playlists": ("playlist_id", "name", "description", "type", "system_created", "artwork_id", "sort"),
    "playlist_folders": ("folder_id", "name", "description", "artwork_id", "sort"),
    "playlist_folder_items": ("folder_id", "position", "playlist_id", "kind", "in_export"),
    "playlist_tracks": ("playlist_id", "position", "track_id", "in_export"),
    "favourites": ("entity_type", "entity_id", "in_export"),
}
CSV_NOTES = """Tagcast library metadata export (schema 2)

manifest.json describes the snapshot, completeness, counts and columns.
IDs join the tables. Album records are the native records supplied by iBroadcast;
Tagcast's browser disc grouping is not applied. album_tracks preserves membership
and ordering, including combined views. source_album_id preserves the track's own
stored album ID. Positions are zero-based; genre position 0 is the main genre.
Credits include primary identities and all additional native roles and phrases.
Genres preserve stored labels, punctuation, order and duplicates; display summary
columns are for reading, not for reconstructing relationships.

CSV files use UTF-8 with a BOM, commas, quoted cells and CRLF record separators.
Null is \\N; an empty string is an empty cell. Text beginning with a backslash,
apostrophe or control character, or resembling a spreadsheet formula after leading
whitespace, has one apostrophe prepended. Remove exactly that first apostrophe
when decoding such text. This prevents formulas from executing in spreadsheets
and distinguishes literal \\N from null. Booleans are true/false. JSON preserves
native scalar values directly. No metadata is truncated.

Optional tag/playlist memberships preserve stored IDs, order and repeated playlist
positions, including unavailable tracks (in_export=false). Playlist folders are
separate records; playlist_folder_items contains playlist/folder IDs, never track
IDs. Missing references are retained with kind=unavailable and in_export=false. Core music tables cover
active library membership. Local favourites are only from this account's saved files;
no migration is run. Optional data is never fetched to prepare this export.

This is a metadata archive. It contains no audio, image binaries, OAuth credentials,
source API keys, signed streaming URLs or settings dump. No restore/import is run.
"""


def scalar(value):
    if value is None or type(value) in (str, int, bool):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    return None


def csv_cell(value):
    if value is None:
        return "\\N"
    if type(value) is bool:
        return "true" if value else "false"
    if isinstance(value, str) and (value.startswith(("\\", "'", "\ufeff"))
                                  or (value and ord(value[0]) < 32)
                                  or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


class Snapshot:
    def __init__(self, library, options, favourites, optional):
        self.library, self.options, self.favourites = library, options, favourites
        self.albums = sorted(library.album_ids())
        self.members = {}
        for album_id in self.albums:
            for track_id in library.active_track_ids(album_id):
                self.members.setdefault(track_id, album_id)
        self.tracks = sorted(self.members)
        self.manifest = {
            "format": "tagcast-library-metadata", "schema_version": 2,
            "tagcast_version": __version__, "exported_at": datetime.now(timezone.utc).isoformat(),
            "library_revision": library.lastmodified, "combine_sets": library.combine_sets,
            "scope": "active_library", "optional": optional, "counts": {},
            "columns": {key: list(value) for key, value in COLUMNS.items()},
            "notes": ["Native library records, without Tagcast's browser disc grouping.",
                      "When iBroadcast combines discs, only the supplied combined records are available; source album IDs are retained.",
                      "Loaded snapshot only: pending drafts and later iBroadcast changes are not included.",
                      "CSV encoding and reversible spreadsheet escaping are documented in README.txt."],
        }

    def album_artists(self, album):
        return " · ".join(self.library.artist_name(i) for i in self.library.album_artist_ids(album))

    def rows(self, table):
        lib = self.library
        if table == "artists":
            for artist_id in sorted(set(lib.artists) | {0}):
                row = lib.artists.get(artist_id, {})
                name = text(row.get("name")) if artist_id in lib.artists else "Various Artists"
                yield dict(zip(COLUMNS[table], (str(artist_id), name, scalar(row.get("rating")), scalar(row.get("artwork_id")), scalar(row.get("trashed")))))
        elif table == "albums":
            for album_id in self.albums:
                row = lib.albums[album_id]
                yield dict(zip(COLUMNS[table], (str(album_id), text(row.get("name")), str(number(row.get("artist_id"))), lib.artist_name(row.get("artist_id")), self.album_artists(row), scalar(row.get("year")), scalar(row.get("disc")), scalar(row.get("rating")), lib.album_artwork(lib.active_track_ids(album_id)))))
        elif table == "album_tracks":
            for album_id in self.albums:
                for position, track_id in enumerate(lib.active_track_ids(album_id)):
                    yield {"album_id": str(album_id), "track_id": str(track_id), "position": position}
        elif table == "tracks":
            for track_id in self.tracks:
                row = lib.tracks[track_id]
                album_id = self.members[track_id]
                album = lib.albums[album_id]
                credits = lib.credits_view(row, lib.tracks)
                genres = [g["label"] for g in self.genre_rows(track_id) if isinstance(g["label"], str) and g["label"]]
                values = (str(track_id), str(album_id), str(number(row.get("album_id"))) if row.get("album_id") is not None else None,
                          text(album.get("name")), self.album_artists(album), text(row.get("title")),
                          str(number(row.get("artist_id"))), lib.artist_name(row.get("artist_id")),
                          " · ".join(a["name"] for a in lib.performer_view(row)),
                          " · ".join(e["name"] for e in credits if e["type"] == "composer"), " · ".join(genres),
                          *(scalar(row.get(key)) for key in ("genre", "year", "track", "length", "rating", "type")),
                          FORMATS.get(text(row.get("type")).strip().lower(), ""), scalar(row.get("artwork_id")),
                          scalar(row.get("uploaded_on")), scalar(row.get("uploaded_time")), uploaded_at(row))
                yield dict(zip(COLUMNS[table], values))
        elif table == "credits":
            for entity_type, ids, records in (("album", self.albums, lib.albums), ("track", self.tracks, lib.tracks)):
                for entity_id in ids:
                    row = records[entity_id]
                    primary = number(row.get("artist_id"))
                    yield dict(zip(COLUMNS[table], (entity_type, str(entity_id), 0, True, str(primary), lib.artist_name(primary), None, None)))
                    for position, credit in enumerate(additional_artists(row, records.nested.get("artists_additional_map")), 1):
                        artist_id = credit["artist_id"]
                        yield dict(zip(COLUMNS[table], (entity_type, str(entity_id), position, False, str(artist_id), lib.artist_name(artist_id), scalar(credit.get("type")), scalar(credit.get("phrase")))))
        elif table == "genres":
            for track_id in self.tracks:
                yield from self.genre_rows(track_id)
        elif table == "tags" and self.options["tags"] and lib.tags_loaded:
            for tag_id, row in sorted(lib.tags.items()):
                yield {"tag_id": str(tag_id), "name": row["name"], "archived": row["archived"]}
        elif table == "tag_tracks" and self.options["tags"] and lib.tags_loaded:
            for tag_id, row in sorted(lib.tags.items()):
                for track_id in row["tracks"]:
                    yield {"tag_id": str(tag_id), "track_id": str(track_id), "in_export": track_id in self.members}
        elif table == "playlists" and self.options["playlists"] and lib.playlists_loaded:
            for playlist_id, row in sorted(lib.playlists.items()):
                if row.get("type") == "folder":
                    continue
                yield {"playlist_id": str(playlist_id), **{key: scalar(row.get(key)) for key in COLUMNS[table][1:]}}
        elif table == "playlist_tracks" and self.options["playlists"] and lib.playlists_loaded:
            for playlist_id, row in sorted(lib.playlists.items()):
                if row.get("type") == "folder":
                    continue
                for position, track_id in enumerate(row.get("tracks") or []):
                    if type(track_id) in (int, str) and str(track_id).isascii() and str(track_id).isdigit():
                        yield {"playlist_id": str(playlist_id), "position": position, "track_id": str(track_id), "in_export": number(track_id) in self.members}
        elif table == "playlist_folders" and self.options["playlists"] and lib.playlists_loaded:
            for folder_id, row in sorted(lib.playlists.items()):
                if row.get("type") == "folder":
                    yield {"folder_id": str(folder_id), **{key: scalar(row.get(key)) for key in COLUMNS[table][1:]}}
        elif table == "playlist_folder_items" and self.options["playlists"] and lib.playlists_loaded:
            for folder_id, row in sorted(lib.playlists.items()):
                if row.get("type") != "folder":
                    continue
                for position, member in enumerate(row.get("tracks") or []):
                    if type(member) not in (int, str) or not str(member).isascii() or not str(member).isdigit():
                        continue
                    child = lib.playlists.get(number(member))
                    yield {"folder_id": str(folder_id), "position": position, "playlist_id": str(member),
                           "kind": "unavailable" if child is None else "folder" if child.get("type") == "folder" else "playlist",
                           "in_export": child is not None}
        elif table == "favourites":
            for entity_type, ids in self.favourites.items():
                exported = set(self.albums) if entity_type == "album" else set(lib.artists) | {0}
                for entity_id in ids:
                    yield {"entity_type": entity_type, "entity_id": entity_id, "in_export": int(entity_id) in exported}

    def genre_rows(self, track_id):
        row = self.library.tracks[track_id]
        if row.get("genre") is not None and row.get("genre") != "":
            yield {"track_id": str(track_id), "position": 0, "main": True, "label": scalar(row.get("genre"))}
        extra = row.get("genres_additional")
        if isinstance(extra, list):
            for position, value in enumerate(extra, 1):
                yield {"track_id": str(track_id), "position": position, "main": False, "label": scalar(value)}


def write_export(snapshot, output, kind, check):
    counts = snapshot.manifest["counts"]

    def rows(table):
        counts[table] = 0
        for row in snapshot.rows(table):
            if counts[table] % 1024 == 0:
                check()
            counts[table] += 1
            yield row

    def encode(value):
        return json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if kind == "json":
        output.write(b"{\n")
        for table in COLUMNS:
            output.write(encode(table) + b":[\n")
            first = True
            for row in rows(table):
                if not first:
                    output.write(b",\n")
                output.write(encode(row))
                first = False
            output.write(b"],\n")
        output.write(b'"manifest":' + encode(snapshot.manifest) + b"\n}\n")
    else:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for table, columns in COLUMNS.items():
                with archive.open(f"{table}.csv", "w", force_zip64=True) as member:
                    with io.TextIOWrapper(member, encoding="utf-8-sig", newline="") as stream:
                        writer = csv.writer(stream)
                        writer.writerow(columns)
                        for row in rows(table):
                            writer.writerow([csv_cell(row.get(key)) for key in columns])
            archive.writestr("manifest.json", encode(snapshot.manifest))
            archive.writestr("README.txt", CSV_NOTES.encode("utf-8"))
    check()
    output.flush()
    return output.tell()


class MetadataExport:
    def __init__(self, studio):
        self.studio, self.lock, self.jobs = studio, threading.RLock(), {}
        self.closed = False

    def _current(self, job, session):
        s = self.studio
        if not session or session != s.playback_session or job["session"] != session \
                or job["client"] is not s.client or job["library"] is not s.library \
                or job["user"] != s.library_user or job["combine"] != s.combine_sets \
                or job["revision"] != s.library.lastmodified:
            raise ConflictError("The account or loaded library changed. Prepare a new metadata export.")

    def _retire(self, job):
        job["stop"].set()
        if job.get("file") and not job["readers"]:
            job.pop("file").close()

    def _expire(self, job_id):
        with self.lock:
            if job := self.jobs.pop(job_id, None):
                job["timer"].cancel()
                self._retire(job)

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                job["timer"].cancel()
                self._retire(job)
            self.jobs.clear()

    def _favourites(self, user, enabled):
        optional, saved = {}, {}
        for kind in ("album", "artist"):
            status = {"requested": enabled, "status": "not_requested"}
            optional[f"{kind}_favourites"] = status
            if not enabled:
                continue
            filename = f"{kind}-favourites.json"
            data = self.studio._read(filename)
            if data is None and not (self.studio.home / filename).exists():
                saved[kind] = []
                status.update(status="included", note="No saved local favourites file; no migration was run.")
                continue
            values = data.get("accounts", {}).get(user, []) if isinstance(data, dict) and isinstance(data.get("accounts"), dict) else None
            if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(values, list) or any(
                    not isinstance(i, str) or not i.isascii() or not i.isdigit() or len(i) > 32 or int(i) <= 0 for i in values):
                status.update(status="unavailable", note=f"Could not read {filename}; the file was not changed.")
                continue
            saved[kind] = sorted(set(values), key=int)
            status["status"] = "included"
        return saved, optional

    def start(self, body):
        kind = body.get("format")
        if kind not in ("json", "csv") or any(type(body.get(f"include_{name}", True)) is not bool for name in ("tags", "playlists", "favourites")):
            raise LibraryError("Choose JSON or CSV ZIP and valid export options.")
        options = {name: body.get(f"include_{name}", True) for name in ("tags", "playlists", "favourites")}
        s = self.studio
        with s.lock, self.lock:
            s._require_client()
            if not s.library or not s.library_user or not body.get("session") or body["session"] != s.playback_session:
                raise ConflictError("Load the connected library before preparing a metadata export.")
            if self.closed:
                raise LibraryError("The local server is stopping.")
            for job_id, previous in list(self.jobs.items()):
                try:
                    self._current(previous, body["session"])
                except ConflictError:
                    self._expire(job_id)
            if any(job["state"] == "preparing" for job in self.jobs.values()):
                raise LibraryError("A metadata export is already being prepared.")
            while len(self.jobs) >= 2:
                self._expire(next(iter(self.jobs)))
            favourites, optional = self._favourites(str(s.library_user), options["favourites"])
            for name in ("tags", "playlists"):
                loaded = getattr(s.library, f"{name}_loaded")
                optional[name] = {"requested": options[name], "status": "included" if options[name] and loaded else "not_loaded" if options[name] else "not_requested"}
            job_id = secrets.token_hex(16)
            job = {"id": job_id, "state": "preparing", "format": kind, "client": s.client,
                   "library": s.library, "user": s.library_user, "session": s.playback_session,
                   "combine": s.combine_sets, "revision": s.library.lastmodified,
                   "readers": 0, "read_lock": threading.Lock(), "stop": threading.Event()}
            timer = job["timer"] = threading.Timer(LIFETIME, self._expire, (job_id,))
            timer.daemon = True
            self.jobs[job_id] = job
            timer.start()
        threading.Thread(target=self._build, args=(job, options, favourites, optional), daemon=True).start()
        return {"id": job_id, "state": "preparing", "format": kind}

    def _check(self, job):
        if job["stop"].is_set():
            raise LibraryError("This metadata export was cancelled or expired.")
        with self.studio.lock:
            self._current(job, job["session"])

    def _build(self, job, options, favourites, optional):
        output = None
        try:
            self._check(job)
            snapshot = Snapshot(job["library"], options, favourites, optional)
            output = tempfile.TemporaryFile(mode="w+b")
            size = write_export(snapshot, output, job["format"], lambda: self._check(job))
            with self.studio.lock, self.lock:
                self._check(job)
                job.update(state="ready", file=output, size=size, manifest=snapshot.manifest,
                           filename=f"tagcast-metadata-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.{'json' if job['format'] == 'json' else 'zip'}")
                output = None
        except Exception as error:
            with self.lock:
                job.update(state="error", error=str(error) if isinstance(error, LibraryError) else "Could not prepare the metadata file. Try again.")
        finally:
            if output:
                output.close()

    def _job(self, job_id, session):
        if not isinstance(job_id, str) or len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            raise LibraryError("Choose a prepared metadata export.")
        job = self.jobs.get(job_id)
        if not job or job["stop"].is_set():
            raise LibraryError("This metadata export expired or was cancelled. Prepare a new export.")
        self._current(job, session)
        return job

    def status(self, job_id, session):
        with self.studio.lock, self.lock:
            job = self._job(job_id, session)
            return {key: job[key] for key in ("id", "state", "format", "filename", "size", "manifest", "error") if key in job}

    def cancel(self, body):
        with self.studio.lock, self.lock:
            job = self._job(body.get("id"), body.get("session"))
            self._expire(job["id"])
        return {"state": "cancelled"}

    @contextmanager
    def download(self, job_id, session):
        with self.studio.lock, self.lock:
            job = self._job(job_id, session)
            if job["state"] != "ready":
                raise LibraryError("The metadata export is not ready to download.")
            job["readers"] += 1
        try:
            with job["read_lock"]:
                self._check(job)
                job["file"].seek(0)
                yield job
        finally:
            with self.lock:
                job["readers"] -= 1
                if job["stop"].is_set():
                    self._retire(job)
