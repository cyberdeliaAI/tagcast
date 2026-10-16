"""Explicit, reviewed batches of the album page's format/upload-date suggestions.

Only cached metadata is analysed. A persisted intent is checked after a restart;
an ambiguous trash request is never automatically sent again.
"""

import copy
import logging
import secrets
import threading
from collections import Counter

from .library import TITLE_QUOTES, LibraryError, number

log = logging.getLogger("tagcast")
BATCH_TRACKS = 200
BATCH_ALBUMS = 20
TRACK_FIELDS = ("id", "album_id", "track", "title", "artist", "artist_id", "performers",
                "length", "format", "uploaded_on", "uploaded_at")


def suggest_copies(tracks):
    """Match trashSuggestion in trash.js, for one repeated position on one disc."""
    artists = {t["artist"].strip().lower() for t in tracks if t["artist"].strip()}
    lengths = [t["length"] for t in tracks if t["length"] > 0]
    titles = {" ".join(t["title"].translate(TITLE_QUOTES).lower().split()) for t in tracks}
    reason = ""
    if len(artists) > 1:
        reason = "Different track artists; compare manually."
    elif lengths and max(lengths) - min(lengths) > 2:
        reason = "Durations differ by more than two seconds; compare versions."
    elif len(titles) > 1 and (len(lengths) != len(tracks) or len(artists) != 1):
        reason = "Different titles and incomplete comparison metadata."
    formats = {t["format"] for t in tracks}
    if not reason and ("" in formats or len(formats) > 1 and not formats <= {"FLAC", "MP3"}):
        reason = "Unknown or incomparable file formats."
    if reason:
        return [{**t, "choice": "manual", "reason": reason} for t in tracks]
    flac = formats == {"FLAC", "MP3"}
    preferred = [t for t in tracks if not flac or t["format"] == "FLAC"]
    if all(t["uploaded_at"] for t in preferred):
        day = max(t["uploaded_at"][:10] for t in preferred)
        preferred = [t for t in preferred if t["uploaded_at"][:10] == day]
        if all(len(t["uploaded_at"]) == 19 for t in preferred):
            stamp = max(t["uploaded_at"] for t in preferred)
            preferred = [t for t in preferred if t["uploaded_at"] == stamp]
    retained = {t["id"] for t in preferred}
    result = []
    for track in tracks:
        if track["id"] not in retained:
            choice, reason = "trash", "FLAC copy available." if flac and track["format"] != "FLAC" else "Older upload in this format."
        elif len(preferred) == 1:
            choice, reason = "keep", "Preferred FLAC copy." if flac else "Newest upload in this format."
        else:
            choice, reason = "manual", "No unique newest copy; compare these copies."
        if len(titles) > 1:
            reason += " Titles differ; compare versions before confirming."
        result.append({**track, "choice": choice, "reason": reason})
    return result


def positions(library, album_id):
    """Original album IDs keep native combined discs separate, like the album page."""
    result = {}
    for track_id in dict.fromkeys(library.active_track_ids(album_id)):
        raw = library.tracks[track_id]
        position = number(raw.get("track"))
        if position > 0:
            key = (number(raw.get("album_id")), position)
            result.setdefault(key, []).append(track_id)
    return result


def track_snapshot(library, track_id):
    track = library.track_view(track_id)
    return {key: track[key] for key in TRACK_FIELDS}


