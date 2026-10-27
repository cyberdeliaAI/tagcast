"""Explicitly reviewed moves of complete single-disc album fragments.

Native payload observed in iBroadcastLibraryEditor.js (2026-10-27),
moveTracksIntoAlbum: update_track with file_id, album_id and album only.
No renumbering, album creation, artwork writes or artist merges are performed.
"""

import copy
import secrets
import time
from collections import Counter

from .collections import track_ids
from .library import ConflictError, LibraryError, additional_artists, number, text

MAX_ALBUMS = 20
MAX_TRACKS = 500
LIFETIME = 15 * 60
TRACK_FIELDS = ("title", "artist_id", "track", "year", "genre", "genres_additional",
                "rating", "length", "type", "artwork_id", "uploaded_on", "uploaded_time")


def track_state(library, track_id):
    track = library.tracks[track_id]
    return {**{key: copy.deepcopy(track.get(key)) for key in TRACK_FIELDS},
            "credits": additional_artists(track, library.tracks.nested.get("artists_additional_map")),
            "artist_names": [library.artist_name(i) for i in [number(track.get("artist_id")),
                *(e["artist_id"] for e in library.extra_artists(track))]]}


def album_state(library, album_id):
    album = library.albums[album_id]
    return {**{key: copy.deepcopy(album.get(key)) for key in ("name", "artist_id", "year", "disc", "rating")},
            "credits": additional_artists(album, library.albums.nested.get("artists_additional_map")),
            "artist_names": [library.artist_name(i) for i in library.album_artist_ids(album)]}


