"""Native album ratings and private playlists; all writes are reviewed and read back."""

from .library import ConflictError, LibraryError, fold, number, text


def track_ids(values, maximum=10000):
    if not isinstance(values, list) or len(values) > maximum or any(
            type(i) not in (int, str) or not str(i).isdigit() or int(i) <= 0 for i in values):
        raise LibraryError(f"Choose up to {maximum} valid tracks.")
    return [int(i) for i in values]


class Collections:
    def __init__(self, studio):
        self.studio = studio

    def library(self, refresh=False):
        client = self.studio._require_client()
        library, _ = self.studio._current(client, refresh=refresh)
        if not library.playlists_loaded:
            library, _ = self.studio._current(client, refresh=True)
        return client, library

    @staticmethod
    def editable(row):
        return not row.get("system_created") and row.get("type") in (None, "", "playlist")

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
            ids = [i for i in track_ids(row.get("tracks") or [])
                   if i in library.tracks and not library.tracks[i].get("trashed")]
            rows = []
            for index, i in enumerate(ids[offset:offset + 100], offset):
                try:
                    rows.append({**library.track_row(i, library.active_track_album(i)),
                                 "position": index})
                except LibraryError:
                    continue
            return {"id": str(number(playlist_id)), "name": text(row.get("name")),
                    "description": text(row.get("description")), "tracks": ids,
                    "before": row.get("tracks") or [],
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
            keys = [(v["name"], v["artist_id"], v["year"],
                     tuple(sorted({t["uploaded_on"] for t in v["tracks"]}))) for v in views]
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
                if row.get("tracks", []) != body.get("before") or text(row.get("name")) != body.get("before_name"):
                    raise ConflictError("This playlist changed in iBroadcast. Open a new preview.")
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
        track_ids(body.get("before"))
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            row = library.playlists.get(playlist_id)
            if not row or not self.editable(row):
                raise LibraryError("Choose a user playlist; system playlists cannot be deleted.")
            if row.get("tracks", []) != body.get("before") or text(row.get("name")) != body.get("before_name"):
                raise ConflictError("This playlist changed in iBroadcast. Open a new review.")
            if client is not studio.client:
                raise LibraryError("The iBroadcast connection changed. Prepare a new review.")
            # Delete only the playlist definition; never send track trash requests.
            client._jsonrequest("deleteplaylist", playlist=playlist_id)

            def check(after):
                return [{"id": str(playlist_id), "status": "saved" if playlist_id not in after.playlists else "unverified"}]

            return {"id": str(playlist_id), "job": studio._check_later(client, studio.downloads, check, include_albums=False)}
        finally:
            studio.save_lock.release()
