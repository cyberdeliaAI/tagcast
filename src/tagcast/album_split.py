"""Reviewed manual splits, using the native web editor's create/move payloads.

Observed in iBroadcastLibraryEditor.js, createAlbum and moveTracksIntoAlbum,
2026-11-07. Creation and movement are separate, non-transactional requests.
Neither request may be retried after an ambiguous reply.
"""

import copy

from .album_merge import AlbumMerge, album_state, track_state
from .collections import track_ids
from .library import ConflictError, LibraryError, additional_artists, number, text

MAX_TRACKS = 500


def split_suggestions(tracks):
    """Conservative selection aids, never proof of editions or automatic changes.

    Require separate upload days AND different, uniform known years, with track
    numbering restarting across the groups but not repeated inside a group.
    Mixed-year compilations and incomplete metadata deliberately get no proposal.
    """
    groups = {}
    for track in tracks:
        day = text(track.get("uploaded_at"))[:10]
        year = number(track.get("year"))
        if not day or not 1800 <= year <= 2050 or number(track.get("track")) <= 0:
            return []
        groups.setdefault(day, []).append(track)
    if not 2 <= len(groups) <= 10:
        return []
    out, years, positions = [], set(), []
    for day, rows in sorted(groups.items()):
        group_years = {number(t.get("year")) for t in rows}
        numbers = {number(t.get("track")) for t in rows}
        if len(rows) < 2 or len(group_years) != 1 or len(numbers) != len(rows):
            return []
        year = group_years.pop()
        if year in years:
            return []
        years.add(year)
        positions.append(numbers)
        out.append({"uploaded_on": day, "year": year, "tracks": [t["id"] for t in rows]})
    if not all(any(len(a & b) >= 2 for b in positions if b is not a) for a in positions):
        return []
    return out


