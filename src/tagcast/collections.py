"""Local album/artist favourites, native ratings and reviewed private playlists."""

import hashlib
import json

from .library import ConflictError, LibraryError, fold, number, text


def track_ids(values, maximum=10000):
    if not isinstance(values, list) or (maximum is not None and len(values) > maximum) or any(
            type(i) not in (int, str) or not str(i).isdigit() or int(i) <= 0 for i in values):
        raise LibraryError(f"Choose up to {maximum} valid tracks.")
    return [int(i) for i in values]


def playlist_track_search_text(library, track_id):
    """Search loaded metadata only; unavailable saved positions remain distinguishable."""
    track = library.tracks.get(track_id)
    if not track or track.get("trashed"):
        return fold(f"Unavailable track ID {track_id}")
    album = library.albums.get(number(track.get("album_id")))
    if album is None:
        try:
            album = library.albums[library.active_track_album(track_id)]
        except LibraryError:
            return fold(f"Unavailable track ID {track_id}")
    return fold(" ".join([
        text(track.get("title")), library.artist_name(track.get("artist_id")),
        text(album.get("name")),
        *(library.artist_name(a) for a in library.album_artist_ids(album)),
    ]))


class Collections:
    def __init__(self, studio):
        self.studio = studio

    def _artist_favourites(self, library):
        """Read under the Studio lock; a damaged file must never become an empty one."""
        studio = self.studio
        if library is None or library is not studio.library or not studio.client or not studio.library_user:
            raise ConflictError("The account or library changed. Reload the library.")
        filename = "artist-favourites.json"
        data = studio._read(filename)
        if data is None and not (studio.home / filename).exists():
            data = {"version": 1, "accounts": {}}
        if not isinstance(data, dict) or data.get("version") != 1 \
                or not isinstance(data.get("accounts"), dict) \
                or any(not isinstance(ids, list) or any(
                    not isinstance(i, str) or not i.isascii() or not i.isdigit()
                    or len(i) > 32 or int(i) <= 0 for i in ids)
                    for ids in data["accounts"].values()):
            raise LibraryError("Could not read local artist favourites. Check artist-favourites.json.")
        return data, str(studio.library_user)

    def artist_favourites(self, library=None, active_ids=None):
        studio = self.studio
        with studio.lock:
            studio._require_client()
            library = library if library is not None else studio.library
            data, account = self._artist_favourites(library)
            if active_ids is None:
                active_ids = {str(a) for i in library.album_ids()
                              for a in library.album_artist_ids(library.albums[i]) if a > 0}
            return {"artists": sorted(set(data["accounts"].get(account, [])) & active_ids, key=int)}

    def artist_selection(self, body):
        """Validate the complete named group used by the existing album-artist browser."""
        ids = track_ids(body.get("artists"), 100)
        name = body.get("name")
        studio = self.studio
        studio._require_client()
        library = studio.library
        if not library or body.get("session") != studio.playback_session:
            raise ConflictError("The account or library changed. Reload the library.")
        if not ids or len(ids) != len(set(ids)) or not isinstance(name, str) or not name:
            raise LibraryError("Choose one album artist and its current name.")
        active = {a for i in library.album_ids() for a in library.album_artist_ids(library.albums[i])
                  if a > 0 and library.artist_name(a) == name}
        if set(ids) != active or any(i not in library.artists for i in ids):
            raise ConflictError("This album artist changed or is no longer available. Reload the library.")
        return library, {str(i) for i in ids}, name

    def favourite_artist(self, body):
        before, favourite = body.get("before"), body.get("favourite")
        if type(before) is not bool or type(favourite) is not bool:
            raise LibraryError("Choose an artist and its current favourite state.")
        studio = self.studio
        with studio.lock:
            library, ids, _ = self.artist_selection(body)
            data, account = self._artist_favourites(library)
            saved = set(data["accounts"].get(account, []))
            if ids.issubset(saved) != before:
                raise ConflictError("This artist's favourite changed in another window. Reload the library.")
            if favourite:
                saved.update(ids)
            else:
                saved.difference_update(ids)
            data["accounts"][account] = sorted(saved, key=int)
            try:
                studio._write("artist-favourites.json", data)
                checked, _ = self._artist_favourites(library)
            except OSError as error:
                raise LibraryError("Could not save local artist favourites. Reload before trying again.") from error
            saved = set(checked["accounts"].get(account, []))
            return {"results": [{"id": i, "favourite": i in saved} for i in sorted(ids, key=int)]}

    def rate_artist(self, body):
        ids = track_ids(body.get("artists"), 20)
        rating, before = body.get("rating"), body.get("before")
        if not ids or len(ids) != len(set(ids)) or type(rating) is not int or not 0 <= rating <= 5 \
                or not isinstance(before, list) or len(before) != len(ids) \
                or any(type(value) is not int or not 0 <= value <= 5 for value in before):
            raise LibraryError("Choose one artist and its current ratings from zero to five.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client = studio._require_client()
            studio._current(client)
            with studio.lock:
                library, _, name = self.artist_selection(body)
                if [number(library.artists[i].get("rating")) for i in ids] != before:
                    raise ConflictError("This artist's rating changed. Reload before rating it.")
            attempted, error = set(), ""
            for artist_id, previous in zip(ids, before):
                if previous == rating:
                    continue
                if client is not studio.client or body["session"] != studio.playback_session:
                    error = "The iBroadcast connection changed; remaining artists were not sent."
                    break
                try:
                    attempted.add(artist_id)
                    client._jsonrequest("rateartist", artist_id=artist_id, rating=rating)
                except Exception as failure:
                    error = str(failure)
                    break

            def check(after):
                results = []
                for artist_id in ids:
                    artist = after.artists.get(artist_id, {})
                    actual = number(artist.get("rating"))
                    confirmed = bool(artist) and after.artist_name(artist_id) == name and actual == rating
                    results.append({"id": str(artist_id), "rating": actual,
                                    "status": "saved" if confirmed else "unverified"
                                    if artist_id in attempted else "not_sent"})
                return results

            return {"job": studio._check_later(client, studio.downloads, check, include_albums=False), "error": error}
        finally:
            studio.save_lock.release()

    @staticmethod
    def _favourite_members(library, album_id):
        if library.combine_sets:
            return {str(number(library.tracks[i].get("album_id")) or album_id)
                    for i in library.active_track_ids(album_id)}
        return {str(album_id)}

    def _album_favourites(self, library):
        """Called under the Studio lock; import the former rating-based hearts once."""
        studio = self.studio
        if library is None or library is not studio.library or not studio.client or not studio.library_user:
            raise ConflictError("The account or library changed. Reload the library.")
        filename = "album-favourites.json"
        data = studio._read(filename)
        if data is None and not (studio.home / filename).exists():
            data = {"version": 1, "accounts": {}}
        if not isinstance(data, dict) or data.get("version") != 1 \
                or not isinstance(data.get("accounts"), dict) \
                or any(not isinstance(ids, list) or any(
                    not isinstance(i, str) or not i.isascii() or not i.isdigit()
                    or len(i) > 32 or int(i) <= 0 for i in ids)
                    for ids in data["accounts"].values()):
            raise LibraryError("Could not read local album favourites. Check album-favourites.json.")
        account = str(studio.library_user)
        if account not in data["accounts"]:
            data["accounts"][account] = sorted({member for i in library.album_ids()
                if number(library.albums[i].get("rating")) >= 5
                for member in self._favourite_members(library, i)}, key=int)
            try:
                studio._write(filename, data)
            except OSError as error:
                raise LibraryError("Could not save local album favourites. Check the settings folder.") from error
        return data, account

    def album_favourites(self, library=None):
        studio = self.studio
        with studio.lock:
            studio._require_client()
            library = library if library is not None else studio.library
            data, account = self._album_favourites(library)
            saved = set(data["accounts"][account])
            return {"albums": [str(i) for i in library.album_ids()
                               if self._favourite_members(library, i).issubset(saved)]}

    def favourite_album(self, body):
        ids = track_ids(body.get("albums"), 20)
        before, favourite = body.get("before"), body.get("favourite")
        if not ids or len(ids) != len(set(ids)) or type(favourite) is not bool \
                or not isinstance(before, list) or len(before) != len(ids) \
                or any(type(value) is not bool for value in before):
            raise LibraryError("Choose one album and its current favourite state.")
        studio = self.studio
        with studio.lock:
            studio._require_client()
            library = studio.library
            if not library or body.get("session") != studio.playback_session \
                    or type(body.get("combine_sets")) is not bool \
                    or body["combine_sets"] != library.combine_sets:
                raise ConflictError("The account or library changed. Reload the library.")
            active = set(library.album_ids())
            if not set(ids).issubset(active):
                raise ConflictError("This album is no longer available. Reload the library.")
            keys = {library.album_set_key(i) for i in ids}
            discs = [number(library.albums[i].get("disc")) for i in ids]
            if len(ids) > 1 and (len(keys) != 1 or any(i <= 0 for i in discs)
                                 or len(set(discs)) != len(ids)):
                raise LibraryError("Favourite one album or one multi-disc set at a time.")
            data, account = self._album_favourites(library)
            saved = set(data["accounts"][account])
            members = [self._favourite_members(library, i) for i in ids]
            if [group.issubset(saved) for group in members] != before:
                raise ConflictError("This album's favourite changed in another window. Reload the library.")
            if favourite:
                saved.update(set().union(*members))
            else:
                saved.difference_update(set().union(*members))
            data["accounts"][account] = sorted(saved, key=int)
            try:
                studio._write("album-favourites.json", data)
                checked, _ = self._album_favourites(library)
            except OSError as error:
                raise LibraryError("Could not save local album favourites. Reload before trying again.") from error
            saved = set(checked["accounts"][account])
            return {"results": [{"id": str(i), "favourite": group.issubset(saved)}
                                for i, group in zip(ids, members)]}

    def library(self, refresh=False, cached=False):
        client = self.studio._require_client()
        if cached and not refresh:
            library, _ = self.studio._library()
        else:
            library, _ = self.studio._current(client, refresh=refresh)
        if not library.playlists_loaded:
            library, _ = self.studio._current(client, refresh=True)
        with self.studio.lock:
            if client is not self.studio.client or library is not self.studio.library:
                raise ConflictError("The account or library changed. Reload the library.")
        return client, library

    @staticmethod
    def editable(row):
        return not row.get("system_created") and row.get("type") in (None, "", "playlist")

    def playlist_snapshot(self, row, playlist_id):
        payload = [str(playlist_id), self.studio.library_user, self.studio.playback_session,
                   self.studio.library.combine_sets, text(row.get("name")),
                   text(row.get("description")), row.get("tracks") or [],
                   row.get("type"), bool(row.get("system_created")), row.get("artwork_id")]
        return hashlib.sha256(json.dumps(payload, ensure_ascii=True).encode()).hexdigest()

    def check_playlist_before(self, row, body):
        if body.get("before_token") is not None:
            matches = body["before_token"] == self.playlist_snapshot(row, body.get("playlist"))
        else:
            track_ids(body.get("before"))
            matches = row.get("tracks", []) == body.get("before")
        if not matches or text(row.get("name")) != body.get("before_name"):
            raise ConflictError("This playlist changed in iBroadcast. Open a new review.")

    def playlists(self, query="", playlist_id=None, offset="0", browse=False):
        # Browsing shares the loaded library; writes still check the remote revision.
        _, library = self.library(cached=True)
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise LibraryError("Choose a valid playlist page.") from None
        if offset < 0 or len(text(query)) > 200:
            raise LibraryError("Choose a valid playlist page or shorter search.")
        if playlist_id is not None:
            row = library.playlists.get(number(playlist_id))
            if row and self.folder(row):
                return self.folder_view(library, number(playlist_id), offset)
            if not row or not self.editable(row):
                raise LibraryError("This playlist is unavailable or managed by iBroadcast.")
            active = [(position, i) for position, i in enumerate(
                track_ids(row.get("tracks") or [], maximum=None))
                if i in library.tracks and not library.tracks[i].get("trashed")]
            ids = [i for _, i in active]
            large = len(row.get("tracks") or []) > 10000
            # Count playlist positions, including repeats, across every page of active tracks.
            lengths = [max(0, number(library.tracks[i].get("length"))) for i in ids]
            words = fold(query).split()
            matches, searched = [], {}
            for index, i in enumerate(ids):
                if words and i not in searched:
                    haystack = playlist_track_search_text(library, i)
                    searched[i] = all(word in haystack for word in words)
                if not words or searched.get(i):
                    matches.append((index, i))
            page = matches[offset:offset + 100]
            rows = []
            for index, i in page:
                try:
                    rows.append({**library.track_row(i, library.active_track_album(i)),
                                 "position": index, "stored_position": active[index][0]})
                except LibraryError:
                    continue
            return {"id": str(number(playlist_id)), "name": text(row.get("name")),
                    "description": text(row.get("description")),
                    **self.playlist_image(library, row),
                    "tracks": [i for _, i in page] if large else ids,
                    "before": [] if large else row.get("tracks") or [],
                    "before_token": self.playlist_snapshot(row, playlist_id), "large": large,
                    "stored_total": len(row.get("tracks") or []),
                    "rows": rows, "offset": offset, "total": len(ids),
                    "matched_total": len(matches), "page_positions": [index for index, _ in page],
                    "duration": sum(lengths), "duration_missing": lengths.count(0)}
        if browse:
            return self.playlist_catalogue(library, query, offset)
        words = fold(query).split()
        rows = [{"id": str(i), "name": text(p.get("name")),
                 "description": text(p.get("description")), "count": len(p.get("tracks") or []),
                 **self.playlist_image(library, p)}
                for i, p in library.playlists.items() if self.editable(p)
                and all(w in fold(text(p.get("name"))) for w in words)]
        rows.sort(key=lambda p: fold(p["name"]))
        return {"playlists": rows[offset:offset + 100], "total": len(rows), "offset": offset}

    @staticmethod
    def folder(row):
        return not row.get("system_created") and row.get("type") == "folder"

    @staticmethod
    def playlist_image(library, row):
        artwork_id = number(row.get("artwork_id"))
        return {"artwork_id": artwork_id, "artwork": library.art_url(artwork_id) if artwork_id else ""}

    @staticmethod
    def playlist_track_summary(library, row):
        ids = track_ids(row.get("tracks") or [], maximum=None)
        active = [i for i in ids if i in library.tracks and not library.tracks[i].get("trashed")]
        lengths = [max(0, number(library.tracks[i].get("length"))) for i in active]
        return {"active_count": len(active), "unavailable_count": len(ids) - len(active),
                "duration": sum(lengths), "duration_missing": lengths.count(0)}

    def playlist_summary(self, library, playlist_id):
        row = library.playlists.get(playlist_id)
        available = row and (self.editable(row) or self.folder(row))
        if not available:
            return {"id": str(playlist_id), "name": text(row.get("name")) if row else "Unavailable playlist",
                    "kind": "unavailable", "count": 0,
                    **({"before_token": self.playlist_snapshot(row, playlist_id)} if row else {})}
        return {"id": str(playlist_id), "name": text(row.get("name")),
                "kind": "folder" if self.folder(row) else "playlist",
                "count": len(row.get("tracks") or []), "description": text(row.get("description")),
                "before_token": self.playlist_snapshot(row, playlist_id),
                **(self.playlist_track_summary(library, row) if self.editable(row) else {}),
                **self.playlist_image(library, row)}

    def playlist_catalogue(self, library, query, offset):
        eligible = {i for i, row in library.playlists.items() if self.editable(row) or self.folder(row)}
        if not query:
            contained = {i for row in library.playlists.values() if self.folder(row)
                         for i in track_ids(row.get("tracks") or [], maximum=None)}
            roots = eligible - contained
            # Malformed legacy cycles must not make an entire group unreachable.
            reached, pending = set(), list(roots)
            while pending:
                i = pending.pop()
                if i in reached or i not in eligible:
                    continue
                reached.add(i)
                row = library.playlists[i]
                if self.folder(row):
                    pending.extend(track_ids(row.get("tracks") or [], maximum=None))
            eligible = roots | (eligible - reached)
        words = fold(query).split()
        ids = [i for i in eligible if all(w in fold(library.playlists[i].get("name")) for w in words)]
        ids.sort(key=lambda i: (not self.folder(library.playlists[i]), fold(library.playlists[i].get("name")), i))
        return {"playlists": [self.playlist_summary(library, i) for i in ids[offset:offset + 100]],
                "total": len(ids), "offset": offset, "search_all": bool(query)}

    def folder_view(self, library, playlist_id, offset):
        row = library.playlists[playlist_id]
        ids = track_ids(row.get("tracks") or [], maximum=None)
        parents = [{"id": str(i), "name": text(p.get("name"))} for i, p in library.playlists.items()
                   if self.folder(p) and playlist_id in track_ids(p.get("tracks") or [], maximum=None)]
        return {"id": str(playlist_id), "name": text(row.get("name")),
                "description": text(row.get("description")), "is_folder": True,
                "before_token": self.playlist_snapshot(row, playlist_id),
                "playlists": [self.playlist_summary(library, i) for i in ids[offset:offset + 100]],
                "total": len(ids), "offset": offset, "parents": parents[:100],
                "parent_count": len(parents)}

    def folder_choices(self, query="", offset="0"):
        _, library = self.library(cached=True)
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise LibraryError("Choose a valid playlist page.") from None
        if offset < 0 or len(text(query)) > 200:
            raise LibraryError("Choose a shorter search or valid page.")
        words = fold(query).split()
        ids = [i for i, row in library.playlists.items() if (self.editable(row) or self.folder(row))
               and all(w in fold(row.get("name")) for w in words)]
        ids.sort(key=lambda i: (fold(library.playlists[i].get("name")), i))
        return {"playlists": [self.playlist_summary(library, i) for i in ids[offset:offset + 100]],
                "total": len(ids), "offset": offset}

    def _playlist_session(self, body, client):
        studio = self.studio
        if body.get("session") != studio.playback_session or not body.get("session") \
                or client is not studio.client or not studio.library_user:
            raise ConflictError("The iBroadcast connection changed. Prepare a new review.")

    def _folder_record(self, library, body):
        playlist_id = track_ids([body.get("playlist")], 1)[0]
        row = library.playlists.get(playlist_id)
        if not row or not self.folder(row):
            raise LibraryError("Choose a user playlist folder.")
        if not isinstance(body.get("before_token"), str):
            raise LibraryError("Review the current playlist folder first.")
        self.check_playlist_before(row, body)
        return playlist_id, row

    def _folder_cycle(self, library, folder_id, child_id):
        visited, pending = set(), [child_id]
        while pending:
            current = pending.pop()
            if current == folder_id:
                return True
            if current in visited:
                continue
            visited.add(current)
            row = library.playlists.get(current, {})
            if self.folder(row):
                pending.extend(track_ids(row.get("tracks") or [], maximum=None))
        return False

    def save_folder(self, body):
        action = body.get("action")
        if action not in ("create", "rename", "add", "remove", "delete") or body.get("approved") is not True:
            raise LibraryError("Review and approve the playlist folder change first.")
        name, description = text(body.get("name")).strip(), text(body.get("description")).strip()
        if action in ("create", "rename") and (not name or len(name) > 200 or len(description) > 2000):
            raise LibraryError("Use a folder name of 1–200 characters and description up to 2,000.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            self._playlist_session(body, client)
            if action == "create":
                if description:
                    raise LibraryError("Create the folder with a name first; add a description through Rename folder.")
                response = client._jsonrequest("createplaylistfolder", name=name)
                playlist_id = number(response.get("playlist_id"))
                if playlist_id <= 0 or playlist_id in library.playlists:
                    raise LibraryError("The folder ID could not be confirmed. Check Playlists before creating again.")
                expected = {"type": "folder", "name": name, "description": description, "tracks": [], "artwork_id": 0}
            else:
                playlist_id, row = self._folder_record(library, body)
                previous = track_ids(row.get("tracks") or [], maximum=None)
                expected = {"type": "folder", "name": text(row.get("name")),
                            "description": text(row.get("description")), "tracks": previous,
                            "artwork_id": number(row.get("artwork_id"))}
                fields = {"playlist": playlist_id}
                if action == "rename":
                    fields.update(name=name, description=description)
                    expected.update(name=name, description=description)
                elif action in ("add", "remove"):
                    members = body.get("members")
                    if not isinstance(members, list) or not members or len(members) > 100 or any(not isinstance(m, dict) for m in members):
                        raise LibraryError("Review 1–100 playlist references at a time.")
                    ids = track_ids([m.get("id") for m in members], 100)
                    if len(set(ids)) != len(ids):
                        raise LibraryError("Choose each playlist reference once.")
                    if action == "add":
                        for i, selected in zip(ids, members):
                            child = library.playlists.get(i)
                            if not child or not (self.editable(child) or self.folder(child)):
                                raise ConflictError("A selected playlist is no longer available.")
                            if selected.get("before_token") != self.playlist_snapshot(child, i) or selected.get("name") != text(child.get("name")):
                                raise ConflictError("A selected playlist changed. Prepare a new folder review.")
                            if self._folder_cycle(library, playlist_id, i):
                                raise LibraryError("A folder cannot contain itself or one of its parent folders.")
                        wanted = [*previous, *(i for i in ids if i not in previous)]
                    else:
                        for i, selected in zip(ids, members):
                            child = library.playlists.get(i)
                            if child and (selected.get("before_token") != self.playlist_snapshot(child, i) or selected.get("name") != text(child.get("name"))):
                                raise ConflictError("A selected playlist changed. Review its reference again.")
                            if not child and selected.get("kind") != "unavailable":
                                raise ConflictError("A selected playlist disappeared. Review its reference again.")
                        if any(i not in previous for i in ids):
                            raise ConflictError("The folder membership changed. Prepare a new review.")
                        wanted = [i for i in previous if i not in ids]
                    if action == "add" and len(wanted) > 10000:
                        raise LibraryError("Folder membership writes are limited to 10,000 references.")
                    fields["tracks"] = wanted
                    expected["tracks"] = wanted
                else:
                    if body.get("confirm_delete") is not True or previous:
                        raise LibraryError("Only an explicitly reviewed empty folder can be deleted. Its playlists are never deleted.")
                    if any(self.folder(p) and playlist_id in track_ids(p.get("tracks") or [], maximum=None) for p in library.playlists.values()):
                        raise LibraryError("Remove this folder from its parent folders first.")
                client._jsonrequest("deleteplaylist" if action == "delete" else "updateplaylist", _retry=False, **fields)

            def check(after):
                got = after.playlists.get(playlist_id)
                confirmed = playlist_id not in after.playlists if action == "delete" else bool(got) and self.folder(got) and all(
                    (number(got.get(key)) if key == "artwork_id" else text(got.get(key)) if key in ("name", "description") else got.get(key)) == value
                    for key, value in expected.items())
                return [{"id": str(playlist_id), "status": "saved" if confirmed else "unverified"}]
            return {"id": str(playlist_id), "job": studio._check_later(client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def playlist_artwork(self, body):
        studio = self.studio
        if body.get("approved") is not True or not isinstance(body.get("source"), dict):
            raise LibraryError("Compare and approve the new playlist cover first.")
        playlist_id = track_ids([body.get("playlist")], 1)[0]
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            self._playlist_session(body, client)
            row = library.playlists.get(playlist_id)
            if not row or not self.editable(row) or not isinstance(body.get("before_token"), str):
                raise LibraryError("Review an editable playlist before changing its cover.")
            self.check_playlist_before(row, body)
            before = {key: row.get(key) for key in ("name", "description", "type", "system_created", "tracks")}
            new_id = studio._image(client, body["source"], studio.library_user)
            if new_id <= 0:
                raise LibraryError("Choose a valid playlist image.")
            # A file/URL upload can take time; recheck the connection and definition.
            _, fresh = self.library()
            self._playlist_session(body, client)
            current = fresh.playlists.get(playlist_id)
            if not current or not self.editable(current):
                raise ConflictError("The playlist is no longer editable.")
            self.check_playlist_before(current, body)
            client._jsonrequest("updateplaylist", playlist=playlist_id, artwork_id=new_id, _retry=False)

            def check(after):
                got = after.playlists.get(playlist_id, {})
                confirmed = self.editable(got) and number(got.get("artwork_id")) == new_id and all(got.get(key) == value for key, value in before.items())
                return [{"id": str(playlist_id), "status": "saved" if confirmed else "unverified"}]
            return {"artwork_id": new_id, "image": fresh.art_url(new_id),
                    "job": studio._check_later(client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def queue_tracks(self, body):
        ids = track_ids(body.get("tracks"), 1000)
        library, _ = self.studio._library()
        rows = []
        for i in ids:
            album_id = library.active_track_album(i)
            t = library.track_view(i)
            a = library.albums[album_id]
            rows.append({"id": str(i), "title": t["title"], "artist": t["artist"],
                         "artistId": t["artist_id"], "performers": t["performers"],
                         "rating": t["rating"], "format": t["format"], "length": t["length"],
                         "album": {"id": str(album_id), "name": text(a.get("name")),
                                   "artist": library.artist_name(a.get("artist_id")),
                                   "artist_id": number(a.get("artist_id")), "album_artists": library.album_artist_view(a),
                                   "artwork": library.art_url(t["artwork_id"])}})
        return {"tracks": rows}

    def rate_album(self, body):
        ids = track_ids(body.get("albums"), 20)
        rating, before = body.get("rating"), body.get("before")
        if not ids or len(ids) != len(set(ids)) or type(rating) is not int or not 0 <= rating <= 5 \
                or not isinstance(before, list) or len(before) != len(ids) \
                or any(type(v) is not int or not 0 <= v <= 5 for v in before):
            raise LibraryError("Choose an album and a rating from zero to five.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client = studio._require_client()
            library, _ = studio._current(client)
            views = [library.album_view(i) for i in ids]
            # Only one displayed set: same identity, distinct disc numbers.
            keys = [library.album_set_key(i) for i in ids]
            if len(set(keys)) > 1 or (len(ids) > 1 and
                    (any(v["disc"] <= 0 for v in views) or len({v["disc"] for v in views}) != len(ids))):
                raise LibraryError("Rate one album or one multi-disc set at a time.")
            if [number(library.albums[i].get("rating")) for i in ids] != before:
                raise ConflictError("This album's rating changed. Reload before rating it.")
            sent, error = [], ""
            for i, previous in zip(ids, before):
                if previous == rating:
                    continue
                if client is not studio.client:
                    error = "The iBroadcast connection changed; remaining discs were not sent."
                    break
                try:
                    sent.append(i)  # An interrupted response may still have applied this disc.
                    client._jsonrequest("ratealbum", album_id=i, rating=rating)
                except Exception as failure:
                    error = str(failure)
                    break

            def check(after):
                return [{"id": str(i), "rating": number(after.albums.get(i, {}).get("rating")),
                         "status": "saved" if number(after.albums.get(i, {}).get("rating")) == rating
                         else "unverified" if i in sent else "not_sent"} for i in ids]

            return {"job": studio._check_later(client, studio.downloads, check, include_albums=False), "error": error}
        finally:
            studio.save_lock.release()

    def update_playlist_details(self, body):
        """Change reviewed text only; preserve every stored playlist position."""
        fields = body.get("fields")
        if body.get("approved") is not True or not isinstance(fields, dict) or not fields \
                or set(fields) - {"name", "description"} or "tracks" in body:
            raise LibraryError("Review only the playlist name or description before saving.")
        if any(not isinstance(value, str) or len(value) > (200 if key == "name" else 2000)
               for key, value in fields.items()) or ("name" in fields and not fields["name"].strip()):
            raise LibraryError("Use a playlist name of 1–200 characters and description up to 2,000.")
        playlist_id = track_ids([body.get("playlist")], 1)[0]
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            self._playlist_session(body, client)
            row = library.playlists.get(playlist_id)
            if not row or not self.editable(row) or not isinstance(body.get("before_token"), str):
                raise LibraryError("Review an editable playlist before changing its details.")
            self.check_playlist_before(row, body)
            changed = {key: value for key, value in fields.items() if value != text(row.get(key))}
            if not changed:
                raise LibraryError("No playlist details changed.")
            expected = {key: row.get(key) for key in
                        ("name", "description", "tracks", "type", "system_created", "artwork_id")}
            expected.update(changed)
            client._jsonrequest("updateplaylist", playlist=playlist_id, _retry=False, **changed)

            def check(after):
                got = after.playlists.get(playlist_id, {})
                matches = self.editable(got) and all(
                    (text(got.get(key)) == text(value) if key in ("name", "description")
                     else got.get(key) == value) for key, value in expected.items())
                return [{"id": str(playlist_id), "status": "saved" if matches else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(
                client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def playlist_order_record(self, body, client, library):
        self._playlist_session(body, client)
        if library is not self.studio.library:
            raise ConflictError("The library changed. Reopen the playlist order editor.")
        playlist_id = track_ids([body.get("playlist")], 1)[0]
        row = library.playlists.get(playlist_id)
        if not row or not self.editable(row) or not isinstance(body.get("before_token"), str):
            raise LibraryError("Open an editable playlist before changing its order.")
        self.check_playlist_before(row, body)
        if len(row.get("tracks") or []) > 10000:
            raise LibraryError("Playlist reordering is limited to 10,000 saved positions.")
        return playlist_id, row

    def playlist_order_view(self, body):
        """Read at most one page of original positions, including unavailable copies."""
        client, library = self.library(cached=True)
        with self.studio.lock:
            _, row = self.playlist_order_record(body, client, library)
            query = body.get("query")
            if query is not None:
                if not isinstance(query, str) or len(query) > 200:
                    raise LibraryError("Use a playlist search of up to 200 characters.")
                words, searched, matches = fold(query).split(), {}, []
                for position, track_id in enumerate(track_ids(row.get("tracks") or [])):
                    if track_id not in searched:
                        haystack = playlist_track_search_text(library, track_id)
                        searched[track_id] = all(word in haystack for word in words)
                    if searched[track_id]:
                        matches.append(position)
                return {"positions": matches}
            positions = body.get("positions")
            if not isinstance(positions, list) or not 1 <= len(positions) <= 100 or any(
                    not isinstance(p, str) or not p.isascii() or not p.isdigit() for p in positions):
                raise LibraryError("Choose up to 100 saved playlist positions.")
            positions = [int(p) for p in positions]
            ids = track_ids(row.get("tracks") or [])
            if len(set(positions)) != len(positions) or any(p >= len(ids) for p in positions):
                raise LibraryError("These playlist positions are no longer available.")
            rows = []
            for position in positions:
                track_id = ids[position]
                try:
                    track = library.track_row(track_id, library.active_track_album(track_id))
                    rows.append({**track, "source_position": position, "available": True})
                except LibraryError:
                    rows.append({"id": str(track_id), "title": "Unavailable track", "artist": "",
                                 "source_position": position, "available": False})
            return {"rows": rows}

    def reorder_playlist(self, body):
        """Permute stored positions only; never deduplicate or replace playlist metadata."""
        if body.get("approved") is not True or "tracks" in body:
            raise LibraryError("Review and confirm the new playlist order first.")
        positions = body.get("positions")
        if not isinstance(positions, list) or not 2 <= len(positions) <= 10000 or any(
                type(p) is not int for p in positions) or sorted(positions) != list(range(len(positions))):
            raise LibraryError("Keep every saved playlist position exactly once.")
        if positions == list(range(len(positions))):
            raise LibraryError("The playlist order has not changed.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            with studio.lock:
                playlist_id, row = self.playlist_order_record(body, client, library)
                original = track_ids(row.get("tracks") or [])
                if len(original) != len(positions):
                    raise ConflictError("The playlist membership changed. Open a new order review.")
                expected = [original[p] for p in positions]
                if expected == original:
                    raise LibraryError("The playlist order has not changed.")
                metadata = {k: row.get(k) for k in
                            ("name", "description", "type", "system_created", "artwork_id")}
            client._jsonrequest("updateplaylist", playlist=playlist_id, tracks=expected, _retry=False)

            def check(after):
                got = after.playlists.get(playlist_id, {})
                matches = self.editable(got) and got.get("tracks") == expected and all(
                    got.get(key) == value for key, value in metadata.items())
                return [{"id": str(playlist_id), "status": "saved" if matches else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(
                client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def remove_playlist_track(self, body):
        """Remove exactly one reviewed stored position, preserving every other copy."""
        position = body.get("position")
        if body.get("approved") is not True or type(position) is not int or position < 0 \
                or "tracks" in body:
            raise LibraryError("Review one playlist position before removing it.")
        track_id = track_ids([body.get("track")], 1)[0]
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            with studio.lock:
                playlist_id, row = self.playlist_order_record(body, client, library)
                original = track_ids(row.get("tracks") or [])
                if position >= len(original) or original[position] != track_id:
                    raise ConflictError("This playlist position changed. Prepare a new review.")
                library.active_track_album(track_id)
                expected = original[:position] + original[position + 1:]
                metadata = {k: row.get(k) for k in
                            ("name", "description", "type", "system_created", "artwork_id")}
            client._jsonrequest("updateplaylist", playlist=playlist_id, tracks=expected, _retry=False)

            def check(after):
                got = after.playlists.get(playlist_id, {})
                matches = self.editable(got) and got.get("tracks") == expected and all(
                    got.get(key) == value for key, value in metadata.items())
                return [{"id": str(playlist_id), "status": "saved" if matches else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(
                client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def save_playlist(self, body):
        action = body.get("action")
        if action == "metadata":
            return self.update_playlist_details(body)
        if action == "reorder":
            return self.reorder_playlist(body)
        if action == "remove-track":
            return self.remove_playlist_track(body)
        if action == "delete":
            return self.delete_playlist(body)
        name, description = text(body.get("name")).strip(), text(body.get("description")).strip()
        ids = list(dict.fromkeys(track_ids(body.get("tracks"))))
        if action not in ("create", "append", "replace") or len(name) > 200 \
                or len(description) > 2000 or (action == "create" and not name):
            raise LibraryError("Choose a playlist action and a name of up to 200 characters.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            for i in ids:
                library.active_track_album(i)
            if client is not studio.client:
                raise LibraryError("The iBroadcast connection changed. Prepare a new review.")
            playlist_id = number(body.get("playlist"))
            if action == "create":
                result = client._jsonrequest("createplaylist", name=name, description=description,
                                             make_public=False, tracks=ids)
                playlist_id = number(result.get("playlist_id"))
                if not playlist_id:
                    raise LibraryError("iBroadcast returned no playlist ID. Check Playlists before creating again.")
                expected = ids
            else:
                row = library.playlists.get(playlist_id)
                if not row or not self.editable(row):
                    raise LibraryError("Choose a user playlist; system playlists cannot be changed.")
                self.check_playlist_before(row, body)
                if action == "replace" and len(row.get("tracks") or []) > 10000:
                    raise LibraryError("Full playlist replacement is limited to 10,000 tracks. Append or manage this playlist in iBroadcast.")
                expected = list(dict.fromkeys([*(row.get("tracks") or []), *ids])) if action == "append" else ids
                payload = {"playlist": playlist_id, "tracks": ids}
                if action == "replace":
                    name = name or text(row.get("name"))
                    if name != text(row.get("name")):
                        payload["name"] = name
                    if description != text(row.get("description")):
                        payload["description"] = description
                    if ids == row.get("tracks"):
                        payload.pop("tracks")
                client._jsonrequest("appendplaylist" if action == "append" else "updateplaylist", **payload)

            def check(after):
                row = after.playlists.get(playlist_id, {})
                matches = row.get("tracks") == expected and (action == "append" or (
                    text(row.get("name")) == name and text(row.get("description")) == description))
                return [{"id": str(playlist_id), "status": "saved" if matches else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()

    def delete_playlist(self, body):
        playlist_id = track_ids([body.get("playlist")], 1)[0]
        if body.get("confirm_delete") is not True:
            raise LibraryError("Review and confirm deleting this playlist first.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            row = library.playlists.get(playlist_id)
            if not row or not self.editable(row):
                raise LibraryError("Choose a user playlist; system playlists cannot be deleted.")
            self.check_playlist_before(row, body)
            if client is not studio.client:
                raise LibraryError("The iBroadcast connection changed. Prepare a new review.")
            # Delete only the playlist definition; never send track trash requests.
            client._jsonrequest("deleteplaylist", playlist=playlist_id)

            def check(after):
                return [{"id": str(playlist_id), "status": "saved" if playlist_id not in after.playlists else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()