class AlbumMerge:
    def __init__(self, studio):
        self.studio = studio
        self.selections = {}
        self.reviews = {}

    def _owner(self, body, expected=None):
        studio = self.studio
        client = studio._require_client()
        owner = (client, studio.library_user, studio.playback_session)
        if not studio.playback_session or body.get("session") != studio.playback_session \
                or (expected is not None and owner != expected):
            raise ConflictError("The account connection changed. Select the albums again.")
        return owner

    def _store(self, table, value):
        with self.studio.lock:
            now = time.monotonic()
            for key in list(table):
                if table[key]["expires"] <= now:
                    del table[key]
            while len(table) >= 2:
                del table[next(iter(table))]
            token = secrets.token_urlsafe(24)
            table[token] = {**value, "expires": now + LIFETIME}
        return token

    def _get(self, table, token, consume=False):
        with self.studio.lock:
            value = table.pop(token, None) if consume and isinstance(token, str) else table.get(token) if isinstance(token, str) else None
        if value is None or value["expires"] <= time.monotonic():
            raise ConflictError("This merge review expired or was already used. Select the albums again.")
        return value

    def _snapshot(self, library, ids):
        if library.combine_sets:
            raise LibraryError("Turn off Combine Multi-Disc Album Sets in iBroadcast before merging albums.")
        library._browse_index("genres")
        active = set(library.album_ids())
        if any(i not in active for i in ids):
            raise ConflictError("A selected album is no longer available. Reload the library.")
        if any(sum(group == library._browse_albums[i] for group in library._browse_albums.values()) > 1 for i in ids):
            raise LibraryError("Multi-disc sets cannot be merged here. Choose fragments of one disc only.")
        if len({number(library.albums[i].get("disc")) for i in ids}) != 1:
            raise LibraryError("Choose fragments with the same disc number. Different discs must stay separate.")
        albums, tracks = {}, {}
        for album_id in ids:
            members = library.active_track_ids(album_id)
            if not members or len(members) != len(set(members)):
                raise ConflictError("An album has ambiguous track membership. Reload the library.")
            for track_id in members:
                if track_id in tracks or number(library.tracks[track_id].get("album_id")) != album_id \
                        or library.active_track_album(track_id) != album_id:
                    raise ConflictError("An album has ambiguous track membership. Reload the library.")
                tracks[track_id] = {"album_id": album_id, "metadata": track_state(library, track_id)}
                if len(tracks) > MAX_TRACKS:
                    raise LibraryError("Choose up to 500 tracks for one album merge.")
            albums[album_id] = {"metadata": album_state(library, album_id),
                                "members": sorted(members),
                                "stored_members": list(library.albums[album_id].get("tracks") or [])}
        return {"albums": albums, "tracks": tracks}

    def selection(self, body):
        owner = self._owner(body)
        rows = body.get("albums")
        if not isinstance(rows, list) or not 2 <= len(rows) <= MAX_ALBUMS \
                or any(not isinstance(row, dict) for row in rows):
            raise LibraryError("Select 2–20 complete single-disc albums to merge.")
        ids = track_ids([row.get("id") for row in rows], MAX_ALBUMS)
        if len(ids) != len(set(ids)):
            raise LibraryError("Choose each album once.")
        library, _ = self.studio._current(owner[0])
        snapshot = self._snapshot(library, ids)
        for row, album_id in zip(rows, ids):
            view = library.album_view(album_id)
            shown = {"name": view["name"], "artist": view["artist"], "year": view["year"],
                     "disc": view["disc"], "track_count": len(view["tracks"])}
            if any(row.get(key) != value for key, value in shown.items()):
                raise ConflictError("A selected album changed. Reload and select the albums again.")
        self._owner(body, owner)
        views = [library.album_view(i) for i in ids]
        token = self._store(self.selections, {"owner": owner, "ids": ids, "snapshot": snapshot})
        return {"selection": token, "albums": views, "tracks": len(snapshot["tracks"])}

    def review(self, body):
        selection = self._get(self.selections, body.get("selection"))
        owner = self._owner(body, selection["owner"])
        target = track_ids([body.get("target")], 1)[0]
        if target not in selection["ids"]:
            raise LibraryError("Choose a destination from the selected albums.")
        library, _ = self.studio._current(owner[0])
        if self._snapshot(library, selection["ids"]) != selection["snapshot"]:
            raise ConflictError("An album or track changed. Select the albums again.")
        self._owner(body, owner)
        views = [library.album_view(i) for i in selection["ids"]]
        tracks = [{**track, "source_name": album["name"], "source_artist": album["artist"],
                   "source_id": album["id"]} for album in views for track in album["tracks"]]
        tracks.sort(key=lambda t: (t["track"] or 9999, number(t["id"])))
        counts = Counter(t["track"] for t in tracks if t["track"] > 0)
        overlaps = sorted(n for n, count in counts.items() if count > 1)
        value = {**selection, "target": target, "overlaps": overlaps}
        token = self._store(self.reviews, value)
        return {"review": token, "target": library.album_view(target), "albums": views,
                "tracks": tracks, "overlapping_numbers": overlaps,
                "missing_numbers": sum(not t["track"] for t in tracks),
                "artwork": library.art_url(library.album_artwork([number(t["id"]) for t in tracks]))}

    def save(self, body):
        studio = self.studio
        if body.get("approved") is not True:
            raise LibraryError("Review and approve the album merge first.")
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            review = self._get(self.reviews, body.get("review"), consume=True)
            owner = self._owner(body, review["owner"])
            if review["overlaps"] and body.get("keep_overlapping_numbers") is not True:
                raise LibraryError("Confirm that overlapping track numbers will be kept, or cancel the merge.")
            client = owner[0]
            library, _ = studio._current(client)
            snapshot = review["snapshot"]
            if self._snapshot(library, review["ids"]) != snapshot:
                raise ConflictError("An album or track changed after review. Select the albums again.")
            self._owner(body, owner)
            target = review["target"]
            updates = [{"file_id": tid, "album_id": target,
                        "album": text(library.albums[target].get("name"))}
                       for tid, row in snapshot["tracks"].items() if row["album_id"] != target]
            # Both approvals are consumed before the one non-retryable native request.
            with studio.lock:
                self.selections.clear()
                self.reviews.clear()
            client._jsonrequest("update_track", _retry=False, tracks=updates)

            def result(tid, status):
                return {"kind": "track", "id": str(tid), "label": text(snapshot["tracks"][tid]["metadata"]["title"]),
                        "fields": ["album"], "status": status}

            def check(after):
                same_owner = (studio.client, studio.library_user, studio.playback_session) == owner
                members = after.active_track_ids(target)
                complete = same_owner and not after.combine_sets and set(members) == set(snapshot["tracks"]) \
                    and len(members) == len(snapshot["tracks"]) and target in after.albums \
                    and album_state(after, target) == snapshot["albums"][target]["metadata"] \
                    and all(not after.active_track_ids(i) for i in review["ids"] if i != target)
                results = []
                for tid in snapshot["tracks"]:
                    kept = complete and tid in after.tracks \
                        and number(after.tracks[tid].get("album_id")) == target \
                        and track_state(after, tid) == snapshot["tracks"][tid]["metadata"]
                    results.append(result(tid, "saved" if kept else "unverified"))
                return results

            job = studio._check_later(client, studio.downloads, check)
            return {"job": job, "target": str(target),
                    "results": [result(tid, "sent") for tid in snapshot["tracks"]]}
        finally:
            studio.save_lock.release()
