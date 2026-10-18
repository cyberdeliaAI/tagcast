"""Reviewed, resumable splitting and exact genre replacement, outside the scoped editor.

Only track genres and artist credits are writable here. Credit payloads follow the
public web player's iBroadcastLibraryEditor.js, inspected on 2026-10-11.
"""

import copy
import logging
import secrets
import threading
from collections import Counter

from .library import MAX_GENRE_LENGTH, MAX_GENRES, LibraryError, number, stored_genres, text

log = logging.getLogger("tagcast")
CATEGORIES = {"genres", "track-artists", "composers", "genre-labels"}
BATCH_TRACKS = 200
BATCH_ALBUMS = 20


def split_labels(values):
    out, seen = [], set()
    for value in values:
        for name in text(value).split(";"):
            name = name.strip()
            if name and name.casefold() not in seen:
                seen.add(name.casefold())
                out.append(name)
    return out


def credit_state(library, track):
    return [{"artist_id": e["artist_id"], "phrase": e.get("phrase"), "type": e.get("type")}
            for e in library.extra_artists(track)]


def snapshot(library, track, category):
    if category in ("genres", "genre-labels"):
        return {"genre": text(track.get("genre")),
                "genres_additional": list(track.get("genres_additional") or [])}
    return {"artist_id": number(track.get("artist_id")),
            "artists_additional": credit_state(library, track)}


def candidate(library, track_id, category, mapping=None):
    """Build a named draft, preserving unrelated credits and per-track values."""
    track = library.tracks[track_id]
    before = snapshot(library, track, category)
    if category in ("genres", "genre-labels"):
        values = stored_genres(track)
        if category == "genre-labels":
            if mapping["label"] not in values:
                return None
            after, seen = [], set()
            for value in values:
                for name in mapping["replacements"] if value == mapping["label"] else [value]:
                    if name.casefold() not in seen:
                        seen.add(name.casefold())
                        after.append(name)
        else:
            if not any(";" in v for v in values):
                return None
            after = split_labels(values)
        removing = category == "genre-labels" and mapping.get("remove") is True
        if (not after and not removing) or len(after) > MAX_GENRES or any(len(n) > MAX_GENRE_LENGTH for n in after):
            raise LibraryError("Genres must contain 1–20 labels of at most 200 characters.")
        wire = {"genre": after[0] if after else "", "genres_additional": after[1:]}
        if wire == before:
            return None
        return {"before": before, "after": wire, "display_before": values,
                "display_after": after}
    primary = library.artist_name(track.get("artist_id"))
    credits = before["artists_additional"]
    split_primary = category == "track-artists" and ";" in primary
    changed = split_primary
    primary_names = split_labels([primary]) if split_primary else [primary]
    if not primary_names:
        raise LibraryError("A split track artist must have a name.")
    after = [{"name": n, "type": "artist", "phrase": None} for n in primary_names[1:]]
    display_before = [primary] if category == "track-artists" else []
    display_after = list(primary_names) if category == "track-artists" else []
    for entry in credits:
        name = library.artist_name(entry["artist_id"])
        targeted = (entry["type"] == "composer" if category == "composers"
                    else entry["type"] in (None, "", "artist", "band"))
        names = split_labels([name]) if targeted and ";" in name else [name]
        changed |= targeted and ";" in name
        if targeted:
            display_before.append(name)
            display_after.extend(names)
        if targeted and ";" in name:
            if not names:
                raise LibraryError("A split artist credit must have a name.")
            after.extend({"name": n, "type": entry["type"] or "artist",
                          "phrase": entry["phrase"]} for n in names)
        else:
            after.append(dict(entry))  # leave non-targeted credits, IDs and roles intact
    if not changed:
        return None
    if any(not n or len(n) > 1000 for n in display_after):
        raise LibraryError("Artist names must contain 1–1,000 characters.")
    return {"before": before, "after": {"primary": primary_names[0],
                                       "primary_id": None if split_primary else before["artist_id"],
                                       "credits": after},
            "display_before": display_before, "display_after": display_after}


