"""Local CSV playlist drafts: conservative matching, explicit choices and reviewed creation."""

import csv
import hashlib
import io
import json
import math
import re
import secrets
import threading
import time
from bisect import bisect_left
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from heapq import nlargest

from .library import FORMATS, ConflictError, LibraryError, fold, number, text, title_key
from .metadata_export import csv_cell
from .playlist_import_store import COPY_PREFERENCES, MAX_PAUSED, PausedImports
from .playlist_sources import PlaylistSources, source_url

MAX_ROWS = 10000
MAX_TEXT = 10 * 1024 * 1024
MAX_EXPORT_TEXT = 12 * 1024 * 1024
CSV_EXPORT_MARKER = "# Tagcast playlist CSV 1: escaped text"
PAGE = 50
FIELDS = ("title", "artist", "album", "album_artist", "duration", "year", "track")
ALIASES = {
    "title": ("track name", "track title", "title", "song", "titel"),
    "artist": ("artist name(s)", "track artist", "artist", "artists", "artiest"),
    "album": ("album name", "album", "album title"),
    "album_artist": ("album artist", "album artists", "albumartiest"),
    "duration": ("duration (ms)", "duration", "length", "time", "speelduur"),
    "year": ("release date", "release year", "year", "jaar"),
    "track": ("track number", "track", "tracknummer"),
}


def guessed_mapping(columns):
    labels = [fold(c) for c in columns]
    return {key: next((labels.index(alias) for alias in aliases if alias in labels), None)
            for key, aliases in ALIASES.items()}


def parse_csv(content, delimiter="auto", header=True):
    if not isinstance(content, str) or not content.strip():
        raise LibraryError("Choose a nonempty CSV file up to 5 MB.")
    try:
        size = len(content.encode("utf-8"))
    except UnicodeEncodeError:
        raise LibraryError("Invalid Unicode in the CSV. Choose its correct text encoding.") from None
    content = content.lstrip("\ufeff")
    first, newline, rest = content.partition("\n")
    exported = bool(newline) and first.rstrip("\r").rstrip(",;\t|") == CSV_EXPORT_MARKER
    if size > (MAX_EXPORT_TEXT if exported else MAX_TEXT):
        raise LibraryError("Choose a CSV file up to 5 MB, or a Tagcast unresolved export up to 12 MB.")
    if "\x00" in content or type(header) is not bool or delimiter not in ("auto", ",", ";", "\t", "|"):
        raise LibraryError("Choose the CSV encoding, separator and header setting.")
    if exported:
        content = rest
    line_offset = int(exported)
    if delimiter == "auto":
        try:
            delimiter = csv.Sniffer().sniff(content[:65536], delimiters=",;\t|").delimiter
        except csv.Error:
            raise LibraryError("The separator could not be detected. Choose comma, semicolon, tab or pipe.") from None
    rows, blank, columns = [], 0, None
    try:
        reader = csv.reader(io.StringIO(content, newline=""), delimiter=delimiter, strict=True)
        for row in reader:
            if exported:
                row = [cell[1:] if cell.startswith("'") else cell for cell in row]
            if not row or not any(value.strip() for value in row):
                blank += 1
                continue
            if len(row) > 100 or any(len(c) > 2000 for c in row):
                raise LibraryError(f"CSV record ending at line {reader.line_num + line_offset} exceeds 100 columns or 2,000 characters per cell.")
            if columns is None:
                columns = row if header else [f"Column {i + 1}" for i in range(len(row))]
                if len(columns) < 2:
                    raise LibraryError("At least two columns are needed. Check the separator.")
                if header:
                    continue
            if len(row) > len(columns):
                raise LibraryError(f"CSV record ending at line {reader.line_num + line_offset} has more cells than columns. Check the separator and quotes.")
            rows.append({"line": reader.line_num + line_offset, "cells": row + [""] * (len(columns) - len(row))})
            if len(rows) > MAX_ROWS:
                raise LibraryError("Import at most 10,000 CSV records at a time; split a larger file first.")
    except csv.Error as error:
        raise LibraryError(f"Invalid CSV near line {reader.line_num + line_offset}: {error}") from None
    if not rows:
        raise LibraryError("The CSV contains no data records.")
    return columns, rows, delimiter, blank


def duration_seconds(value, unit):
    if not value:
        return None
    try:
        if ":" in value:
            pieces = value.split(":")
            if len(pieces) not in (2, 3) or any(not re.fullmatch(r"\d+(?:\.\d+)?", p) for p in pieces):
                raise ValueError
            parts = [float(p) for p in pieces]
            if any(v >= 60 for v in parts[1:]):
                raise ValueError
            result = sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
        else:
            result = float(value.replace(",", ".")) / (1000 if unit == "milliseconds" else 1)
        if not math.isfinite(result) or not 0 < result <= 86400:
            raise ValueError
        return result
    except ValueError:
        raise LibraryError("Invalid duration") from None


