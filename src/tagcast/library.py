"""Decode an iBroadcast library and turn reviewed edits into safe write requests.

Write modes (update_album, update_track, create_artist) follow the official web
player's iBroadcastLibraryEditor.js, inspected on 2026-10-04. They are not in the
public API reference, so every save is checked against fresh data first and
read back afterwards.

The browser works with a small "view" of each album and track (artist names,
plain numbers). The server compares the browser's "before" values with that same
view built from a freshly downloaded library, so a conflict is detected no matter
where the other edit came from.
"""

import unicodedata
from collections import OrderedDict
from collections.abc import Mapping
from threading import Lock

ARTWORK_SERVER = "https://artwork.ibroadcast.com"
FORMATS = {"audio/flac": "FLAC", "audio/x-flac": "FLAC", "audio/mpeg": "MP3", "audio/mp3": "MP3",
           "audio/mp4": "AAC/ALAC", "audio/x-m4a": "AAC/ALAC", "audio/m4a": "AAC/ALAC", "audio/aac": "AAC",
           "audio/ogg": "Ogg", "audio/x-ms-wma": "WMA", "audio/wav": "WAV", "audio/x-wav": "WAV",
           "audio/aiff": "AIFF", "audio/x-aiff": "AIFF", "audio/x-ape": "APE", "audio/ape": "APE"}

VIEW_FIELDS = {
    "album": ("name", "artist", "year", "disc"),
    "track": ("title", "artist", "year", "genre", "genres", "composers", "track"),
}
MAX_GENRES = 20
NUMBER_FIELDS = {"year", "disc", "track"}
REQUIRED_TEXT = {"name", "title", "artist"}
MAX_CHANGES = 2000
MAX_IDS_PER_REQUEST = 500
MAX_TRACK_RESULTS = 1000


class LibraryError(ValueError):
    pass


class ConflictError(LibraryError):
    pass


class Record(Mapping):
    """One library row, read through the table's field map. Rows stay compact lists."""

    __slots__ = ("_fields", "_row")

    def __init__(self, row, fields):
        self._row, self._fields = row, fields

    def __getitem__(self, key):
        if self._fields is None:
            return self._row[key]
        index = self._fields[key]
        if index >= len(self._row):
            raise KeyError(key)
        return self._row[index]

    def __iter__(self):
        if self._fields is None:
            return iter(self._row)
        return (k for k, i in self._fields.items() if i < len(self._row))

    def __len__(self):
        return sum(1 for _ in self)


class Table(Mapping):
    """ID -> Record for one iBroadcast table ({"map": {field: index}, "<id>": [values]})."""

    def __init__(self, rows, fields, nested=None):
        self.rows, self.fields = rows, fields
        self.nested = nested or {}  # maps for list fields, e.g. artists_additional_map

    def __getitem__(self, key):
        return Record(self.rows[key], None if isinstance(self.rows[key], dict) else self.fields)

    def __iter__(self):
        return iter(self.rows)

    def __len__(self):
        return len(self.rows)

    def raw(self):
        """The table in iBroadcast's own format, for the disk cache."""
        return {"map": {**self.fields, **self.nested}, **{str(k): v for k, v in self.rows.items()}}


def decode_table(table):
    if not isinstance(table, dict):
        raise LibraryError("Invalid library table.")
    mapping = table.get("map") or {}
    fields = {name: index for name, index in mapping.items()
              if isinstance(index, int) and not isinstance(index, bool) and index >= 0}
    nested = {name: value for name, value in mapping.items() if isinstance(value, dict)}
    rows = {}
    for key, row in table.items():
        if not str(key).isdigit():
            continue
        if isinstance(row, dict) or (isinstance(row, list) and fields):
            rows[int(key)] = row
        else:
            raise LibraryError("Unrecognized library format.")
    return Table(rows, fields, nested)


ADDITIONAL_MAP = {"artist_id": 0, "phrase": 1, "type": 2}


def additional_artists(track, mapping=None):
    """A track's extra artists as [{"artist_id", "phrase", "type"}]: composers, featured…"""
    mapping = mapping or ADDITIONAL_MAP
    out = []
    for entry in track.get("artists_additional") or []:
        if isinstance(entry, dict):
            item = {k: entry.get(k) for k in ("artist_id", "phrase", "type")}
        elif isinstance(entry, list):
            item = {k: entry[i] if isinstance(i, int) and i < len(entry) else None
                    for k, i in mapping.items() if k in ("artist_id", "phrase", "type")}
        else:
            continue
        if number(item.get("artist_id")):
            item["artist_id"] = number(item["artist_id"])
            out.append(item)
    return out