class Cleanup:
    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.task = studio._read("cleanup.json") or None
        if self.task and self.task.get("state") == "running":
            self.task["state"] = "stopped"
            self.task["error"] = "Tagcast stopped. Resume will first check any outstanding writes."
        self.running = False

    def _persist(self):
        self.studio._write("cleanup.json", self.task)

    def _owner(self, client):
        if client is not self.studio.client:
            raise LibraryError("The account connection changed. Stop and open cleanup again.")
        if self.task and self.task["owner"] != self.studio.library_user:
            raise LibraryError("This cleanup belongs to another iBroadcast account.")

    def labels(self, query="", offset=0, limit=50):
        self.studio._require_client()
        try:
            offset, limit = int(offset), int(limit)
        except (ValueError, TypeError):
            raise LibraryError("Invalid genre label page.") from None
        if offset < 0 or not 1 <= limit <= 100:
            raise LibraryError("Invalid genre label page.")
        library, _ = self.studio._library()
        query = text(query).casefold().strip()
        labels = sorted((i for i in library.genre_labels() if query in i["label"].casefold()),
                        key=lambda i: i["label"].casefold())
        return {"labels": labels[offset:offset + limit], "total": len(labels),
                "offset": offset, "limit": limit}

    def prepare(self, category, label=None, replacements=None, remove=False):
        if not isinstance(category, str) or category not in CATEGORIES:
            raise LibraryError("Choose genres, track artists, composers or review genre labels.")
        if not isinstance(remove, bool) or (remove and category != "genre-labels"):
            raise LibraryError("Label removal requires the review genre labels category.")
        mapping = None
        if category == "genre-labels":
            if not isinstance(label, str) or not label.strip() or len(label) > 1000:
                raise LibraryError("Choose an existing genre label.")
            if remove and replacements != []:
                raise LibraryError("Removing a label requires an empty replacement list.")
            if not isinstance(replacements, list) or not (0 if remove else 1) <= len(replacements) <= MAX_GENRES \
                    or any(not isinstance(n, str) or not n.strip() or len(n.strip()) > MAX_GENRE_LENGTH
                           for n in replacements):
                raise LibraryError("Enter 1–20 replacement labels of at most 200 characters each.")
            names, seen = [], set()
            for name in replacements:
                name = name.strip()
                if name.casefold() not in seen:
                    names.append(name)
                    seen.add(name.casefold())
            mapping = {"label": label.strip(), "replacements": names}
            if remove:
                mapping["remove"] = True
        client = self.studio._require_client()
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            library, _ = self.studio._current(client)
            library._browse_index("genres")  # displayed, merged album membership
            with self.lock:
                if self.running:
                    raise LibraryError("Stop the running cleanup first.")
                items = []
                for album_id in library.album_ids():
                    album = library.albums[album_id]
                    for track_id in library.active_track_ids(album_id):
                        try:
                            draft = candidate(library, track_id, category, mapping)
                        except LibraryError as error:
                            draft = {"before": snapshot(library, library.tracks[track_id], category),
                                     "after": None, "display_before": [str(error)],
                                     "display_after": [], "blocked": str(error)}
                        if draft:
                            items.append({**draft, "id": track_id, "album_id": album_id,
                                          "original_album_id": number(library.tracks[track_id].get("album_id")),
                                          "group": str(library._browse_albums[album_id]),
                                          "album": text(album.get("name")),
                                          "album_artist": library.artist_name(album.get("artist_id")),
                                          "title": text(library.tracks[track_id].get("title")),
                                          "status": "blocked" if draft.get("blocked") else "pending"})
                self.task = {"id": secrets.token_urlsafe(16), "owner": self.studio.library_user,
                             "category": category, "state": "preview", "items": items,
                             "artists": {}, "error": "", "excluded": []}
                if mapping:
                    self.task["mapping"] = mapping
                self._persist()
            return self.view()
        finally:
            self.studio.save_lock.release()

    def view(self, offset=0, limit=25, report=False):
        self.studio._require_client()
        try:
            offset, limit = int(offset), int(limit)
        except (ValueError, TypeError):
            raise LibraryError("Invalid cleanup page.") from None
        if offset < 0 or not 1 <= limit <= 100:
            raise LibraryError("Invalid cleanup page.")
        # Obtain the account ID on startup before returning a persisted report.
        self.studio._library()
        with self.lock:
            self._owner(self.studio.client)
            if not self.task:
                return {"state": "empty"}
            task = self.task
            groups = {}
            for item in task["items"]:
                g = groups.setdefault(item["group"], {"id": item["group"], "album": item["album"],
                    "artist": item["album_artist"], "tracks": 0, "examples": []})
                g["tracks"] += 1
                if len(g["examples"]) < 2:
                    g["examples"].append({"title": item["title"], "before": item["display_before"],
                                          "after": item["display_after"]})
            result = {k: copy.deepcopy(task[k]) for k in ("id", "category", "state", "error", "excluded")}
            if "mapping" in task:
                result["mapping"] = copy.deepcopy(task["mapping"])
            result.update(tracks=len(task["items"]), albums=len(groups), offset=offset,
                          counts=dict(Counter(i["status"] for i in task["items"])),
                          batch_tracks=BATCH_TRACKS, batch_albums=BATCH_ALBUMS,
                          groups=list(groups.values())[offset:offset + limit],
                          selection=[{"id": g["id"], "tracks": g["tracks"]} for g in groups.values()])
            if report:
                result["items"] = copy.deepcopy(task["items"])
            return result

    def start(self, task_id, excluded=None):
        client = self.studio._require_client()
        if not self.studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            self.studio._current(client)
            with self.lock:
                self._owner(client)
                if not self.task or self.task["id"] != task_id or self.running:
                    raise LibraryError("This preview is no longer available.")
                if self.task["state"] == "done":
                    raise LibraryError("This cleanup has already finished.")
                if self.task["state"] == "preview":
                    if not isinstance(excluded, list) or any(not isinstance(i, str) for i in excluded):
                        raise LibraryError("Choose which albums to exclude.")
                    groups = {i["group"] for i in self.task["items"]}
                    if not set(excluded) <= groups:
                        raise LibraryError("An excluded album is not in this preview.")
                    if any(i.get("blocked") and i["group"] not in excluded for i in self.task["items"]):
                        raise LibraryError("Some split labels are invalid. Exclude their albums or correct them individually.")
                    self.task["excluded"] = excluded
                    for item in self.task["items"]:
                        if item["group"] in excluded:
                            item["status"] = "excluded"
                if any(i["status"] == "blocked" for i in self.task["items"]):
                    raise LibraryError("Some split labels are invalid. Exclude their albums or correct them individually.")
                self.stop.clear()
                self.task["state"], self.task["error"] = "running", ""
                self._persist()
                self.running = True
            threading.Thread(target=self._run, args=(client,), daemon=True).start()
        except Exception:
            self.studio.save_lock.release()
            raise
        return self.view()

    def cancel(self, task_id):
        with self.lock:
            self._owner(self.studio._require_client())
            if not self.task or self.task["id"] != task_id:
                raise LibraryError("This cleanup is no longer available.")
            self.stop.set()
        return self.view()

    def _wire(self, library, client, item):
        if self.task["category"] in ("genres", "genre-labels"):
            return dict(item["after"])

        def resolve(name):
            found = library.find_artist(name)
            if found is None:
                found = self.task["artists"].get(name)
            if found is None:
                self._owner(client)
                if self.stop.is_set():
                    raise LibraryError("Cleanup stopped before creating another artist.")
                # Never retry create_artist after an ambiguous reply. A resumed job
                # looks for the name in a fresh download before trying again.
                found = number(client._jsonrequest("create_artist", name=name).get("artist_id"))
                if not found:
                    raise LibraryError(f"No ID returned for new artist “{name}”.")
                with self.lock:
                    self.task["artists"][name] = found
                    self._persist()
            return found

        primary_id = item["after"]["primary_id"]
        wire = {"artist_id": primary_id if primary_id is not None else resolve(item["after"]["primary"]),
                "artists_additional": []}
        for credit in item["after"]["credits"]:
            wire["artists_additional"].append({"artist_id": credit.get("artist_id") or resolve(credit["name"]),
                                               "phrase": credit.get("phrase"), "type": credit.get("type")})
        # The official editor uses this exact shape for update_track credits.
        return wire

    def _check(self, library, item):
        try:
            album_id = library.active_track_album(item["id"])
        except LibraryError:
            return "conflict"
        if album_id != item["album_id"] or number(library.tracks[item["id"]].get("album_id")) != item["original_album_id"]:
            return "conflict"
        now = snapshot(library, library.tracks[item["id"]], self.task["category"])
        if item.get("wire") == now:
            return "confirmed"
        return "pending" if now == item["before"] else "conflict"

    def _run(self, client):
        try:
            first = True
            while not self.stop.is_set():
                self._owner(client)
                fresh, _ = self.studio._current(client, refresh=first)
                first = False
                self._owner(client)
                batch, albums = [], set()
                with self.lock:
                    for item in self.task["items"]:
                        if item["status"] in ("confirmed", "excluded"):
                            continue
                        checked = self._check(fresh, item)
                        if checked == "confirmed":
                            item["status"] = checked
                            continue
                        if checked == "conflict":
                            item["status"] = "conflict"
                            raise LibraryError(f"“{item['title']}” changed since the preview. Prepare a new preview.")
                        if len(batch) >= BATCH_TRACKS or (item["group"] not in albums and len(albums) >= BATCH_ALBUMS):
                            break
                        item["status"] = "pending"
                        albums.add(item["group"])
                        batch.append(item)
                    self._persist()
                if not batch:
                    with self.lock:
                        self.task["state"] = "done"
                    break
                rows = []
                for item in batch:
                    if self.stop.is_set():
                        break
                    wire = self._wire(fresh, client, item)
                    with self.lock:
                        item["wire"] = wire
                    rows.append({"file_id": item["id"], **wire})
                if self.stop.is_set():
                    break
                # Creating missing names may take time. Compare once more immediately
                # before writing; a changed timestamp triggers a fresh download.
                current, _ = self.studio._current(client)
                self._owner(client)
                if any(self._check(current, item) not in ("pending", "confirmed") for item in batch):
                    raise LibraryError("Track metadata changed while preparing the batch. Prepare a new preview.")
                if self.stop.is_set():
                    break
                with self.lock:
                    for item in batch:
                        item["status"] = "sent"
                    self._persist()  # persist intent before a possibly interrupted request
                error = None
                try:
                    client._jsonrequest("update_track", tracks=rows)
                except Exception as failure:
                    error = failure
                try:
                    after, _ = self.studio._current(client, refresh=True)
                    self._owner(client)
                    with self.lock:
                        for item in batch:
                            check = self._check(after, item)
                            item["status"] = "confirmed" if check == "confirmed" else "unconfirmed"
                        self._persist()
                except Exception:
                    with self.lock:
                        for item in batch:
                            item["status"] = "unconfirmed"
                    raise
                if error:
                    raise LibraryError(f"iBroadcast did not confirm the request: {error}")
                if any(i["status"] != "confirmed" for i in batch):
                    raise LibraryError("Some writes could not be confirmed. Processing stopped; resume checks them first.")
        except Exception as failure:
            log.warning("Cleanup stopped: %s", failure)
            with self.lock:
                self.task["state"], self.task["error"] = "error", str(failure)
        finally:
            with self.lock:
                if self.task["state"] == "running":
                    self.task["state"] = "stopped"
                try:
                    self._persist()
                finally:
                    self.running = False
                    self.studio.save_lock.release()