def suggestion_title(value):
    """Version suffixes may find alternatives, but never establish an automatic match."""
    return re.sub(r"\s*(?:[-–—]\s*|\()\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|live|remix|radio edit)\b.*$", "", fold(value))


class TrackCatalogue:
    """One compact, lazy index of the loaded library; never fetch audio or details."""

    def __init__(self, library):
        self.library = library
        self.members, self.titles, self.artists = {}, defaultdict(list), defaultdict(list)
        self.names = {i: title_key(a.get("name")) for i, a in library.artists.items()}
        for album_id in library.album_ids():
            for track_id in library.active_track_ids(album_id):
                if track_id <= 0 or track_id in self.members:
                    continue
                track = library.tracks[track_id]
                key = title_key(track.get("title"))
                names = tuple(self.names.get(i, "") for i in library.performer_ids(track))
                self.members[track_id] = (album_id, key, names)
                self.titles[key].append(track_id)
                for name in set(names) - {""}:
                    self.artists[name].append(track_id)
        for ids in self.artists.values():
            ids.sort(key=lambda i: (self.members[i][1], i))

    def row(self, track_id):
        album_id, _, _ = self.members[track_id]
        row = self.library.track_row(track_id, album_id)
        return {key: row[key] for key in ("id", "album_id", "title", "artist", "performers", "album", "disc", "track", "year", "length", "format")} | {
            "album_artist": " · ".join(self.library.artist_name(i) for i in self.library.album_artist_ids(self.library.albums[album_id]))}

    def signature(self, track_id):
        return hashlib.sha256(json.dumps(self.row(track_id), sort_keys=True).encode()).hexdigest()

    def differences(self, source, track_id):
        """Use the same comparisons for eligibility and bounded candidate explanations."""
        album_id, title, names = self.members[track_id]
        track, album = self.library.tracks[track_id], self.library.albums[album_id]
        if title_key(source["title"]) != title:
            yield "Track title differs (including version text)"
        if source["artists"] and not set(source["artists"]).issubset(names):
            yield "Performing artist name differs"
        if source["album"] and title_key(source["album"]) != title_key(album.get("name")):
            yield "Album title differs"
        if source["album_artists"] and not set(source["album_artists"]).issubset(
                self.names.get(i, "") for i in self.library.album_artist_ids(album)):
            yield "Album artist name differs"
        year = number(track.get("year")) or number(album.get("year"))
        if source["year"] and source["year"] != year:
            yield "Release year differs" if year else "Library track has no release year"
        if source["track"] and source["track"] != number(track.get("track")):
            yield "Track number differs" if number(track.get("track")) else "Library track has no track number"
        if source["seconds"] is not None:
            length = number(track.get("length"))
            if not length:
                yield "Library track has no duration"
            elif abs(source["seconds"] - length) > 3:
                yield "Duration differs by more than 3 seconds"

    def candidate(self, source, track_id):
        return {**self.row(track_id), "differences": list(self.differences(source, track_id))}

    def reasons(self, row):
        """Explain the original automatic decision, even after a manual choice or skip."""
        reasons = []
        if row["source"]["warnings"]:
            reasons.append("CSV fields need attention; check the warnings.")
        if row["eligible"] > 1:
            fields = "the valid mapped fields" if row["source"]["warnings"] else "all mapped fields"
            decision = (f'Originally selected using: {COPY_PREFERENCES[row["copy_preference"]]}.'
                        if row.get("preferred") else "Choose a copy.")
            reasons.append(f'{row["eligible"]} library tracks match {fields}. {decision}')
        elif not row["eligible"]:
            if row["candidates"]:
                differences = list(self.differences(row["source"], row["candidates"][0]))
                if differences:
                    reasons.append("Compared with the first suggestion: " + "; ".join(differences) + ".")
            else:
                reasons.append("No matching suggestion was found in the loaded library. Search manually or check the CSV columns.")
        return reasons

    def preferred_copy(self, eligible, preference):
        def rank(track_id):
            album_id = self.members[track_id][0]
            track, album = self.library.tracks[track_id], self.library.albums[album_id]
            flac = FORMATS.get(text(track.get("type")).strip().lower()) == "FLAC"
            year = number(track.get("year")) or number(album.get("year"))
            return (not flac if preference in ("flac", "flac_oldest") else False,
                    (year if year > 0 else math.inf) if preference in ("oldest", "flac_oldest") else 0,
                    track_id)
        return min(eligible, key=rank)

    def match(self, source, preference="manual"):
        title, artists = title_key(source["title"]), source["artists"]
        exact = self.titles.get(title, []) if title and artists else []
        eligible = [i for i in exact if not any(self.differences(source, i))]
        automatic = None
        if eligible and not source["warnings"]:
            if len(eligible) == 1:
                automatic = eligible[0]
            elif preference != "manual":
                automatic = self.preferred_copy(eligible, preference)
        if automatic:
            return automatic, [automatic], len(eligible)
        eligible_ids = set(eligible)
        # Title-version differences remain manual; duplicate copies need an explicit preference.
        # Automatic decisions use the complete exact index above. Alternative
        # suggestions are bounded; explicit search can page through every copy.
        pool = set(exact[:1000]) | set(eligible[:30])
        if len(pool) < 20:
            for name in artists:
                group = self.artists.get(name, [])
                position = bisect_left(group, title, key=lambda i: self.members[i][1])
                pool.update(group[max(0, position - 100):position + 100])
        suggestion = suggestion_title(source["title"])
        words = set(suggestion.split())

        def rough(i):
            _, key, names = self.members[i]
            tokens = set(suggestion_title(key).split())
            return (i in eligible_ids, len(words & tokens) / max(len(words | tokens), 1), bool(set(artists).issubset(names)), -i)

        shortlist = nlargest(30, pool, key=rough)
        def rank(i):
            row = self.row(i)
            return (i in eligible_ids, self.members[i][1] == title,
                    SequenceMatcher(None, suggestion, suggestion_title(row["title"]), autojunk=False).ratio(),
                    title_key(source["album"]) == title_key(row["album"]) if source["album"] else False,
                    -abs(source["seconds"] - row["length"]) if source["seconds"] is not None else 0, -i)
        candidates = [i for i in sorted(shortlist, key=rank, reverse=True)
                      if self.members[i][1] == title or SequenceMatcher(
                          None, suggestion, suggestion_title(self.members[i][1]), autojunk=False).ratio() >= .6][:10]
        return automatic, candidates, len(eligible)

    def search(self, query, offset):
        words = fold(query).split()
        if not words:
            return [], 0
        found = []
        for i, (album_id, title, names) in self.members.items():
            album = self.library.albums[album_id]
            haystack = fold(" ".join((title, *names, text(album.get("name")), *(self.library.artist_name(a) for a in self.library.album_artist_ids(album)))))
            if all(word in haystack for word in words):
                found.append(i)
        found.sort(key=lambda i: (self.members[i][2], self.members[i][1], self.members[i][0], i))
        return found[offset:offset + PAGE], len(found)