class AlbumSplit(AlbumMerge):
    """Reuse only the bounded, expiring owner/token gates of the merge workflow."""

    def _get(self, table, token, consume=False):
        try:
            return super()._get(table, token, consume)
        except ConflictError as error:
            raise ConflictError("This split review expired or was already used. Review a new split.") from error

    @staticmethod
    def _split_snapshot(library, album_id):
        if library.combine_sets:
            raise LibraryError("Turn off Combine Multi-Disc Album Sets in iBroadcast before splitting.")
        album = library.albums.get(album_id)
        members = library.active_track_ids(album_id)
        if not album or album.get("trashed") or not 2 <= len(members) <= MAX_TRACKS:
            raise LibraryError("Choose one album or disc with 2–500 active tracks.")
        if additional_artists(album, library.albums.nested.get("artists_additional_map")):
            raise LibraryError("Splitting albums with additional album credits is not supported yet.")
        artist_id = album.get("artist_id")
        if type(artist_id) is not int or artist_id < 0 or artist_id and artist_id not in library.artists:
            raise LibraryError("The album artist is unavailable. Correct it before splitting.")
        if len(members) != len(set(members)) or any(
                number(library.tracks[t].get("album_id")) != album_id
                or library.active_track_album(t) != album_id for t in members):
            raise ConflictError("Album membership changed. Reload the album before splitting.")
        return {"album": album_state(library, album_id), "members": sorted(members),
                "stored_members": copy.deepcopy(album.get("tracks")),
                "tracks": {t: track_state(library, t) for t in members}}

    def selection(self, body):
        client, _, _ = owner = self._owner(body)
        shown = body.get("album")
        if not isinstance(shown, dict):
            raise LibraryError("Choose the album or disc to split.")
        album_id = track_ids([shown.get("id")], 1)[0]
        library, _ = self.studio._current(client)
        snapshot = self._split_snapshot(library, album_id)
        album = library.album_view(album_id)
        if any(shown.get(k) != album[k] for k in ("name", "artist", "year", "disc")) \
                or sorted(track_ids(shown.get("tracks"), MAX_TRACKS)) != snapshot["members"]:
            raise ConflictError("Album membership changed. Reload the album before splitting.")
        self._owner(body, owner)
        token = self._store(self.selections, {"owner": owner, "source": album_id, "snapshot": snapshot})
        return {"selection": token, "album": album, "suggestions": split_suggestions(album["tracks"])}

    def review(self, body):
        selection = self._get(self.selections, body.get("selection"))
        client, _, _ = self._owner(body, selection["owner"])
        chosen = track_ids(body.get("tracks"), MAX_TRACKS)
        members = selection["snapshot"]["members"]
        if not chosen or len(chosen) != len(set(chosen)) or not set(chosen) < set(members):
            raise LibraryError("Select some tracks to move and leave at least one in the original album.")
        target = body.get("target")
        if not isinstance(target, dict) or not isinstance(target.get("name"), str) \
                or not target["name"].strip() or len(target["name"]) > 1000 \
                or type(target.get("year")) is not int \
                or (target["year"] != 0 and not 1800 <= target["year"] <= 2050) \
                or type(target.get("disc")) is not int or not 1 <= target["disc"] <= 9999:
            raise LibraryError("Enter an album title, a year from 1800 to 2050 (or 0), and a disc number from 1 to 9999.")
        target = {"name": target["name"].strip(), "year": target["year"], "disc": target["disc"],
                  "artist_id": selection["snapshot"]["album"]["artist_id"]}
        library, _ = self.studio._current(client)
        if self._split_snapshot(library, selection["source"]) != selection["snapshot"]:
            raise ConflictError("The album changed. Review a new split before saving.")
        self._no_existing_target(library, target)
        self._owner(body, selection["owner"])
        album = library.album_view(selection["source"])
        ordered = [t for t in album["tracks"] if number(t["id"]) in chosen]
        token = self._store(self.reviews, {**selection, "chosen": chosen, "target": target})
        return {"review": token, "source": album, "target": {**target, "artist": album["artist"]},
                "tracks": ordered, "remaining": len(members) - len(chosen)}

    @staticmethod
    def _no_existing_target(library, target):
        if any(not a.get("trashed") and text(a.get("name")).strip().casefold() == target["name"].casefold()
               and number(a.get("artist_id")) == target["artist_id"]
               and number(a.get("year")) == target["year"]
               and number(a.get("disc")) == target["disc"] for a in library.albums.values()):
            raise LibraryError("An album with this title, album artist, year and disc already exists. Choose a distinct title, year or disc.")

    @staticmethod
    def _target_matches(library, target_id, target):
        album = library.albums.get(target_id)
        return bool(album and not album.get("trashed")
                    and not additional_artists(album, library.albums.nested.get("artists_additional_map"))
                    and text(album.get("name")) == target["name"]
                    and all(number(album.get(k)) == target[k] for k in ("artist_id", "year", "disc")))

    def save(self, body):
        if body.get("approved") is not True:
            raise LibraryError("Review and confirm the album split first.")
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is running. Wait for it to finish.")
        try:
            review = self._get(self.reviews, body.get("review"), consume=True)
            owner, source, snapshot = review["owner"], review["source"], review["snapshot"]
            client, _, _ = self._owner(body, owner)
            library, _ = self.studio._current(client)
            if self._split_snapshot(library, source) != snapshot:
                raise ConflictError("The album changed. Review a new split before saving.")
            target, chosen = review["target"], set(review["chosen"])
            self._no_existing_target(library, target)
            old_ids = set(library.albums)
            self._owner(body, owner)
            with self.studio.lock:
                self.selections.clear()
                self.reviews.clear()
            target_id, attempted_move, error = 0, False, ""
            try:
                response = client._jsonrequest("create_album", _retry=False, **target)
                raw_id = response.get("album_id")
                if response.get("result") is not True or type(raw_id) not in (int, str) \
                        or not str(raw_id).isdigit() or int(raw_id) <= 0 or int(raw_id) in old_ids:
                    raise LibraryError("The new album could not be confirmed. No tracks were sent.")
                target_id = int(raw_id)
                # A successful creation alone never authorizes movement into an existing,
                # populated or differently configured album. Recheck both sides first.
                after_create, _ = self.studio._current(client, refresh=True)
                self._owner(body, owner)
                if self._split_snapshot(after_create, source) != snapshot \
                        or not self._target_matches(after_create, target_id, target) \
                        or after_create.active_track_ids(target_id):
                    raise ConflictError("The album changed after creation. No tracks were sent.")
                self._owner(body, owner)
                attempted_move = True
                client._jsonrequest("update_track", _retry=False, tracks=[
                    {"file_id": tid, "album_id": target_id, "album": target["name"]}
                    for tid in review["chosen"]])
            except Exception as failure:
                # Preserve an accepted/uncertain creation or move; never roll back or retry.
                # Runtime imports avoid the Studio -> feature -> Studio import cycle.
                from .client import ApiError
                if not isinstance(failure, (ApiError, LibraryError)):
                    raise
                error = str(failure)

            def check(after):
                current_owner = (self.studio.client, self.studio.library_user, self.studio.playback_session)
                valid = current_owner == owner and not after.combine_sets and target_id not in old_ids \
                    and self._target_matches(after, target_id, target)
                valid = valid and sorted(after.active_track_ids(target_id)) == sorted(chosen) \
                    and sorted(after.active_track_ids(source)) == sorted(set(snapshot["members"]) - chosen) \
                    and album_state(after, source) == snapshot["album"]
                valid = valid and all(tid in after.tracks and not after.tracks[tid].get("trashed")
                    and number(after.tracks[tid].get("album_id")) == (target_id if tid in chosen else source)
                    and track_state(after, tid) == before for tid, before in snapshot["tracks"].items())
                return [{"kind": "track", "id": str(tid), "label": text(library.tracks[tid].get("title")),
                         "fields": ["album"], "status": "saved" if valid else "unverified" if attempted_move else "not_sent"}
                        for tid in review["chosen"]]

            job = self.studio._check_later(client, self.studio.downloads, check)
            return {"job": job, "target": str(target_id) if target_id else "", "error": error}
        finally:
            self.studio.save_lock.release()
