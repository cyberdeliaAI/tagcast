"""Explicit, read-only MusicBrainz edition lookup; no iBroadcast refresh or mutation."""

import re

from .library import ConflictError, LibraryError
from .sources import MusicBrainz, SourceError

PAGE = 20
MAX_RESULTS = 200
MAX_TRACKS = 1000
MAX_MEDIA = 100
MBID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)


def invalid():
    return LibraryError("Choose a valid album, search or MusicBrainz release.",
                        code="track_comparison.invalid_request")


def plain(value, limit=1000):
    return value[:limit] if isinstance(value, str) else ""


def positive(value):
    return value if type(value) is int and 0 < value <= 1000000 else 0


def credit(value):
    if not isinstance(value, list):
        return ""
    return "".join(plain(c.get("name"), 200) + plain(c.get("joinphrase"), 100)
                   for c in value[:100] if isinstance(c, dict))[:1000]


def edition(row):
    if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not MBID.fullmatch(row["id"]):
        return None
    media = row.get("media") if isinstance(row.get("media"), list) else []
    labels = row.get("label-info") if isinstance(row.get("label-info"), list) else []
    return {"id": row["id"].lower(), "title": plain(row.get("title")),
            "artist": credit(row.get("artist-credit")), "date": plain(row.get("date"), 32),
            "country": plain(row.get("country"), 80), "status": plain(row.get("status"), 80),
            "note": plain(row.get("disambiguation")), "barcode": plain(row.get("barcode"), 80),
            "formats": list(dict.fromkeys(plain(m.get("format"), 80) for m in media[:MAX_MEDIA]
                                          if isinstance(m, dict) and m.get("format"))),
            "discs": len(media),
            "track_count": sum(positive(m.get("track-count")) for m in media[:MAX_MEDIA]
                               if isinstance(m, dict)),
            "labels": [{"name": plain((item.get("label") or {}).get("name"), 200),
                        "catalogue": plain(item.get("catalog-number"), 100)}
                       for item in labels[:20] if isinstance(item, dict)
                       and isinstance(item.get("label", {}), dict)],
            "url": "https://musicbrainz.org/release/" + row["id"].lower()}


def search(source, artist, album, offset):
    if not all(isinstance(s, str) and s.strip() and len(s) <= 200 for s in (artist, album)):
        raise invalid()
    if not isinstance(offset, str) or not offset.isascii() or not offset.isdecimal() or len(offset) > 3:
        raise invalid()
    offset = int(offset)
    if offset < 0 or offset >= MAX_RESULTS or offset % PAGE:
        raise invalid()
    query = f"release:{MusicBrainz._quote(album.strip())} AND artist:{MusicBrainz._quote(artist.strip())}"
    data = source.http.json(MusicBrainz.API + "/release", {"query": query, "fmt": "json",
                                                          "limit": PAGE, "offset": offset})
    if not isinstance(data, dict) or not isinstance(data.get("releases"), list) \
            or type(data.get("count")) is not int or not 0 <= data["count"] <= 2147483647:
        raise SourceError("MusicBrainz returned an invalid search response.")
    rows = [parsed for row in data["releases"][:PAGE] if (parsed := edition(row))]
    count = data["count"]
    return {"releases": rows, "offset": offset, "total": count,
            "more": offset + PAGE < min(count, MAX_RESULTS), "limit": MAX_RESULTS}


def release(source, release_id):
    if not isinstance(release_id, str) or not MBID.fullmatch(release_id):
        raise invalid()
    release_id = release_id.lower()
    data = source.http.json(MusicBrainz.API + "/release/" + release_id,
                            {"inc": "recordings artist-credits labels", "fmt": "json"})
    result = edition(data)
    if not result or result["id"] != release_id:
        raise SourceError("MusicBrainz did not return the selected release.")
    media = data.get("media")
    if not isinstance(media, list) or len(media) > MAX_MEDIA:
        raise SourceError("MusicBrainz returned an invalid or oversized track list.")
    tracks, incomplete = [], not media
    for medium in media:
        if not isinstance(medium, dict):
            raise SourceError("MusicBrainz returned an invalid medium.")
        rows = medium.get("tracks", [])
        if not isinstance(rows, list) or len(tracks) + len(rows) > MAX_TRACKS:
            raise LibraryError("Compare editions with at most 1,000 tracks.", code="track_comparison.too_large")
        incomplete |= not positive(medium.get("position"))
        incomplete |= type(medium.get("track-count")) is not int or medium["track-count"] != len(rows)
        # Extra pregap/data sections are not ordinary audio positions. Never present
        # their omission as a complete edition or infer missing audio from them.
        incomplete |= bool(medium.get("pregap") or medium.get("data-tracks"))
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("title", ""), str) or len(row.get("title", "")) > 1000:
                raise SourceError("MusicBrainz returned invalid track metadata.")
            incomplete |= not positive(row.get("position")) or not plain(row.get("number")).strip() or not plain(row.get("title")).strip()
            recording = row.get("recording") if isinstance(row.get("recording"), dict) else {}
            length = row.get("length")
            tracks.append({"title": plain(row.get("title")),
                           "artist": credit(row.get("artist-credit")) or credit(recording.get("artist-credit")) or result["artist"],
                           "disc": positive(medium.get("position")), "position": positive(row.get("position")),
                           "number": plain(row.get("number"), 40),
                           "length": length / 1000 if type(length) is int and 0 < length <= 604800000 else None})
    return {"release": result, "tracks": tracks, "incomplete": bool(incomplete)}


def view(studio, query, detail=False):
    """Capture/recheck ownership around public I/O; keep all network I/O outside Studio.lock."""
    with studio.lock:
        studio._require_client()
        library = studio.library
        album_id = query.get("album_id", "")
        if not library or not studio.library_user or query.get("session") != studio.playback_session:
            raise ConflictError("The account or album changed. Open the comparison again.", code="track_comparison.replaced")
        if not isinstance(album_id, str) or not album_id.isascii() or not album_id.isdecimal() or len(album_id) > 20:
            raise invalid()
        if len(library.active_track_ids(int(album_id))) > MAX_TRACKS:
            raise LibraryError("Compare editions with at most 1,000 tracks.", code="track_comparison.too_large")
        before = library.album_view(int(album_id))
        owner = studio.client, studio.library_user, studio.playback_session
        if "musicbrainz" in studio.disabled_sources:
            raise SourceError("Enable MusicBrainz in Settings before comparing.", code="track_comparison.unavailable")
        source = studio.lookup._get("musicbrainz", "albums")
    try:
        result = release(source, query.get("id")) if detail else search(
            source, query.get("artist"), query.get("album"), query.get("offset", "0"))
    except SourceError as error:
        raise SourceError(str(error), code="track_comparison.source_failed") from None
    with studio.lock:
        if library is not studio.library or owner != (studio.client, studio.library_user, studio.playback_session):
            raise ConflictError("The account or album changed. Open the comparison again.", code="track_comparison.replaced")
        if "musicbrainz" in studio.disabled_sources:
            raise SourceError("Enable MusicBrainz in Settings before comparing.", code="track_comparison.unavailable")
        if before != library.album_view(int(album_id)):
            raise ConflictError("The account or album changed. Open the comparison again.", code="track_comparison.replaced")
    return result
