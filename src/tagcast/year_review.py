"""Explicit, read-only album/track year comparisons; edits use the normal editor."""

import re
import secrets
import threading
import weakref
from collections import Counter, defaultdict

from .library import ConflictError, LibraryError, number, text

CATEGORIES = {"differences", "different", "mixed", "missing-tracks", "missing-album", "unknown", "invalid"}


def known_year(value):
    return type(value) is int and 1800 <= value <= 2050


def stored_year(value):
    """Accept native numeric strings without truncating fractional or malformed years."""
    if value is None or value == "":
        return 0, False
    parsed = int(value.strip()) if isinstance(value, str) and re.fullmatch(r"[0-9]{1,4}", value.strip()) else value
    return number(value), not (type(parsed) is int and (parsed == 0 or known_year(parsed)))


def year_category(album_year, counts, invalid=False):
    known = {year for year in counts if known_year(year)}
    if invalid or (album_year != 0 and not known_year(album_year)):
        return "invalid"
    if not album_year:
        return "missing-album" if known else "unknown"
    if len(known) > 1:
        return "mixed"
    if known and known != {album_year}:
        return "different"
    return "missing-tracks" if counts.get(0) else "consistent"


def compare_years(library):
    """Use the same conservative disc-set key as albumShelf; never infer release years."""
    sets, groups = defaultdict(list), []
    for album_id in library.album_ids():
        sets[library.album_set_key(album_id)].append(album_id)
    for ids in sets.values():
        ids.sort(key=lambda i: (number(library.albums[i].get("disc")), i))
        if len({number(library.albums[i].get("disc")) for i in ids}) == len(ids):
            groups.append(ids)
        else:
            groups.extend([i] for i in ids)
    rows, categories = [], Counter()
    stats = {"albums": len(groups), "discs": sum(map(len, groups)), "tracks": 0,
             "different_tracks": 0, "missing_track_years": 0}
    for ids in groups:
        first = library.albums[ids[0]]
        album_year = number(first.get("year"))
        track_ids = list(dict.fromkeys(t for i in ids for t in library.active_track_ids(i)))
        counts, invalid = Counter(), False
        for track_id in track_ids:
            raw = library.tracks[track_id].get("year")
            year, bad = stored_year(raw)
            invalid |= bad
            counts[year] += 1
        invalid |= any(stored_year(library.albums[i].get("year"))[1] for i in ids)
        category = year_category(album_year, counts, invalid)
        categories[category] += 1
        stats["tracks"] += len(track_ids)
        if known_year(album_year):
            stats["different_tracks"] += sum(n for y, n in counts.items() if known_year(y) and y != album_year)
            stats["missing_track_years"] += counts[0]
        if category == "consistent":
            continue
        rows.append({"id": str(ids[0]), "ids": [str(i) for i in ids],
                     "album": text(first.get("name")) or "Untitled album",
                     "artist": " · ".join(library.artist_name(i) for i in library.album_artist_ids(first)),
                     "album_year": album_year, "discs": len(ids), "disc": number(first.get("disc")),
                     "tracks": len(track_ids), "category": category,
                     "track_years": [{"year": y, "count": n} for y, n in sorted(counts.items())],
                     "bounded": len(ids) <= 20 and len(track_ids) <= 500})
    rows.sort(key=lambda r: (r["artist"].casefold(), r["album"].casefold(), r["disc"], r["id"]))
    return rows, {**stats, "categories": dict(categories)}


class YearReview:
    def __init__(self, studio):
        self.studio, self.lock, self.data = studio, threading.Lock(), None

    def _scope(self):
        # Unlike _library(), this cannot start a download. Opening/analysing only
        # uses the already loaded account/session-bound library.
        s = self.studio
        with s.lock:
            if s.client is None or s.library is None:
                raise LibraryError("Connect iBroadcast and load your library first.")
            if s.library.combine_sets != s.combine_sets:
                raise ConflictError("The combine setting changed. Reload the library and analyse again.")
            return s.library, (id(s.client), s.library_user, s.playback_session, s.combine_sets)

    def _bound(self, report_id):
        library, scope = self._scope()
        if not self.data or self.data["library"]() is not library or scope != self.data["scope"]:
            self.data = None
            raise ConflictError("The loaded library or account changed. Analyse years again.")
        if report_id != self.data["id"]:
            raise ConflictError("A newer year analysis is available. Analyse years again.")
        return library

    def analyse(self):
        with self.lock:
            library, scope = self._scope()
            rows, stats = compare_years(library)
            current, current_scope = self._scope()
            if current is not library or scope != current_scope:
                raise ConflictError("The loaded library or account changed. Analyse years again.")
            self.data = {"id": secrets.token_urlsafe(18), "library": weakref.ref(library),
                         "scope": scope, "rows": rows, "stats": stats}
            return self._view()

    def view(self, report_id, query="", category="differences", offset="0"):
        with self.lock:
            self._bound(report_id)
            return self._view(query, category, offset)

    def _view(self, query="", category="differences", offset="0"):
        query = str(query or "").strip()
        if len(query) > 200 or category not in CATEGORIES:
            raise LibraryError("Choose a year category and a search of at most 200 characters.")
        try:
            offset = max(0, int(offset))
        except (ValueError, TypeError):
            raise LibraryError("Choose a valid page.") from None
        words = query.casefold().split()
        rows = [r for r in self.data["rows"]
                if (r["category"] != "unknown" if category == "differences" else r["category"] == category)
                and all(word in f'{r["artist"]} {r["album"]} {r["album_year"]} '
                        f'{" ".join(str(y["year"]) for y in r["track_years"])}'.casefold() for word in words)]
        offset = min(offset, max(0, (len(rows) - 1) // 25 * 25))
        return {"id": self.data["id"], "stats": self.data["stats"], "rows": rows[offset:offset + 25],
                "total": len(rows), "offset": offset, "limit": 25,
                "combine_sets": self.data["scope"][3]}

    def choice(self, body):
        """Prepare bounded details only. This endpoint cannot save or modify a draft."""
        with self.lock:
            library = self._bound(body.get("id"))
            row = next((r for r in self.data["rows"] if r["id"] == body.get("album")), None)
            direction, year = body.get("direction"), body.get("year")
            if not row or not row["bounded"] or row["category"] == "invalid":
                raise LibraryError("Open this album manually; year review supports up to 20 discs / 500 tracks.")
            if direction == "album-to-tracks":
                if not known_year(row["album_year"]):
                    raise LibraryError("Choose a known album year; missing years are never copied automatically.")
                year = row["album_year"]
            elif direction in {"tracks-to-album", "tracks-to-album-and-tracks"}:
                if self.data["scope"][3]:
                    raise LibraryError("Turn off Combine Multi-Disc Album Sets in iBroadcast before album edits.")
                if not known_year(year) or year not in {y["year"] for y in row["track_years"]}:
                    raise LibraryError("Explicitly choose one of this album's known track years.")
            else:
                raise LibraryError("Choose which direction to apply the year.")
            albums = [library.album_view(int(i)) for i in row["ids"]]
            self._bound(body.get("id"))
            return {"albums": albums, "direction": direction, "year": year}