class PlaylistImport:
    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.RLock()
        self.drafts = {}
        self.catalogue = None
        self.paused_store = PausedImports(studio)
        self.url_fetch_lock = threading.Lock()

    def _context(self, body, draft=None, expected_library=None):
        studio = self.studio
        client = studio._require_client()
        library = studio.library
        if not library or not studio.library_user or not body.get("session") or body["session"] != studio.playback_session:
            raise ConflictError("The connection changed. Start a new CSV import.")
        if draft and (library is not (expected_library or draft["library"]) or studio.library_user != draft["account"] or client is not draft["client"]
                      or body["session"] != draft["session"] or library.combine_sets != draft["combine_sets"]):
            raise ConflictError("The library or account changed. Start a new CSV import.")
        return client, library

    def _draft(self, body, phases=None, *, source_only=False):
        for key, draft in list(self.drafts.items()):
            if time.monotonic() - draft["created"] > 3600:
                del self.drafts[key]
        key = body.get("id")
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{32}", key):
            raise LibraryError("Choose a valid CSV import.")
        draft = self.drafts.get(key)
        if not draft:
            raise LibraryError("This CSV import expired. Read the file again.")
        self._context(body, draft, expected_library=self.studio.library if source_only else None)
        if type(body.get("revision")) is not int or body["revision"] != draft["revision"]:
            raise ConflictError("The import changed in another request. Open a fresh overview.")
        if phases and draft["phase"] not in phases:
            raise LibraryError("Complete the current import step first. A sent import cannot be repeated.")
        return draft

    def _index(self, library):
        if self.catalogue is None or self.catalogue.library is not library:
            self.catalogue = TrackCatalogue(library)
        return self.catalogue

    @staticmethod
    def _paused_row(row):
        return {key: row[key] for key in ("id", "token", "name", "description", "saved_at", "state", "phase", "unresolved")} | {
            "total": len(row["records"]), "manual": sum(c["status"] == "manual" for c in row["choices"]),
            "playlist": str(row.get("playlist") or ""), "origin": row.get("origin")}

    def paused(self, body):
        with self.lock:
            self._context(body)
            rows = self.paused_store.load(self.studio.library_user)
            self._context(body)
            return {"imports": [self._paused_row(r) for r in sorted(rows.values(), key=lambda r: r["saved_at"], reverse=True)],
                    "limit": MAX_PAUSED}

    def pause(self, body):
        with self.lock:
            draft = self._draft(body, ("mapping", "matched", "review"), source_only=True)
            name, description = body.get("name"), body.get("description", "")
            if not isinstance(name, str) or not name.strip() or len(name) > 200 or not isinstance(description, str) or len(description) > 2000:
                raise LibraryError("Enter a name of 1–200 characters and description up to 2,000.")
            mapping = body.get("mapping", draft.get("mapping", guessed_mapping(draft["columns"])))
            unit = body.get("duration_unit", draft.get("duration_unit", "seconds"))
            separator = body.get("artist_separator", draft.get("artist_separator", ""))
            preference = body.get("copy_preference", draft.get("copy_preference", "manual"))
            if not isinstance(preference, str) or preference not in COPY_PREFERENCES:
                raise LibraryError("Choose a valid matching-copy preference.")
            mapping_step = body.get("mapping_step", False)
            if not isinstance(mapping, dict) or set(mapping) - set(FIELDS) or any(v is not None and (type(v) is not int or not 0 <= v < len(draft["columns"])) for v in mapping.values()) or unit not in ("seconds", "milliseconds") or separator not in ("", ";"):
                raise LibraryError("Choose valid column mappings and duration units.")
            if type(mapping_step) is not bool:
                raise LibraryError("Choose a valid import step.")
            mapping_step = mapping_step or draft["phase"] == "mapping" or mapping != draft.get("mapping") or unit != draft.get("duration_unit") or separator != draft.get("artist_separator") or preference != draft.get("copy_preference", "manual")
            show, offset = body.get("show", "unresolved"), self._page(body)
            if show not in ("all", "unresolved", "automatic", "manual", "skipped"):
                raise LibraryError("Choose a valid import filter.")
            account = draft["account"]
            rows = self.paused_store.load(account)
            previous = draft.get("checkpoint")
            if previous:
                saved = self.paused_store.selected(rows, previous)
                if saved["state"] != "paused":
                    raise ConflictError("Playlist creation was already requested for this saved import. Check Playlists.")
                key = saved["id"]
            else:
                if len(rows) >= MAX_PAUSED:
                    raise LibraryError("Keep up to 10 paused imports per account. Remove one before pausing another.")
                key = secrets.token_hex(16)
            row = {"id": key, "token": secrets.token_hex(16), "saved_at": time.time(), "state": "paused",
                   "name": name.strip(), "description": description, "phase": "mapping" if mapping_step else "matched",
                   "columns": draft["columns"], "records": draft["records"], "blanks": draft["blanks"], "delimiter": draft["delimiter"],
                   "mapping": mapping, "duration_unit": unit, "artist_separator": separator, "copy_preference": preference, "show": show, "offset": offset,
                   "unresolved": 0 if mapping_step else self._summary(draft)["unresolved"],
                   "choices": [({key: r[key] for key in ("position", "status", "choice", "signature")}
                                if r["status"] in ("manual", "skipped") else r["previous_choice"])
                               for r in ([] if mapping_step else draft.get("rows", [])) if r["status"] in ("manual", "skipped") or r.get("previous_choice")]}
            rows[key] = row
            if draft.get("origin"):
                row["origin"] = draft["origin"]
            self._context(body, draft, expected_library=self.studio.library)
            self.paused_store.write(account, rows)
            del self.drafts[draft["id"]]
            if not self.drafts:
                self.catalogue = None
            return {"saved": self._paused_row(row)}

    def remove_paused(self, body):
        with self.lock:
            self._context(body)
            account = self.studio.library_user
            rows = self.paused_store.load(account)
            saved = self.paused_store.selected(rows, body)
            del rows[saved["id"]]
            self._context(body)
            self.paused_store.write(account, rows)
            return {"removed": True}

    def resume(self, body):
        with self.lock:
            client, library = self._context(body)
            account = self.studio.library_user
            saved = self.paused_store.selected(self.paused_store.load(account), body)
            preference = saved.get("copy_preference", "manual")
            if saved["state"] != "paused":
                raise ConflictError("Playlist creation was already requested. Check Playlists before importing again.")
            while len(self.drafts) >= 2:
                del self.drafts[next(iter(self.drafts))]
            key = secrets.token_hex(16)
            draft = {"id": key, "revision": 1, "phase": "mapping", "created": time.monotonic(),
                     "library": library, "account": account, "client": client, "session": body["session"],
                     "combine_sets": library.combine_sets, "columns": saved["columns"], "records": saved["records"],
                     "blanks": saved["blanks"], "delimiter": saved["delimiter"],
                     "checkpoint": {"saved_id": saved["id"], "saved_token": saved["token"]}}
            self.drafts[key] = draft
            if saved.get("origin"):
                draft["origin"] = saved["origin"]
            file_data = {key: draft[key] for key in ("id", "revision", "phase", "columns", "delimiter")}
            if draft.get("origin"):
                file_data.update(origin=draft["origin"], source_url=source_url(draft["origin"]))
            file_data.update(sample=draft["records"][:5], total=len(draft["records"]), blank_records=draft["blanks"],
                             mapping=saved["mapping"], duration_unit=saved["duration_unit"], artist_separator=saved["artist_separator"], copy_preference=preference)
            view = file_data
            try:
                if saved["phase"] != "mapping":
                    fields = {"id": key, "revision": 1, "session": body["session"], "mapping": saved["mapping"],
                              "duration_unit": saved["duration_unit"], "artist_separator": saved["artist_separator"], "copy_preference": preference}
                    self.match(fields)
                    catalogue = self._index(library)
                    for choice in saved["choices"]:
                        row = draft["rows"][choice["position"]]
                        track_id = choice.get("choice")
                        if choice["status"] == "skipped":
                            row.update(choice=None, status="skipped", signature=None)
                        elif track_id in catalogue.members and catalogue.signature(track_id) == choice["signature"]:
                            row.update(choice=track_id, status="manual", signature=choice["signature"])
                        else:
                            row.update(choice=None, signature=None, status="ambiguous" if row["candidates"] else "missing",
                                       previous_choice=choice,
                                       resume_warning="The previous manual choice changed or disappeared. Choose a track again.")
                    view = self._view(draft, {"show": saved["show"], "offset": saved["offset"]})
                self._context(body, draft)
                return {"view": view, "file": file_data, "name": saved["name"], "description": saved["description"],
                        "mapping": saved["mapping"], "duration_unit": saved["duration_unit"], "artist_separator": saved["artist_separator"], "copy_preference": preference}
            except Exception:
                self.drafts.pop(key, None)
                raise

    def _checkpoint_state(self, draft, state=None, playlist=None, remove=False):
        reference = draft.get("checkpoint")
        if not reference:
            return
        account = draft["account"]
        rows = self.paused_store.load(account)
        row = self.paused_store.selected(rows, reference)
        if state == "submitted" and row["state"] != "paused":
            raise ConflictError("Playlist creation was already requested for this saved import. Check Playlists.")
        if remove:
            del rows[row["id"]]
        else:
            row["state"] = state or row["state"]
            if state == "submitted":
                row["name"] = draft["review"]["name"]
                row["description"] = draft["review"]["description"]
            if playlist:
                row["playlist"] = playlist
        self.paused_store.write(account, rows)

    def read(self, body):
        client, library = self._context(body)
        columns, records, delimiter, blanks = parse_csv(body.get("text"), body.get("delimiter", "auto"), body.get("header", True))
        with self.lock:
            self._context(body)
            if self.studio.library is not library or self.studio.client is not client:
                raise ConflictError("The library changed while reading the CSV. Try again.")
            while len(self.drafts) >= 2:
                del self.drafts[next(iter(self.drafts))]
            key = secrets.token_hex(16)
            self.drafts[key] = {"id": key, "revision": 1, "phase": "mapping", "created": time.monotonic(),
                                "library": library, "account": self.studio.library_user, "client": client,
                                "session": body["session"], "combine_sets": library.combine_sets,
                                "columns": columns, "records": records, "blanks": blanks, "delimiter": delimiter}
            return {"id": key, "revision": 1, "phase": "mapping", "columns": columns,
                    "sample": records[:5], "total": len(records), "blank_records": blanks,
                    "mapping": guessed_mapping(columns), "delimiter": delimiter}

    def read_url(self, body):
        client, library = self._context(body)
        context = {"client": client, "library": library, "account": self.studio.library_user,
                   "session": body["session"], "combine_sets": library.combine_sets}
        provider = None

        def check(selected=None):
            nonlocal provider
            provider = selected or provider
            self._context(body, context)
            if provider == "deezer" and provider in self.studio.disabled_sources():
                raise LibraryError("Deezer is disabled. Enable it in Settings before fetching a playlist.")

        if not self.url_fetch_lock.acquire(blocking=False):
            raise LibraryError("A playlist URL is already being fetched. Wait for it to finish.")
        try:
            data = PlaylistSources(self.studio.lookup.http, check).fetch(body.get("url"))
            with self.lock:
                check()
                while len(self.drafts) >= 2:
                    del self.drafts[next(iter(self.drafts))]
                key = secrets.token_hex(16)
                self.drafts[key] = {**context, **{k: data[k] for k in ("columns", "records", "blanks", "delimiter", "origin")},
                                    "id": key, "revision": 1, "phase": "mapping", "created": time.monotonic()}
                # Other metadata stays available, but optional album/year/position are not constraints by default.
                mapping = {field: None for field in FIELDS} | {"title": 0, "artist": 1, "duration": 3}
                return {"id": key, "revision": 1, "phase": "mapping", "columns": data["columns"],
                        "sample": data["records"][:5], "total": len(data["records"]), "blank_records": 0,
                        "mapping": mapping, "delimiter": ",", "duration_unit": "seconds", "artist_separator": "",
                        "name": data["name"][:200], "origin": data["origin"], "source_url": source_url(data["origin"])}
        finally:
            self.url_fetch_lock.release()

    def match(self, body):
        with self.lock:
            draft = self._draft(body, ("mapping", "matched", "review"))
            mapping, unit, separator = body.get("mapping"), body.get("duration_unit", "seconds"), body.get("artist_separator", "")
            preference = body.get("copy_preference", "manual")
            if not isinstance(preference, str) or preference not in COPY_PREFERENCES:
                raise LibraryError("Choose a valid matching-copy preference.")
            if not isinstance(mapping, dict) or set(mapping) - set(FIELDS) or unit not in ("seconds", "milliseconds") or separator not in ("", ";"):
                raise LibraryError("Choose valid column mappings and duration units.")
            for key in FIELDS:
                value = mapping.get(key)
                if value is not None and (type(value) is not int or not 0 <= value < len(draft["columns"])):
                    raise LibraryError("Choose an existing CSV column.")
            selected = [v for v in mapping.values() if v is not None]
            if mapping.get("title") is None or mapping.get("artist") is None or len(set(selected)) != len(selected):
                raise LibraryError("Map separate title and performing-artist columns. Use each column once.")
            catalogue, rows, matches = self._index(draft["library"]), [], {}
            for position, record in enumerate(draft["records"]):
                source = {key: record["cells"][mapping[key]].strip() if mapping.get(key) is not None else "" for key in FIELDS}
                source.update(artists=[title_key(s) for s in (source["artist"].split(separator) if separator else [source["artist"]]) if s.strip()],
                              album_artists=[title_key(s) for s in (source["album_artist"].split(separator) if separator else [source["album_artist"]]) if s.strip()],
                              warnings=[], seconds=None)
                if not source["title"] or not source["artists"]:
                    source["warnings"].append("Title or performing artist is missing")
                try:
                    source["seconds"] = duration_seconds(source["duration"], unit)
                except LibraryError:
                    source["warnings"].append("Invalid duration; check the column and units")
                for key in ("year", "track"):
                    raw = source[key]
                    valid = re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", raw) if key == "year" else re.fullmatch(r"\d{1,4}", raw)
                    source[key] = int(raw[:4]) if raw and valid else 0
                    if raw and (not valid or not source[key]):
                        source["warnings"].append(f"Invalid {key}; check the column")
                cache_key = tuple(source[key] for key in FIELDS) + tuple(source["warnings"])
                if cache_key not in matches:
                    matches[cache_key] = catalogue.match(source, preference)
                automatic, candidates, eligible = matches[cache_key]
                rows.append({"position": position, "line": record["line"], "source": source,
                             "status": "automatic" if automatic else "ambiguous" if candidates else "missing",
                             "choice": automatic, "candidates": candidates, "eligible": eligible,
                             "copy_preference": preference, "preferred": bool(automatic and eligible > 1),
                             "signature": catalogue.signature(automatic) if automatic else None})
            self._context(body, draft)
            draft.update(rows=rows, mapping=dict(mapping), duration_unit=unit, artist_separator=separator, copy_preference=preference,
                         revision=draft["revision"] + 1, phase="matched", review=None)
            return self._view(draft, body)

    @staticmethod
    def _page(body):
        offset = body.get("offset", 0)
        if type(offset) is not int or offset < 0:
            raise LibraryError("Choose a valid import page.")
        return offset

    def _summary(self, draft):
        rows = draft.get("rows", [])
        counts = Counter(r["status"] for r in rows)
        ids = [r["choice"] for r in rows if r["choice"]]
        return {"total": len(rows), "resolved": len(ids), "unresolved": sum(r["choice"] is None and r["status"] != "skipped" for r in rows),
                "skipped": counts["skipped"], "duplicates": len(ids) - len(set(ids)), "unique": len(set(ids)),
                "automatic": counts["automatic"], "manual": counts["manual"], "blank_records": draft["blanks"]}

    def _view(self, draft, body):
        offset, show = self._page(body), body.get("show", "all")
        if show not in ("all", "unresolved", "automatic", "manual", "skipped"):
            raise LibraryError("Choose a valid import filter.")
        rows = draft.get("rows", [])
        found = [r for r in rows if show == "all" or (r["choice"] is None and r["status"] != "skipped" if show == "unresolved" else r["status"] == show)]
        offset = min(offset, max(0, (len(found) - 1) // PAGE * PAGE))
        catalogue = self._index(draft["library"])
        response = {"id": draft["id"], "revision": draft["revision"], "phase": draft["phase"], "summary": self._summary(draft),
                "total": len(found), "offset": offset, "show": show,
                "rows": [{**{key: row[key] for key in ("position", "line", "status", "eligible")},
                          "source": {key: row["source"][key] for key in (*FIELDS, "warnings")},
                          "reasons": ([row["resume_warning"]] if row.get("resume_warning") else []) + catalogue.reasons(row),
                          "choice": catalogue.row(row["choice"]) if row["choice"] else None,
                          "candidates": [catalogue.candidate(row["source"], i) for i in row["candidates"]]} for row in found[offset:offset + PAGE]]}
        self._context({"session": draft["session"]}, draft)
        return response

    def view(self, body):
        with self.lock:
            draft = self._draft(body, ("matched", "review", "sent", "uncertain"))
            return self._review_view(draft, body) if body.get("review") else self._view(draft, body)

    def export(self, body):
        """Export original unresolved CSV records, independently of paging or fresh read-back."""
        with self.lock:
            draft = self._draft(body, ("matched", "review", "sent", "uncertain"), source_only=True)
            positions = [r["position"] for r in draft["rows"] if r["choice"] is None and r["status"] != "skipped"]
            if not positions:
                raise LibraryError("There are no unresolved CSV records to export.")
            output = io.StringIO(newline="")
            output.write("\ufeff" + CSV_EXPORT_MARKER + "\r\n")
            writer = csv.writer(output, lineterminator="\r\n")
            writer.writerow([csv_cell(cell) for cell in draft["columns"]])
            for position in positions:
                writer.writerow([csv_cell(cell) for cell in draft["records"][position]["cells"]])
            content = output.getvalue()
            if len(content.encode("utf-8")) > MAX_EXPORT_TEXT:
                raise LibraryError("This unresolved export exceeds 12 MB. Import a smaller source file.")
            self._context(body, draft, expected_library=self.studio.library)
            return {"text": content, "count": len(positions), "filename": f"tagcast-unresolved-{len(positions)}.csv"}

    def search(self, body):
        with self.lock:
            draft = self._draft(body, ("matched",))
            query, offset = body.get("query"), self._page(body)
            if not isinstance(query, str) or len(query) > 200:
                raise LibraryError("Search with up to 200 characters.")
            catalogue = self._index(draft["library"])
            ids, total = catalogue.search(query, offset)
            response = {"tracks": [catalogue.row(i) for i in ids], "total": total, "offset": offset}
            self._context(body, draft)
            return response

    def choose(self, body):
        with self.lock:
            draft = self._draft(body, ("matched",))
            position, track_id, skip = body.get("position"), body.get("track_id"), body.get("skip", False)
            if type(position) is not int or not 0 <= position < len(draft["rows"]) or type(skip) is not bool:
                raise LibraryError("Choose an existing CSV record.")
            catalogue = self._index(draft["library"])
            if not skip and (type(track_id) not in (int, str) or len(str(track_id)) > 32 or not str(track_id).isascii() or not str(track_id).isdigit() or int(track_id) not in catalogue.members):
                raise LibraryError("Choose an active library track or explicitly skip this record.")
            row = draft["rows"][position]
            row.pop("resume_warning", None)
            row.pop("previous_choice", None)
            row.update(choice=None if skip else int(track_id), status="skipped" if skip else "manual",
                       signature=None if skip else catalogue.signature(int(track_id)))
            draft["revision"] += 1
            return self._view(draft, body)

    def review(self, body):
        with self.lock:
            draft = self._draft(body, ("matched",))
            name, description = body.get("name"), body.get("description", "")
            if not isinstance(name, str) or not name.strip() or len(name) > 200 or not isinstance(description, str) or len(description) > 2000:
                raise LibraryError("Enter a playlist name of 1–200 characters and description up to 2,000.")
            summary = self._summary(draft)
            omit_unresolved = body.get("omit_unresolved", False)
            if type(omit_unresolved) is not bool:
                raise LibraryError("Choose whether to leave unresolved CSV records out of the playlist.")
            if summary["unresolved"] and not omit_unresolved:
                raise LibraryError("Resolve or skip the remaining CSV records, or explicitly continue with only the selected matches.")
            if not summary["unique"]:
                raise LibraryError("Choose at least one track to create a playlist.")
            draft.update(phase="review", revision=draft["revision"] + 1,
                         review={"token": secrets.token_hex(16), "name": name.strip(), "description": description.strip(),
                                 "omitted_unresolved": summary["unresolved"] if omit_unresolved else 0,
                                 "tracks": list(dict.fromkeys(r["choice"] for r in draft["rows"] if r["choice"]))})
            return self._review_view(draft, {})

    def _review_view(self, draft, body):
        review = draft.get("review")
        if not review:
            raise LibraryError("Prepare the final playlist review first.")
        offset = self._page(body)
        catalogue = self._index(draft["library"])
        return {"id": draft["id"], "revision": draft["revision"], "phase": draft["phase"], "review_token": review["token"],
                "name": review["name"], "description": review["description"], "summary": self._summary(draft),
                "omitted_unresolved": review["omitted_unresolved"],
                "total": len(review["tracks"]), "offset": offset,
                "tracks": [catalogue.row(i) for i in review["tracks"][offset:offset + PAGE]]}

    def revise(self, body):
        with self.lock:
            draft = self._draft(body, ("review",))
            draft.update(phase="matched", revision=draft["revision"] + 1, review=None)
            return self._view(draft, body)

    def discard(self, body):
        with self.lock:
            if not isinstance(body.get("id"), str):
                raise LibraryError("Choose a valid CSV import.")
            draft = self.drafts.get(body["id"])
            if draft:
                self._context(body, draft, expected_library=self.studio.library)
                del self.drafts[draft["id"]]
                if not self.drafts:
                    self.catalogue = None
            return {"discarded": True}

    def save(self, body):
        studio = self.studio
        if body.get("approved") is not True:
            raise LibraryError("Review and explicitly confirm the imported playlist first.")
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            with self.lock:
                draft = self._draft(body, ("review",))
                client = draft["client"]
                review = draft["review"]
                if body.get("review_token") != review["token"]:
                    raise ConflictError("The playlist review changed. Review it again.")
                fresh, _ = studio._current(client)
                # Our own fresh read can publish a newer library copy. Validate
                # every chosen identity below, allowing unrelated remote edits.
                self._context(body, draft, expected_library=fresh)
                catalogue = self._index(fresh)
                if not set(review["tracks"]).issubset(catalogue.members):
                    raise ConflictError("A chosen track disappeared. Match the CSV again.")
                albums = {catalogue.members[r["choice"]][0] for r in draft["rows"] if r["choice"]}
                active = {a: set(fresh.active_track_ids(a)) if a in fresh.albums and not fresh.albums[a].get("trashed") else set() for a in albums}
                if any(r["choice"] and (r["choice"] not in active[catalogue.members[r["choice"]][0]]
                                       or catalogue.signature(r["choice"]) != r["signature"]) for r in draft["rows"]):
                    raise ConflictError("A chosen track changed or disappeared. Match the CSV again.")
                self._context(body, draft, expected_library=fresh)
                # Consume before sending: an ambiguous creation must never be repeated.
                self._checkpoint_state(draft, state="submitted")
                draft["phase"] = "uncertain"
                result = client._jsonrequest("createplaylist", name=review["name"], description=review["description"],
                                             make_public=False, tracks=review["tracks"])
                playlist_id = number(result.get("playlist_id"))
                if playlist_id <= 0 or playlist_id in fresh.playlists:
                    raise LibraryError("The new playlist ID was not confirmed. Check Playlists before importing again.")
                self._checkpoint_state(draft, playlist=playlist_id)

                def check(after):
                    row = after.playlists.get(playlist_id, {})
                    matches = studio.collections.editable(row) and text(row.get("name")) == review["name"] \
                        and text(row.get("description")) == review["description"] and row.get("tracks") == review["tracks"]
                    if matches and draft.get("checkpoint"):
                        with self.lock:
                            try:
                                self._checkpoint_state(draft, remove=True)
                            except LibraryError:
                                pass  # The playlist is confirmed; a retained checkpoint still cannot resend.
                    return [{"id": str(playlist_id), "status": "saved" if matches else "unverified"}]

                job = studio._check_later(client, studio.downloads, check, include_albums=False)
                draft["phase"] = "sent"
                return {"id": str(playlist_id), "job": job}
        finally:
            studio.save_lock.release()
