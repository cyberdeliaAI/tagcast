"""Local album/artist favourites, native ratings and reviewed private playlists."""

import hashlib
import json

from .library import ConflictError, LibraryError, fold, number, text


def track_ids(values, maximum=10000):
    if not isinstance(values, list) or (maximum is not None and len(values) > maximum) or any(
            type(i) not in (int, str) or not str(i).isdigit() or int(i) <= 0 for i in values):
        raise LibraryError(f"Choose up to {maximum} valid tracks.")
    return [int(i) for i in values]


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

    def library(self, refresh=False):
        client = self.studio._require_client()
        library, _ = self.studio._current(client, refresh=refresh)
        if not library.playlists_loaded:
            library, _ = self.studio._current(client, refresh=True)
        return client, library

    @staticmethod
    def editable(row):
        return not row.get("system_created") and row.get("type") in (None, "", "playlist")

    def playlist_snapshot(self, row, playlist_id):
        payload = [str(playlist_id), self.studio.library_user, self.studio.playback_session,
                   self.studio.library.combine_sets, text(row.get("name")),
                   text(row.get("description")), row.get("tracks") or []]
        return hashlib.sha256(json.dumps(payload, ensure_ascii=True).encode()).hexdigest()

    def check_playlist_before(self, row, body):
        if body.get("before_token") is not None:
            matches = body["before_token"] == self.playlist_snapshot(row, body.get("playlist"))
        else:
            track_ids(body.get("before"))
            matches = row.get("tracks", []) == body.get("before")
        if not matches or text(row.get("name")) != body.get("before_name"):
            raise ConflictError("This playlist changed in iBroadcast. Open a new review.")

    def playlists(self, query="", playlist_id=None, offset="0"):
        _, library = self.library()
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise LibraryError("Choose a valid playlist page.") from None
        if offset < 0 or len(text(query)) > 200:
            raise LibraryError("Choose a valid playlist page or shorter search.")
        if playlist_id is not None:
            row = library.playlists.get(number(playlist_id))
            if not row or not self.editable(row):
                raise LibraryError("This playlist is unavailable or managed by iBroadcast.")
            ids = [i for i in track_ids(row.get("tracks") or [], maximum=None)
                   if i in library.tracks and not library.tracks[i].get("trashed")]
            large = len(row.get("tracks") or []) > 10000
            rows = []
            for index, i in enumerate(ids[offset:offset + 100], offset):
                try:
                    rows.append({**library.track_row(i, library.active_track_album(i)),
                                 "position": index})
                except LibraryError:
                    continue
            return {"id": str(number(playlist_id)), "name": text(row.get("name")),
                    "description": text(row.get("description")),
                    "tracks": ids[offset:offset + 100] if large else ids,
                    "before": [] if large else row.get("tracks") or [],
                    "before_token": self.playlist_snapshot(row, playlist_id), "large": large,
                    "stored_total": len(row.get("tracks") or []),
                    "rows": rows, "offset": offset, "total": len(ids)}
        words = fold(query).split()
        rows = [{"id": str(i), "name": text(p.get("name")),
                 "description": text(p.get("description")), "count": len(p.get("tracks") or [])}
                for i, p in library.playlists.items() if self.editable(p)
                and all(w in fold(text(p.get("name"))) for w in words)]
        rows.sort(key=lambda p: fold(p["name"]))
        return {"playlists": rows[offset:offset + 100], "total": len(rows), "offset": offset}

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
                    client._jsonrequest("ratealbum", album_id=i, rating=rating)
                    sent.append(i)
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

    def save_playlist(self, body):
        action = body.get("action")
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
                    payload.update(name=name or text(row.get("name")), description=description)
                client._jsonrequest("appendplaylist" if action == "append" else "updateplaylist", **payload)

            def check(after):
                row = after.playlists.get(playlist_id, {})
                matches = row.get("tracks") == expected and (action == "append" or text(row.get("name")) == name)
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
