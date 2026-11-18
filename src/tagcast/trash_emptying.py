"""Explicitly reviewed empty_trash, never permanent Track Dashboard deletion."""

import hashlib
import json

from .album_merge import AlbumMerge
from .library import ConflictError, LibraryError, number, text

MAX_TRASH_REVIEW = 10000  # Tagcast bound, not a documented service maximum.
TRASH_PAGE_SIZE = 50


class TrashEmptying(AlbumMerge):
    """Reuse only the bounded, expiring token store; no album mutation methods."""

    def _owner(self, body, expected=None):
        studio = self.studio
        client = studio._require_client()
        with studio.lock:
            owner = (client, studio.library_user, studio.playback_session)
            if client is not studio.client or not owner[2] or body.get("session") != owner[2] or expected is not None and owner != expected:
                raise ConflictError("The account or library changed. Review the trash again.",
                                    code="trash_empty.session")
        return owner

    def _get(self, table, token, consume=False):
        try:
            return super()._get(table, token, consume)
        except ConflictError as error:
            raise ConflictError("This trash review expired or was already used. Review the trash again.",
                                code="trash_empty.expired") from error

    @staticmethod
    def _snapshot(library):
        rows, digest = [], hashlib.sha256()
        digest.update(json.dumps(library.combine_sets).encode())
        for tid, track in sorted(library.tracks.items()):
            flag = track.get("trashed", False)
            if flag is not None and not (type(flag) is bool or type(flag) is int and flag in (0, 1)):
                raise LibraryError("The trash contains unreadable track data. Reload the library before reviewing it.",
                                   code="trash_empty.shape")
            if not flag:
                continue
            if type(tid) is not int or tid <= 0:
                raise LibraryError("The trash contains unreadable track data. Reload the library before reviewing it.",
                                   code="trash_empty.shape")
            title, artist = text(track.get("title")), library.artist_name(track.get("artist_id"))
            album_id = number(track.get("album_id"))
            album = text(library.albums.get(album_id, {}).get("name"))
            if any(len(value) > 1000 for value in (title, artist, album)):
                raise LibraryError("The trash contains unreadable track data. Reload the library before reviewing it.",
                                   code="trash_empty.shape")
            identity = [tid, album_id, track.get("artist_id"), title, artist, album,
                        track.get("track"), track.get("year")]
            digest.update(json.dumps(identity, separators=(",", ":")).encode())
            digest.update(b"\n")
            rows.append({"id": str(tid), "title": title, "artist": artist, "album": album})
            if len(rows) > MAX_TRASH_REVIEW:
                raise LibraryError("This trash exceeds Tagcast's 10,000-track review limit. Use iBroadcast to empty it.",
                                   code="trash_empty.limit")
        return rows, digest.hexdigest()

    @staticmethod
    def _page(review, token, offset=0):
        if type(offset) is not int or offset < 0 or offset % TRASH_PAGE_SIZE \
                or offset >= max(1, len(review["rows"])):
            raise LibraryError("Choose a valid trash review page.", code="trash_empty.page")
        return {"review": token, "count": len(review["rows"]), "digest": review["digest"],
                "offset": offset, "limit": TRASH_PAGE_SIZE,
                "tracks": review["rows"][offset:offset + TRASH_PAGE_SIZE]}

    def review(self, body):
        owner = self._owner(body)
        # Always ask for the remote revision; reuse only a matching account/combine
        # snapshot. A changed or unknown revision still downloads the library.
        library, _ = self.studio._current(owner[0])
        self._owner(body, owner)
        rows, digest = self._snapshot(library)
        review = {"owner": owner, "rows": rows, "digest": digest}
        with self.studio.lock:
            self._owner(body, owner)
            token = self._store(self.reviews, review) if rows else ""
        return self._page(review, token)

    def page(self, body):
        token = body.get("review")
        review = self._get(self.reviews, token)
        self._owner(body, review["owner"])
        return self._page(review, token, body.get("offset", 0))

    def save(self, body):
        if body.get("approved") is not True or body.get("acknowledged") is not True:
            raise LibraryError("Review the trash and confirm emptying it first.", code="trash_empty.approval")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.", code="trash_empty.busy")
        try:
            review = self._get(self.reviews, body.get("review"), consume=True)
            owner = self._owner(body, review["owner"])
            client = owner[0]
            fresh, _ = studio._current(client)
            _, digest = self._snapshot(fresh)
            self._owner(body, owner)
            if digest != review["digest"]:
                raise ConflictError("The iBroadcast trash changed. Review it again before emptying it.",
                                    code="trash_empty.changed")
            tracks = [int(row["id"]) for row in review["rows"]]
            # Runtime import avoids Studio -> feature -> Studio import cycles.
            from .client import UncertainWrite
            error = ""
            try:
                response = client._jsonrequest("empty_trash", _retry=False, tracks=tracks)
                if response.get("result") is not True:
                    raise UncertainWrite("iBroadcast did not confirm emptying the trash.")
            except UncertainWrite as failure:
                error = (f"The trash request could not be confirmed: {failure} "
                         "Checking the library; no automatic retry.")

            def check(after):
                # An externally restored track is not an emptied track. Only absence
                # from the library confirms the official empty_trash transition.
                complete = all(tid not in after.tracks for tid in tracks)
                return [{"kind": "trash", "id": "empty", "label": "iBroadcast trash", "fields": [],
                         "status": "saved" if complete else "unverified"}]

            job = studio._check_later(client, studio.downloads, check)
            return {"job": job, "count": len(tracks), "digest": review["digest"], "error": error}
        finally:
            studio.save_lock.release()
