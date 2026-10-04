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

from collections import OrderedDict
from collections.abc import Mapping

ARTWORK_SERVER = "https://artwork.ibroadcast.com"

VIEW_FIELDS = {
    "album": ("name", "artist", "year", "disc"),
    "track": ("title", "artist", "year", "genre", "track"),
}
NUMBER_FIELDS = {"year", "disc", "track"}
REQUIRED_TEXT = {"name", "title", "artist"}
MAX_CHANGES = 2000
MAX_IDS_PER_REQUEST = 500


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

    def __init__(self, rows, fields):
        self.rows, self.fields = rows, fields

    def __getitem__(self, key):
        return Record(self.rows[key], None if isinstance(self.rows[key], dict) else self.fields)

    def __iter__(self):
        return iter(self.rows)

    def __len__(self):
        return len(self.rows)

    def raw(self):
        """The table in iBroadcast's own format, for the disk cache."""
        return {"map": dict(self.fields), **{str(k): v for k, v in self.rows.items()}}


def decode_table(table):
    if not isinstance(table, dict):
        raise LibraryError("Invalid library table.")
    mapping = table.get("map") or {}
    fields = {name: index for name, index in mapping.items()
              if isinstance(index, int) and not isinstance(index, bool) and index >= 0}
    rows = {}
    for key, row in table.items():
        if not str(key).isdigit():
            continue
        if isinstance(row, dict) or (isinstance(row, list) and fields):
            rows[int(key)] = row
        else:
            raise LibraryError("Unrecognized library format.")
    return Table(rows, fields)


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

    def to_cache(self):
        """Only what Tagcast needs: no account details or third-party session keys."""
        return {
            "library": {"tracks": self.tracks.raw(), "albums": self.albums.raw(),
                        "artists": self.artists.raw(), "expires": self.expires},
            "settings": {"artwork_server": self.artwork_server},
            "status": {"lastmodified": self.lastmodified},
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

    def album_ids(self):
        return [i for i, a in self.albums.items()
                if not a.get("trashed") and self.active_track_ids(i)]

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
            "track": number(track.get("track")),
            "length": number(track.get("length")),
            "artwork_id": number(track.get("artwork_id")),
        }

    def albums_view(self):
        return [self.album_view(i) for i in self.album_ids()]

    def album_summary(self, album_id):
        """A small album entry for the browser's list: no tracks, only what lists and filters use."""
        album = self.albums[album_id]
        genres, no_genre = set(), 0
        track_ids = self.active_track_ids(album_id)
        for track_id in track_ids:
            track = self.tracks[track_id]
            genre = text(track.get("genre")).strip()
            if genre:
                genres.add(genre)
            else:
                no_genre += 1
        return {
            "id": str(album_id),
            "name": text(album.get("name")) or "Untitled album",
            "artist": self.artist_name(album.get("artist_id")),
            "year": number(album.get("year")),
            "disc": number(album.get("disc")),
            "artwork": self.art_url(self.album_artwork(track_ids)),
            "artist_id": number(album.get("artist_id")),
            "artist_image": self.artist_image(album.get("artist_id")),
            "track_count": len(track_ids),
            "genres": sorted(genres),
            "no_genre": no_genre,
        }

    def album_index(self):
        return [self.album_summary(i) for i in self.album_ids()]

    def artist_names(self):
        return sorted({text(a.get("name")) for a in self.artists.values()
                       if not a.get("trashed") and text(a.get("name"))}, key=str.casefold)

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
        artist = self.artists.get(artist_id)
        if not artist or artist.get("trashed"):
            raise LibraryError("This artist is no longer available. Reload the library.")
        return number(artist.get("artwork_id"))

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
            items.append({"kind": kind, "id": item_id, "album_id": album_id,
                          "label": now.get("name") or now.get("title"), "patch": patch})

    if len(album_artists) > 1:
        raise LibraryError("A save must stay within one album or one album artist.")
    if conflicts:
        shown = "; ".join(conflicts[:3]) + (" …" if len(conflicts) > 3 else "")
        raise ConflictError(f"Changed in iBroadcast since you loaded it ({shown}). "
                            "Reload the library and review again.")

    names = OrderedDict()
    for item in items:
        if "artist" in item["patch"]:
            names.setdefault(item["patch"]["artist"], library.find_artist(item["patch"]["artist"]))
    return {
        "items": items,
        "artists": {name: artist_id for name, artist_id in names.items() if artist_id is not None},
        "new_artists": [name for name, artist_id in names.items() if artist_id is None],
    }


def _wire(kind, patch, artist_ids):
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
        else:
            out[key] = value
    return out


def write_requests(plan, artist_ids):
    """Group identical patches, like the web editor does, into update requests."""
    groups = OrderedDict()
    for item in plan["items"]:
        wire = _wire(item["kind"], item["patch"], artist_ids)
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