def title_key(value):
    """A track title for comparing: case and spacing don't count."""
    return " ".join(text(value).casefold().split())


def fold(value):
    """Text for searching: case, accents and spacing don't count ("Björk" finds "bjork")."""
    value = text(value)
    if not value.isascii():
        value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))
    return " ".join(value.casefold().split())


def stored_genres(track):
    """A track's genres as iBroadcast keeps them: the main genre, then genres_additional.

    A tag like "Pop;Rock" uploaded as one text stays one genre here, so the editor can
    show it and offer to split it.
    """
    main = text(track.get("genre")).strip()
    extra = track.get("genres_additional") if isinstance(track.get("genres_additional"), list) else []
    out = [main] if main else []
    for genre in extra:
        genre = text(genre).strip()
        if genre and genre.casefold() not in {g.casefold() for g in out}:
            out.append(genre)
    return out


def number(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


def text(value):
    return "" if value is None else str(value)


class Library:
    def __init__(self, response):
        raw = response.get("library", response) if isinstance(response, dict) else None
        if not isinstance(raw, dict) or not all(k in raw for k in ("tracks", "albums", "artists")):
            raise LibraryError("iBroadcast did not return a complete library.")
        self.artists = decode_table(raw["artists"])
        self.albums = decode_table(raw["albums"])
        self.tracks = decode_table(raw["tracks"])
        settings = response.get("settings") if isinstance(response.get("settings"), dict) else {}
        self.artwork_server = str(settings.get("artwork_server") or ARTWORK_SERVER).rstrip("/")
        status = response.get("status") if isinstance(response.get("status"), dict) else {}
        # iBroadcast bumps lastmodified on every library change; "" means unknown.
        self.lastmodified = text(status.get("lastmodified"))
        self.expires = text(raw.get("expires"))  # signs streaming URLs
        # iBroadcast merges the discs of a set into one album while "Combine Multi-Disc
        # Album Sets" is on, so a copy is only valid for the setting it was downloaded with.
        self.combine_sets = response.get("combine_sets")
        playlists = raw.get("playlists") if isinstance(raw.get("playlists"), dict) else None
        counts = response.get("counts") if isinstance(response.get("counts"), dict) else {}
        self.playlist_count = (sum(1 for k in playlists if str(k).isdigit()) if playlists is not None
                               else counts.get("playlists"))  # None: unknown (older cache)
        self._stats = None
        self._search = None
        self._favourites = None
        self._browse_tracks = None
        self._browse_albums = {}
        self._browse_indexes = {}
        self._browse_lock = Lock()

    def to_cache(self):
        """Only what Tagcast needs: no account details or third-party session keys."""
        return {
            "library": {"tracks": self.tracks.raw(), "albums": self.albums.raw(),
                        "artists": self.artists.raw(), "expires": self.expires},
            "settings": {"artwork_server": self.artwork_server},
            "status": {"lastmodified": self.lastmodified},
            "counts": {"playlists": self.playlist_count},
            "combine_sets": self.combine_sets,
        }

    # -- reading -------------------------------------------------------------

    def art_url(self, artwork_id, size=300):
        artwork_id = number(artwork_id)
        return f"{self.artwork_server}/artwork/{artwork_id}-{size}" if artwork_id else ""

    def artist_image(self, artist_id):
        return self.art_url(self.artists.get(number(artist_id), {}).get("artwork_id"), 150)

    def artist_name(self, artist_id):
        artist_id = number(artist_id)
        if artist_id == 0:
            return "Various Artists"
        return text(self.artists.get(artist_id, {}).get("name")) or "Unknown artist"

    def active_track_ids(self, album_id):
        album = self.albums.get(album_id, {})
        ids = [number(i) for i in album.get("tracks") or []]
        return [i for i in ids if i in self.tracks and not self.tracks[i].get("trashed")]

    def active_track_album(self, track_id):
        """Resolve the displayed album, including iBroadcast's combined multi-disc view."""
        track = self.tracks.get(track_id)
        if track and not track.get("trashed"):
            original = number(track.get("album_id"))
            album = self.albums.get(original)
            if album and not album.get("trashed") and track_id in self.active_track_ids(original):
                return original
            for album_id, album in self.albums.items():
                if not album.get("trashed") and track_id in self.active_track_ids(album_id):
                    return album_id
        raise LibraryError("This track is no longer available. Reload the library.")

    def album_ids(self):
        return [i for i, a in self.albums.items()
                if not a.get("trashed") and self.active_track_ids(i)]

    def extra_artists(self, track):
        return additional_artists(track, self.tracks.nested.get("artists_additional_map"))

    def composer_entries(self, track):
        return [e for e in self.extra_artists(track) if e.get("type") == "composer"]

    def album_artwork(self, track_ids):
        """The cover iBroadcast shows: the artwork of the first track (by number) that has one."""
        best = None
        for track_id in track_ids:
            track = self.tracks[track_id]
            artwork = number(track.get("artwork_id"))
            if artwork:
                key = (number(track.get("track")) or 9999, track_id)
                if best is None or key < best[0]:
                    best = (key, artwork)
        return best[1] if best else 0

    def album_view(self, album_id):
        album = self.albums.get(album_id)
        if not album or album.get("trashed"):
            raise LibraryError("This album is no longer available. Reload the library.")
        track_ids = self.active_track_ids(album_id)
        tracks = [self.track_view(t) for t in track_ids]
        tracks.sort(key=lambda t: (t["track"] or 9999, t["title"].lower()))
        artwork = self.album_artwork(track_ids)
        return {
            "id": str(album_id),
            "name": text(album.get("name")) or "Untitled album",
            "artist": self.artist_name(album.get("artist_id")),
            "artist_id": number(album.get("artist_id")),
            "year": number(album.get("year")),
            "disc": number(album.get("disc")),
            "artwork": self.art_url(artwork),
            "artwork_id": artwork,
            "artist_image": self.artist_image(album.get("artist_id")),
            "artist_artwork_id": number(self.artists.get(number(album.get("artist_id")), {})
                                        .get("artwork_id")),
            "tracks": tracks,
        }

    def track_view(self, track_id):
        track = self.tracks.get(track_id)
        if not track or track.get("trashed"):
            raise LibraryError("This track is no longer available. Reload the library.")
        return {
            "id": str(track_id),
            "album_id": str(number(track.get("album_id"))),
            "title": text(track.get("title")) or "Untitled track",
            "artist": self.artist_name(track.get("artist_id")),
            "artist_id": number(track.get("artist_id")),
            "year": number(track.get("year")),
            "genre": text(track.get("genre")),
            "genres": stored_genres(track),
            "composers": [self.artist_name(e["artist_id"]) for e in self.composer_entries(track)],
            "composer_ids": [e["artist_id"] for e in self.composer_entries(track)],
            "track": number(track.get("track")),
            "length": number(track.get("length")),
            "artwork_id": number(track.get("artwork_id")),
            "rating": number(track.get("rating")),
        }

    def albums_view(self):
        return [self.album_view(i) for i in self.album_ids()]

    def album_summary(self, album_id):
        """A small album entry for the browser's list: no tracks, only what lists and filters use."""
        album = self.albums[album_id]
        genres, no_genre, no_cover, combined, no_composer, numbers = set(), 0, 0, 0, 0, set()
        titles = []
        track_ids = self.active_track_ids(album_id)
        for track_id in track_ids:
            track = self.tracks[track_id]
            stored = stored_genres(track)
            if stored:
                genres.update(g.strip() for genre in stored for g in genre.split(";") if g.strip())
                combined += any(";" in genre for genre in stored)
            else:
                no_genre += 1
            no_cover += not number(track.get("artwork_id"))
            no_composer += not self.composer_entries(track)
            numbers.add(number(track.get("track")))
            titles.append(title_key(track.get("title")))
        titles = [t for t in titles if t]
        return {
            "id": str(album_id),
            "name": text(album.get("name")) or "Untitled album",
            "artist": self.artist_name(album.get("artist_id")),
            "year": number(album.get("year")),
            "disc": number(album.get("disc")),
            "artwork": self.art_url(self.album_artwork(track_ids)),
            "artist_id": number(album.get("artist_id")),
            "artist_image": self.artist_image(album.get("artist_id")),
            "artist_artwork_id": number(self.artists.get(number(album.get("artist_id")), {})
                                        .get("artwork_id")),
            "track_count": len(track_ids),
            "genres": sorted(genres),
            "no_genre": no_genre,
            "no_cover": no_cover,
            "combined_genres": combined,
            "no_composer": no_composer,
            # numbers missing below the highest one, e.g. 1, 2, 5 -> 2: maybe incomplete
            "track_gaps": (max(numbers) - len(numbers - {0})) if numbers - {0} else 0,
            # tracks whose title appears twice in this album, e.g. one file uploaded twice
            "duplicates": len(titles) - len(set(titles)),
        }

    def album_index(self):
        return [self.album_summary(i) for i in self.album_ids()]

    def search_tracks(self, query, limit=MAX_TRACK_RESULTS):
        """Active tracks whose title, artist, album or composers hold every word of the query,
        in album order. The search text is worked out once per library copy."""
        words = fold(query).split()
        if not words:
            return {"tracks": [], "total": 0}
        if self._search is None:
            self._search = self._search_index()
        found = [(track_id, album_id) for haystack, track_id, album_id in self._search
                 if all(word in haystack for word in words)]
        return {"tracks": [self.track_row(*f) for f in found[:limit]], "total": len(found)}

    def _search_index(self):
        rows, names = [], {}

        def name(artist_id):  # artist names repeat a lot: fold each one once
            if artist_id not in names:
                names[artist_id] = fold(self.artist_name(artist_id))
            return names[artist_id]

        for album_id in self.album_ids():
            album = self.albums[album_id]
            title, album_artist = fold(album.get("name")), name(number(album.get("artist_id")))
            order = (album_artist, title, number(album.get("disc")), album_id)
            for track_id in self.active_track_ids(album_id):
                track = self.tracks[track_id]
                track_title = fold(track.get("title"))
                words = " ".join([track_title, name(number(track.get("artist_id"))), title, album_artist,
                                  *(name(e["artist_id"]) for e in self.composer_entries(track))])
                rows.append((order + (number(track.get("track")) or 9999, track_title, track_id),
                             words, track_id, album_id))
        rows.sort(key=lambda row: row[0])
        return [row[1:] for row in rows]

    def track_row(self, track_id, album_id):
        """One search result: the track plus the album it is on."""
        track, album = self.tracks[track_id], self.albums[album_id]
        return {
            "id": str(track_id),
            "album_id": str(album_id),
            "title": text(track.get("title")) or "Untitled track",
            "artist": self.artist_name(track.get("artist_id")),
            "composers": [self.artist_name(e["artist_id"]) for e in self.composer_entries(track)],
            "album": text(album.get("name")) or "Untitled album",
            "disc": number(album.get("disc")),
            "track": number(track.get("track")),
            "year": number(track.get("year")) or number(album.get("year")),
            "length": number(track.get("length")),
            "rating": number(track.get("rating")),
        }

    def _browse_index(self, kind):
        """Lazy ID indexes for browsing; shared track pairs stay on the server.

        Use displayed album membership, including the combined-disc view. A compound
        artist name or genre label stays one record; never guess how to split it.
        """
        with self._browse_lock:
            if kind in self._browse_indexes:
                return self._browse_indexes[kind]
            if self._browse_tracks is None:
                rows, seen = [], set()
                albums = sorted(self.album_ids(), key=lambda i: (
                    fold(self.artist_name(self.albums[i].get("artist_id"))),
                    fold(self.albums[i].get("name")), number(self.albums[i].get("disc")), i))
                # Match albumShelf/discSet: distinct discs of the same title and
                # album artist count as one album, including a match on only one disc.
                sets = {}
                for album_id in albums:
                    album = self.albums[album_id]
                    key = ((text(album.get("name")) or "Untitled album").strip().lower(),
                           self.artist_name(album.get("artist_id")))
                    sets.setdefault(key, []).append(album_id)
                for discs in sets.values():
                    merged = len({number(self.albums[i].get("disc")) for i in discs}) == len(discs)
                    for album_id in discs:
                        self._browse_albums[album_id] = discs[0] if merged else album_id
                for album_id in albums:
                    ids = sorted(self.active_track_ids(album_id), key=lambda i: (
                        number(self.tracks[i].get("track")) or 9999,
                        fold(self.tracks[i].get("title")), i))
                    for track_id in ids:
                        if track_id not in seen:
                            seen.add(track_id)
                            rows.append((track_id, album_id))
                self._browse_tracks = rows
            groups = {}
            for pair in self._browse_tracks:
                track_id, album_id = pair
                track = self.tracks[track_id]
                if kind == "track-artists":
                    keys = [str(number(track.get("artist_id")))]
                elif kind == "composers":
                    keys = list(dict.fromkeys(str(e["artist_id"]) for e in self.composer_entries(track)))
                elif kind == "genres":
                    keys = stored_genres(track)
                else:
                    year = number(track.get("year")) or number(self.albums[album_id].get("year"))
                    keys = [str(year // 10 * 10)] if kind == "decades" and year > 0 else [] if kind == "decades" else [str(year)]
                for value in keys:
                    key = value.casefold() if kind == "genres" else value
                    if key not in groups:
                        artist = kind in ("track-artists", "composers")
                        label = self.artist_name(value) if artist else f"{value}s" if kind == "decades" else "Unknown year" if value == "0" and kind == "years" else value
                        groups[key] = {"key": key, "label": label, "image": self.artist_image(value) if artist else "", "ids": []}
                    groups[key]["ids"].append(pair)
            for group in groups.values():
                group["albums"] = len({self._browse_albums[a] for _, a in group["ids"]})
            self._browse_indexes[kind] = groups
            return groups

    def browse(self, kind, key=None, query="", offset=0, limit=50, sort="az"):
        """Paginated groups, or album IDs with exact group membership.

        Release years use the track year, with the album year as fallback, as track
        search does. Missing years get their own group, sorted after known years.
        """
        if kind not in ("track-artists", "composers", "genres", "years", "decades"):
            raise LibraryError("Choose track artists, composers, genres, release years or decades.")
        groups = self._browse_index(kind)
        words = fold(query).split()
        if key is not None:
            if kind == "genres":
                key = key.casefold()
            group = groups.get(key)
            if group is None:
                raise LibraryError("This group is no longer available. Open the overview again.")
            return {"group": {k: v for k, v in group.items() if k != "ids"},
                    "album_ids": [str(i) for i in dict.fromkeys(a for _, a in group["ids"])]}
        found = [g for g in groups.values() if all(w in fold(g["label"]) for w in words)]
        if sort == "count":
            found.sort(key=lambda g: (-len(g["ids"]), fold(g["label"]), g["key"]))
        elif kind in ("years", "decades"):
            found.sort(key=lambda g: (g["key"] == "0", number(g["key"]) * (-1 if sort == "za" else 1)))
        else:
            found.sort(key=lambda g: (fold(g["label"]), g["key"]), reverse=sort == "za")
        offset = min(offset, max(0, (len(found) - 1) // limit * limit))
        return {"groups": [{"key": g["key"], "label": g["label"], "image": g["image"], "tracks": len(g["ids"]), "albums": g["albums"]}
                           for g in found[offset:offset + limit]],
                "total": len(found), "count": len(groups), "offset": offset}

    def favourites(self, query="", offset=0, limit=50):
        """iBroadcast's thumbs-up tracks (rating >= 5), without loading them all in the browser."""
        if self._favourites is None:
            rows, seen = [], set()
            liked = {i for i, t in self.tracks.items() if not t.get("trashed") and number(t.get("rating")) >= 5}
            for album_id, album in self.albums.items() if liked else []:
                if album.get("trashed"):
                    continue
                for value in album.get("tracks") or []:
                    track_id = number(value)
                    if track_id not in liked or track_id in seen:
                        continue
                    seen.add(track_id)
                    row = self.track_row(track_id, album_id)
                    haystack = fold(" ".join([row["title"], row["artist"], row["album"],
                                             self.artist_name(album.get("artist_id")), *row["composers"]]))
                    order = (fold(row["artist"]), fold(row["album"]), row["disc"],
                             row["track"] or 9999, fold(row["title"]), track_id)
                    rows.append((order, haystack, (track_id, album_id)))
            rows.sort(key=lambda item: item[0])
            self._favourites = rows
        words = fold(query).split()
        found = [row for _, haystack, row in self._favourites if all(w in haystack for w in words)]
        offset = min(offset, max(0, (len(found) - 1) // limit * limit))
        return {"tracks": [self.track_row(*ids) for ids in found[offset:offset + limit]], "total": len(found),
                "count": len(self._favourites), "offset": offset}

    def stats(self, top=10):
        """Numbers for the overview, worked out once per library copy."""
        if self._stats is None:
            self._stats = self._compute_stats(top)
        return self._stats

    def _compute_stats(self, top):
        tracks = {i: t for i, t in self.tracks.items() if not t.get("trashed")}
        album_ids = self.album_ids()
        size = length = no_genre = combined = no_art = rated = plays = 0
        formats, uploads, track_plays, album_plays, artist_plays = {}, {}, [], {}, {}
        for track_id, track in tracks.items():
            size += number(track.get("size"))
            length += number(track.get("length"))
            stored = stored_genres(track)
            no_genre += not stored
            combined += any(";" in genre for genre in stored)
            no_art += not number(track.get("artwork_id"))
            rated += number(track.get("rating")) > 0
            fmt = FORMATS.get(text(track.get("type")).lower()) or (text(track.get("type")).split("/")[-1].upper() or "Unknown")
            entry = formats.setdefault(fmt, [0, 0])
            entry[0] += 1
            entry[1] += number(track.get("size"))
            year = text(track.get("uploaded_on"))[:4]
            if year.isdigit():
                uploads[year] = uploads.get(year, 0) + 1
            count = number(track.get("plays"))
            if count:
                plays += count
                track_plays.append((count, track_id))
                album = number(track.get("album_id"))
                album_plays[album] = album_plays.get(album, 0) + count
                artist = number(track.get("artist_id"))
                artist_plays[artist] = artist_plays.get(artist, 0) + count

        album_artists = {number(self.albums[a].get("artist_id")) for a in album_ids} - {0}
        no_year = sum(1 for a in album_ids if not number(self.albums[a].get("year")))
        no_image = sum(1 for a in album_artists if not number(self.artists.get(a, {}).get("artwork_id")))

        def track_row(count, track_id):
            track = tracks[track_id]
            album_id = number(track.get("album_id"))
            return {"plays": count, "title": text(track.get("title")) or "Untitled track",
                    "artist": self.artist_name(track.get("artist_id")), "album_id": str(album_id),
                    "album": text(self.albums.get(album_id, {}).get("name"))}

        return {
            "tracks": len(tracks), "albums": len(album_ids), "album_artists": len(album_artists),
            "track_artists": len({number(t.get("artist_id")) for t in tracks.values()}),
            "playlists": self.playlist_count, "size": size, "length": length,
            "plays": plays, "rated": rated,
            "formats": sorted(({"name": k, "tracks": v[0], "size": v[1]} for k, v in formats.items()),
                              key=lambda f: -f["tracks"]),
            "uploads": [{"year": y, "tracks": uploads.get(str(y), 0)}  # empty years count too
                        for y in range(min(map(int, uploads), default=0), max(map(int, uploads), default=-1) + 1)],
            "health": {
                "genre": {"missing": no_genre, "total": len(tracks)},
                "combined": {"missing": combined, "total": len(tracks)},
                "year": {"missing": no_year, "total": len(album_ids)},
                "artist_image": {"missing": no_image, "total": len(album_artists)},
                "cover": {"missing": no_art, "total": len(tracks)},
            },
            "top_tracks": [track_row(c, t) for c, t in sorted(track_plays, reverse=True)[:top]],
            "top_albums": [{"plays": c, "album_id": str(a), "album": text(self.albums.get(a, {}).get("name")),
                            "artist": self.artist_name(self.albums.get(a, {}).get("artist_id"))}
                           for a, c in sorted(album_plays.items(), key=lambda x: -x[1])[:top]
                           if a in self.albums],
            "top_artists": [{"plays": c, "artist": self.artist_name(a)}
                            for a, c in sorted(artist_plays.items(), key=lambda x: -x[1])[:top]],
        }

    def artist_names(self):
        return sorted({text(a.get("name")) for a in self.artists.values() if text(a.get("name"))},
                      key=str.casefold)

    def find_artist(self, name):
        """Return the ID of an existing artist with this name, or None."""
        wanted = name.strip()
        exact = [i for i, a in self.artists.items() if text(a.get("name")).strip() == wanted]
        if exact:
            return min(exact)
        folded = [i for i, a in self.artists.items()
                  if text(a.get("name")).strip().casefold() == wanted.casefold()]
        if len(folded) == 1:
            return folded[0]
        if wanted == "Various Artists" and not folded:
            return 0
        return None

    def album_art_state(self, album_id):
        """{track_id: artwork_id} for the album's active tracks; raises if the album is gone."""
        album = self.albums.get(album_id)
        if not album or album.get("trashed"):
            raise LibraryError("This album is no longer available. Reload the library.")
        return {t: number(self.tracks[t].get("artwork_id")) for t in self.active_track_ids(album_id)}

    def artist_art(self, artist_id):
        # iBroadcast marks an artist "trashed" when no track is credited to it, which is
        # normal for an album artist like a duo whose tracks name its members.
        artist = self.artists.get(artist_id)
        if not artist:
            raise LibraryError("This artist is no longer available. Reload the library.")
        return number(artist.get("artwork_id"))

    def first_track_of_artist(self, artist_id):
        """A track on one of the artist's own albums, else any track by them, else 0."""
        for album_id in self.album_ids():
            if number(self.albums[album_id].get("artist_id")) == artist_id:
                return self.active_track_ids(album_id)[0]
        return next((i for i, t in self.tracks.items()
                     if number(t.get("artist_id")) == artist_id and not t.get("trashed")), 0)

    def stream_info(self, track_id):
        track = self.tracks.get(track_id)
        if not track or track.get("trashed") or not text(track.get("file")).startswith("/"):
            raise LibraryError("This track can't be played. Reload the library.")
        return text(track.get("file")), text(track.get("type"))

    def current(self, kind, item_id):
        return self.album_view(item_id) if kind == "album" else self.track_view(item_id)


# -- planning ----------------------------------------------------------------

def _clean_id(value):
    if isinstance(value, bool):
        raise LibraryError("Invalid item ID.")
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit() and int(value) > 0:
        return int(value)
    raise LibraryError("Invalid item ID.")


def _clean_value(key, value):
    if key in NUMBER_FIELDS:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 9999:
            raise LibraryError(f"{key} must be a whole number from 0 to 9999.")
        return value
    if key in ("genres", "composers"):
        if not isinstance(value, list) or len(value) > MAX_GENRES:
            raise LibraryError(f"{key.title()} must be a list of at most {MAX_GENRES}.")
        out = []
        for genre in value:
            if not isinstance(genre, str) or len(genre.strip()) > 100:
                raise LibraryError(f"Each of the {key} must be text of at most 100 characters.")
            genre = genre.strip()
            if genre and genre.casefold() not in {g.casefold() for g in out}:
                out.append(genre)
        return out
    if not isinstance(value, str) or len(value) > 1000:
        raise LibraryError(f"{key} must be text of at most 1,000 characters.")
    value = value.strip()
    if key in REQUIRED_TEXT and not value:
        raise LibraryError("Titles and artist names cannot be empty.")
    return value


def plan_save(library, changes):
    """Validate reviewed changes against a freshly downloaded library.

    Each change is {"kind", "id", "albumId", "label", "fields": {key: {"before", "after"}}}
    as produced by the browser. Raises ConflictError when a "before" value no longer
    matches iBroadcast, so nothing is written on top of somebody else's edit.
    """
    if not isinstance(changes, list) or not changes:
        raise LibraryError("There are no changes to save.")
    if len(changes) > MAX_CHANGES:
        raise LibraryError(f"Save at most {MAX_CHANGES:,} records at a time.")

    items, seen, album_artists, conflicts = [], set(), set(), []
    for change in changes:
        if not isinstance(change, dict):
            raise LibraryError("Invalid change.")
        kind = change.get("kind")
        if kind not in VIEW_FIELDS:
            raise LibraryError("Only album and track metadata can be saved.")
        item_id = _clean_id(change.get("id"))
        if (kind, item_id) in seen:
            raise LibraryError("The same item was included more than once.")
        seen.add((kind, item_id))
        fields = change.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise LibraryError("A change has no fields.")
        if not set(fields) <= set(VIEW_FIELDS[kind]):
            raise LibraryError("Only supported metadata fields can be saved.")

        try:
            now = library.current(kind, item_id)
        except LibraryError:
            raise ConflictError(f"{change.get('label') or kind} is no longer in your library. "
                                "Reload and review again.") from None
        album_id = item_id if kind == "album" else number(now["album_id"])
        if kind == "track" and change.get("albumId") is not None \
                and _clean_id(change.get("albumId")) != album_id:
            raise ConflictError(f"Track “{now['title']}” moved to another album. "
                                "Reload and review again.")
        album_artists.add(number(library.albums.get(album_id, {}).get("artist_id")))

        patch = {}
        for key, values in fields.items():
            if not isinstance(values, dict) or "after" not in values or "before" not in values:
                raise LibraryError("Every field needs a before and after value.")
            after = _clean_value(key, values["after"])
            before = values["before"]
            if now[key] == after:
                continue  # already has this value
            if now[key] != before:
                label = now.get("name") or now.get("title")
                conflicts.append(f"{label}: {key} is now “{now[key]}”")
                continue
            patch[key] = after
        if patch:
            item = {"kind": kind, "id": item_id, "album_id": album_id,
                    "label": now.get("name") or now.get("title"), "patch": patch}
            if "composers" in patch:  # other extra artists (featured, ...) stay as they are
                item["keep"] = [e for e in library.extra_artists(library.tracks[item_id])
                                if e.get("type") != "composer"]
            items.append(item)

    if len(album_artists) > 1:
        raise LibraryError("A save must stay within one album or one album artist.")
    if conflicts:
        shown = "; ".join(conflicts[:3]) + (" …" if len(conflicts) > 3 else "")
        raise ConflictError(f"Changed in iBroadcast since you loaded it ({shown}). "
                            "Reload the library and review again.")

    names = OrderedDict()
    for item in items:
        for name in ([item["patch"]["artist"]] if "artist" in item["patch"] else []) \
                + item["patch"].get("composers", []):
            names.setdefault(name, library.find_artist(name))
    return {
        "items": items,
        "artists": {name: artist_id for name, artist_id in names.items() if artist_id is not None},
        "new_artists": [name for name, artist_id in names.items() if artist_id is None],
    }


def _wire(kind, patch, artist_ids, keep=None):
    """Translate view fields to the field names and types the web editor sends."""
    out = {}
    for key, value in patch.items():
        if key == "artist":
            if value not in artist_ids:
                raise LibraryError(f"No artist ID for “{value}”.")
            out["artist_id"] = artist_ids[value]
        elif key == "track":
            out["track_no"] = value
        elif key in ("year", "disc"):
            out[key] = str(value)  # the web editor sends input values as strings
        elif key == "composers":  # composers next to the extra artists that stay
            missing = [n for n in value if n not in artist_ids]
            if missing:
                raise LibraryError(f"No artist ID for “{missing[0]}”.")
            kept = [{k: v for k, v in e.items() if v is not None} for e in keep or []]
            out["artists_additional"] = kept + [{"artist_id": artist_ids[n], "type": "composer"}
                                                for n in value]
        elif key == "genres":  # the main genre, then the rest, as the web editor sends them
            out["genre"] = value[0] if value else ""
            out["genres_additional"] = list(value[1:])
        else:
            out[key] = value
    return out


def write_requests(plan, artist_ids):
    """Group identical patches, like the web editor does, into update requests."""
    groups = OrderedDict()
    for item in plan["items"]:
        wire = _wire(item["kind"], item["patch"], artist_ids, item.get("keep"))
        key = (item["kind"], tuple(sorted((k, repr(v)) for k, v in wire.items())))
        groups.setdefault(key, (item["kind"], wire, []))[2].append(item["id"])
    requests = []
    for kind, wire, ids in groups.values():
        id_key, mode, table = (("album_id", "update_album", "albums") if kind == "album"
                               else ("file_id", "update_track", "tracks"))
        for start in range(0, len(ids), MAX_IDS_PER_REQUEST):
            rows = [{id_key: i, **wire} for i in ids[start:start + MAX_IDS_PER_REQUEST]]
            requests.append((mode, {table: rows}))
    return requests


def _matches(now, key, value, artist_ids):
    if key == "artist" and value in artist_ids:
        return now["artist_id"] == artist_ids[value]
    if key == "composers":
        return now["composer_ids"] == [artist_ids.get(n) for n in value]
    return now[key] == value


def verify(library, plan, artist_ids, failed=None):
    """Read every planned change back from a fresh library.

    ``failed`` maps (kind, id) to "failed" (request rejected) or "not_sent".
    """
    results = []
    failed = failed or {}
    for item in plan["items"]:
        entry = {"kind": item["kind"], "id": str(item["id"]), "label": item["label"],
                 "fields": sorted(item["patch"])}
        if (item["kind"], item["id"]) in failed:
            entry["status"] = failed[(item["kind"], item["id"])]
        else:
            try:
                now = library.current(item["kind"], item["id"])
                ok = all(_matches(now, k, v, artist_ids) for k, v in item["patch"].items())
                entry["status"] = "saved" if ok else "unverified"
            except LibraryError:
                entry["status"] = "unverified"
        results.append(entry)
    return results