class DuplicateCleanup:
    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.running = False
        self.task = studio._read("duplicate-cleanup.json") or None
        if self.task and self.task.get("state") == "running":
            self.task["state"] = "stopped"
            self.task["error"] = "Tagcast stopped. Resume first checks outstanding requests; it never retries uncertain ones."

    def _persist(self):
        self.studio._write("duplicate-cleanup.json", self.task)

    def _owner(self, client):
        if client is not self.studio.client or self.task and self.task["owner"] != self.studio.library_user:
            raise LibraryError("This duplicate cleanup belongs to a different account or connection.")

    def prepare(self):
        client = self.studio._require_client()
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            library, _ = self.studio._current(client)
            library._browse_index("genres")  # same displayed sets as albumShelf
            with self.lock:
                if client is not self.studio.client:
                    raise LibraryError("The connection changed. Reopen duplicate cleanup.")
                groups, scanned, seen = {}, set(), set()
                for album_id in library.album_ids():
                    for key, ids in positions(library, album_id).items():
                        if len(ids) < 2 or seen.intersection(ids):
                            continue
                        seen.update(ids)
                        group_id = str(library._browse_albums[album_id])
                        scanned.add(group_id)
                        album = library.albums[album_id]
                        group = groups.setdefault(group_id, {"id": group_id,
                            "album": album.get("name") or "Untitled album",
                            "artist": library.artist_name(album.get("artist_id")), "positions": []})
                        tracks = [track_snapshot(library, i) for i in ids]
                        group["positions"].append({"album_id": album_id, "original_album_id": key[0],
                            "number": key[1], "disc": number(album.get("disc")),
                            "tracks": [{**t, "status": "pending" if t["choice"] == "trash" else "retained"}
                                       for t in suggest_copies(tracks)]})
                self.task = {"id": secrets.token_urlsafe(16), "owner": self.studio.library_user,
                    "combine_sets": library.combine_sets, "state": "preview", "error": "",
                    "groups": list(groups.values()), "scanned": len(scanned), "excluded": []}
                self._persist()
            return self.view()
        finally:
            self.studio.save_lock.release()

    def _items(self):
        return [t for g in self.task["groups"] for p in g["positions"] for t in p["tracks"]
                if t["choice"] == "trash"]

    def view(self, offset=0, limit=10, report=False):
        self.studio._require_client()
        try:
            offset, limit = int(offset), int(limit)
        except (ValueError, TypeError):
            raise LibraryError("Invalid duplicate cleanup page.") from None
        if offset < 0 or not 1 <= limit <= 20:
            raise LibraryError("Invalid duplicate cleanup page.")
        self.studio._library()  # identify the account before exposing a persisted report
        with self.lock:
            self._owner(self.studio.client)
            if not self.task:
                return {"state": "empty"}
            task, items = self.task, self._items()
            result = {k: copy.deepcopy(task[k]) for k in ("id", "state", "error", "excluded", "scanned")}
            result.update(tracks=len(items), albums=len(task["groups"]), offset=offset,
                counts=dict(Counter(t["status"] for t in items)), batch_tracks=BATCH_TRACKS,
                batch_albums=BATCH_ALBUMS,
                manual=sum(any(t["choice"] == "manual" for t in p["tracks"])
                           for g in task["groups"] for p in g["positions"]),
                groups=copy.deepcopy(task["groups"] if report else task["groups"][offset:offset + limit]),
                selection=[{"id": t["id"], "group": g["id"]} for g in task["groups"]
                           for p in g["positions"] for t in p["tracks"] if t["choice"] == "trash"])
            return result

    def start(self, task_id, excluded=None, approved=False):
        client = self.studio._require_client()
        if approved is not True:
            raise LibraryError("Review and approve the selected copies first.")
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            self.studio._current(client)
            with self.lock:
                self._owner(client)
                if not self.task or task_id != self.task["id"] or self.running or self.task["state"] == "done":
                    raise LibraryError("This duplicate cleanup is no longer available.")
                items = self._items()
                if self.task["state"] == "preview":
                    if not isinstance(excluded, list) or any(not isinstance(i, str) for i in excluded) \
                            or not set(excluded) <= {t["id"] for t in items}:
                        raise LibraryError("Choose which proposed copies to exclude.")
                    if not any(t["id"] not in excluded for t in items):
                        raise LibraryError("Select at least one proposed copy.")
                    self.task["excluded"] = excluded
                    for track in items:
                        if track["id"] in excluded:
                            track["status"] = "excluded"
                self.task["state"], self.task["error"] = "running", ""
                self.stop.clear()
                self._persist()
                self.running = True
            result = self.view()
            threading.Thread(target=self._run, args=(client,), daemon=True).start()
        except Exception:
            self.running = False
            self.studio.save_lock.release()
            raise
        return result

    def cancel(self, task_id):
        with self.lock:
            self._owner(self.studio._require_client())
            if not self.task or task_id != self.task["id"]:
                raise LibraryError("This duplicate cleanup is no longer available.")
            self.stop.set()
        return self.view()

    @staticmethod
    def _gone(library, track):
        raw = library.tracks.get(number(track["id"]))
        return raw is None or bool(raw.get("trashed"))

    def _validate(self, library, position):
        expected = {number(t["id"]): {k: t[k] for k in TRACK_FIELDS}
                    for t in position["tracks"] if t["status"] != "confirmed"}
        key = (position["original_album_id"], position["number"])
        ids = positions(library, position["album_id"]).get(key, [])
        if set(ids) != set(expected) or any(track_snapshot(library, i) != expected[i] for i in ids):
            raise LibraryError("A repeated position changed since the preview. Prepare a new analysis.")
        album = library.albums.get(position["album_id"])
        if not album or album.get("trashed"):
            raise LibraryError("An album is no longer active. Prepare a new analysis.")

    def _run(self, client):
        try:
            first = True
            while not self.stop.is_set():
                self._owner(client)
                fresh, _ = self.studio._current(client, refresh=first)
                first = False
                self._owner(client)
                with self.lock:
                    if fresh.combine_sets != self.task["combine_sets"]:
                        raise LibraryError("The multi-disc setting changed. Prepare a new analysis.")
                    # Check persisted intent before considering any new writes. Never resend it.
                    for track in self._items():
                        if track["status"] in ("sent", "unconfirmed"):
                            track["status"] = "confirmed" if self._gone(fresh, track) else "unconfirmed"
                    self._persist()
                    if any(t["status"] == "unconfirmed" for t in self._items()):
                        raise LibraryError("An earlier trash request is still unconfirmed. It will not be retried. Inspect iBroadcast and prepare a new analysis.")
                    batch, albums = [], set()
                    for group in self.task["groups"]:
                        for position in group["positions"]:
                            pending = [t for t in position["tracks"] if t["status"] in ("pending", "conflict")]
                            if not pending:
                                continue
                            if len(batch) >= BATCH_TRACKS or group["id"] not in albums and len(albums) >= BATCH_ALBUMS:
                                break
                            try:
                                self._validate(fresh, position)
                            except LibraryError:
                                for track in pending:
                                    track["status"] = "conflict"
                                raise
                            albums.add(group["id"])
                            batch.extend(pending[:BATCH_TRACKS - len(batch)])
                        if len(batch) >= BATCH_TRACKS or len(albums) >= BATCH_ALBUMS:
                            break
                    if not batch:
                        self.task["state"] = "done"
                        break
                    self._owner(client)
                    if self.stop.is_set():
                        break
                    for track in batch:
                        track["status"] = "sent"
                    self._persist()  # record intent before a possibly interrupted POST
                failure = None
                try:
                    client._jsonrequest("trash", tracks=[number(t["id"]) for t in batch])
                except Exception as error:
                    failure = error
                try:
                    after, _ = self.studio._current(client, refresh=True)
                    self._owner(client)
                    with self.lock:
                        for track in batch:
                            track["status"] = "confirmed" if self._gone(after, track) else "unconfirmed"
                        self._persist()
                except Exception:
                    with self.lock:
                        for track in batch:
                            track["status"] = "unconfirmed"
                    raise
                if failure:
                    raise LibraryError(f"The trash request did not complete normally: {failure}")
                if any(t["status"] != "confirmed" for t in batch):
                    raise LibraryError("Some copies could not be confirmed in the trash. Processing stopped.")
        except Exception as error:
            log.warning("Duplicate cleanup stopped: %s", error)
            with self.lock:
                self.task["state"], self.task["error"] = "error", str(error)
        finally:
            with self.lock:
                if self.task["state"] == "running":
                    self.task["state"] = "stopped"
                try:
                    self._persist()
                finally:
                    self.running = False
                    self.studio.save_lock.release()
