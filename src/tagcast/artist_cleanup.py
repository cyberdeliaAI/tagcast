"""Conservative guest-credit candidates inferred from the loaded library."""

import re
import unicodedata
from collections import defaultdict
from itertools import groupby

from .library import number, text

PAGE_SIZE = 50
_MARKER = r"(?:featuring|feat\.?|ft\.?)\s+"
_INLINE_MARKER = r"(?:featuring|feat\.|ft\.)\s+"
_GUEST_SUFFIXES = (
    re.compile(rf"\(\s*{_MARKER}([^()\[\]]+)\)\s*$", re.IGNORECASE),
    re.compile(rf"\[\s*{_MARKER}([^()\[\]]+)\]\s*$", re.IGNORECASE),
    re.compile(rf"\s+{_INLINE_MARKER}([^()\[\]]+)$", re.IGNORECASE),
)
_JOINER = re.compile(r"\s+(?:&|and|with|x|feat\.?|featuring|ft\.?)\s+|\s*[/;·]\s*|,\s+",
                     re.IGNORECASE)


def _name_key(name):
    return " ".join(unicodedata.normalize("NFC", name).casefold().split())


def _credit_key(name):
    """Only for suppressing candidates. Never use this looser key to select an artist."""
    return "".join(char for char in unicodedata.normalize("NFD", name.casefold()) if char.isalnum())


def _guest_from_title(title):
    for pattern in _GUEST_SUFFIXES:
        match = pattern.search(title)
        if match and title[:match.start()].strip():
            return match[1].strip()
    return ""


def _already_credited(guest, names):
    key = _credit_key(guest)
    credited = {_credit_key(name) for name in names}
    if key in credited:
        return True
    parts = _JOINER.split(guest)
    if len(parts) > 1 and all(_credit_key(part) in credited for part in parts):
        return True
    return any(key == _credit_key(part) for name in names for part in _JOINER.split(name))


def scan_guest_credits(library):
    """Only explicitly marked guests with a unique existing artist-name match."""
    artists = defaultdict(list)
    for artist_id, artist in library.artists.items():
        name = text(artist.get("name"))
        if artist_id and name and not artist.get("trashed"):
            artists[_name_key(name)].append(name)

    rows = []
    album_ids = library.album_ids()
    containers = library.track_containers
    for album_id in album_ids:
        album = library.albums[album_id]
        for track_id in library.active_track_ids(album_id):
            track = library.tracks[track_id]
            title = text(track.get("title"))
            guest = _guest_from_title(title)
            matches = artists.get(_name_key(guest)) if guest else None
            if not matches or len(matches) != 1 or len(containers[track_id]) != 1:
                continue
            primary = library.artist_name(number(track.get("artist_id")))
            credits = [library.artist_name(entry["artist_id"]) for entry in library.extra_artists(track)]
            if _already_credited(guest, [primary, *credits]):
                continue
            rows.append({"album_id": str(album_id), "album": text(album.get("name")),
                         "album_artist": library.artist_name(album.get("artist_id")),
                         "track": {"id": str(track_id), "title": title,
                                   "artist": primary, "guest": matches[0]}})
    rows.sort(key=lambda row: (row["album_artist"].casefold(), row["album"].casefold(), row["album_id"]))
    return rows


def guest_credit_page(rows, offset):
    offset = min(offset, max(0, (len(rows) - 1) // PAGE_SIZE * PAGE_SIZE))
    groups = []
    for album_id, matches in groupby(rows[offset:offset + PAGE_SIZE], key=lambda row: row["album_id"]):
        first = next(matches)
        groups.append({"id": album_id, "title": first["album"], "artist": first["album_artist"],
                       "tracks": [first["track"], *(row["track"] for row in matches)]})
    return {"albums": groups, "total_albums": len({row["album_id"] for row in rows}),
            "total_tracks": len(rows), "offset": offset, "limit": PAGE_SIZE}
