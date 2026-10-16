"""Native iBroadcast tags, separate from genres and reviewed metadata saves.

Payloads follow https://help.ibroadcast.com/en/developer/api (2026-10-16).
No audio or real-account writes are needed to prepare or test these operations.
"""

import hashlib
import json

from .collections import track_ids
from .library import ConflictError, LibraryError, fold, number, text


class Tags:
    def __init__(self, studio):
        self.studio = studio

    def library(self):
        client = self.studio._require_client()
        library, _ = self.studio._current(client)
        if not library.tags_loaded:
            library, _ = self.studio._current(client, refresh=True)
        if not library.tags_loaded:
            raise LibraryError("Tags were not returned by iBroadcast. Reload the library.")
        return client, library

    def digest(self, value):
        data = [self.studio.library_user, value]
        return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=True).encode()).hexdigest()

    def tag_before(self, tag):
        return self.digest({**tag, "tracks": sorted(tag["tracks"])})

    def row(self, library, tag_id, selected=None):
        tag = library.tags.get(tag_id)
        if tag is None:
            raise ConflictError("This tag is no longer available. Open Tags again.")
        active = len(library._browse_index("tags")[str(tag_id)]["ids"])
        return {"id": str(tag_id), "name": tag["name"], "archived": tag["archived"],
                "tracks": active, "total_tracks": len(tag["tracks"]), "before": self.tag_before(tag),
                **({"selected": len(selected.intersection(tag["tracks"]))} if selected is not None else {})}

    def catalogue(self, query="", offset="0", tag_id=None):
        _, library = self.library()
        if tag_id is not None:
            return self.row(library, number(tag_id))
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise LibraryError("Choose a valid tag page.") from None
        if offset < 0 or len(text(query)) > 200:
            raise LibraryError("Choose a valid tag page and a shorter search.")
        words = fold(query).split()
        ids = sorted((i for i, t in library.tags.items() if all(w in fold(t["name"]) for w in words)),
                     key=lambda i: (fold(library.tags[i]["name"]), i))
        return {"tags": [self.row(library, i) for i in ids[offset:offset + 50]],
                "total": len(ids), "offset": offset}

    def target(self, library, target):
        if not isinstance(target, dict):
            raise LibraryError("Choose one album or track for its tags.")
        ids = track_ids(target.get("albums"), 100)
        if not ids or len(ids) != len(set(ids)):
            raise LibraryError("Choose one complete album or multi-disc set.")
        library._browse_index("tags")
        groups = {library._browse_albums.get(i) for i in ids}
        if None in groups or len(groups) != 1 or any(i not in ids for i, g in library._browse_albums.items() if g in groups):
            raise LibraryError("Choose one complete album or multi-disc set.")
        views = [library.album_view(i) for i in ids]
        tracks = {int(t["id"]): t for a in views for t in a["tracks"]}
        if target.get("track") is not None:
            chosen = track_ids([target["track"]], 1)[0]
            if chosen not in tracks:
                raise ConflictError("This track is no longer in the chosen album.")
            tracks = {chosen: tracks[chosen]}
        if not tracks or len(tracks) > 500:
            raise LibraryError("Choose up to 500 tracks; for a larger album, manage tags per track.")
        label = next(iter(tracks.values()))["title"] if target.get("track") else views[0]["name"]
        before = self.digest({"combine_sets": library.combine_sets,
            "albums": [{"id": a["id"], "name": a["name"], "artist": a["artist"],
                        "tracks": sorted(t["id"] for t in a["tracks"])} for a in views],
            "tracks": [{"id": t["id"], "title": t["title"], "tags": sorted(tag["id"] for tag in t["tags"])}
                       for _, t in sorted(tracks.items())]})
        return set(tracks), label, before

    def selection(self, albums, track=None):
        _, library = self.library()
        target = {"albums": albums, "track": track}
        ids, label, before = self.target(library, target)
        return {"target": target, "label": label, "tracks": len(ids), "before": before,
                "tags": [self.row(library, i, ids) for i, t in library.tags.items() if ids.intersection(t["tracks"])]}

    @staticmethod
    def name(value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200 \
                or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise LibraryError("Enter a tag name of 1–200 characters.")
        return value.strip()

    def save(self, body):
        if body.get("approved") is not True:
            raise LibraryError("Review and approve the tag changes first.")
        studio = self.studio
        if not studio.save_lock.acquire(blocking=False):
            raise LibraryError("Another save is still running.")
        try:
            client, library = self.library()
            action, plans = body.get("action"), []
            if action == "change":
                ids, _, before = self.target(library, body.get("target"))
                if before != body.get("before"):
                    raise ConflictError("The album, track or its tags changed. Open a new review.")
                changes = body.get("changes")
                if not isinstance(changes, list) or not 1 <= len(changes) <= 20:
                    raise LibraryError("Review 1–20 tag changes at a time.")
                seen = set()
                for change in changes:
                    if not isinstance(change, dict) or change.get("action") not in ("add", "remove"):
                        raise LibraryError("Choose whether to add or remove each tag.")
                    i = track_ids([change.get("id")], 1)[0]
                    if i in seen:
                        raise LibraryError("Choose each tag once.")
                    seen.add(i)
                    tag = library.tags.get(i)
                    if tag is None or self.tag_before(tag) != change.get("before"):
                        raise ConflictError("A tag changed. Open a new review.")
                    remove = change["action"] == "remove"
                    if tag["archived"] and not remove:
                        raise LibraryError("Archived tags can hide music. Unarchive the tag in iBroadcast before assigning it here.")
                    members = set(tag["tracks"])
                    wanted = members - ids if remove else members | ids
                    affected = ids.intersection(members) if remove else ids - members
                    if affected:
                        plans.append((i, {**tag, "tracks": sorted(wanted)}, "tagtracks",
                                      {"tagid": i, "tracks": sorted(affected), "untag": remove}))
            elif action in ("rename", "delete"):
                i = track_ids([body.get("id")], 1)[0]
                tag = library.tags.get(i)
                if tag is None or self.tag_before(tag) != body.get("before"):
                    raise ConflictError("This tag changed. Open a new review.")
                if action == "delete":
                    plans.append((i, None, "deletetags", {"tags": [i]}))
                else:
                    name = self.name(body.get("name"))
                    self.unique_name(library, name, i)
                    plans.append((i, {**tag, "name": name}, "updatetag", {"tag_id": i, "name": name}))
            elif action == "create":
                name = self.name(body.get("name"))
                self.unique_name(library, name)
            else:
                raise LibraryError("Choose a supported tag action.")
            if client is not studio.client:
                raise LibraryError("The connection changed. Prepare a new review.")
            sent, error, failed = set(), "", None
            if action == "create":
                try:
                    result = client._jsonrequest("createtag", tagname=name)
                    i = track_ids([result.get("id")], 1)[0]
                    if i in library.tags:
                        raise LibraryError("iBroadcast returned an existing tag ID.")
                    plans = [(i, {"name": name, "archived": False, "tracks": []}, "createtag", {})]
                    sent.add(i)
                except Exception as failure:
                    error = f"Tag creation could not be confirmed: {failure}. Reload Tags before trying again."
            else:
                for i, _, mode, payload in plans:
                    if client is not studio.client:
                        error = "The connection changed; remaining tags were not sent."
                        break
                    try:
                        client._jsonrequest(mode, **payload)
                        sent.add(i)
                    except Exception as failure:
                        error, failed = str(failure), i
                        break

            def check(after):
                if not after.tags_loaded:
                    raise LibraryError("Tags were missing from the read-back.")
                rows = []
                for i, expected, _, _ in plans:
                    now = after.tags.get(i)
                    same = now is None if expected is None else now is not None and self.tag_before(now) == self.tag_before(expected)
                    rows.append({"id": str(i), "status": "saved" if same else "unverified" if i in sent or i == failed else "not_sent"})
                return rows

            return {"job": studio._check_later(client, studio.downloads, check, include_albums=False),
                    "error": error, "sent": len(sent)}
        finally:
            studio.save_lock.release()

    @staticmethod
    def unique_name(library, name, exclude=None):
        if any(i != exclude and t["name"].casefold() == name.casefold() for i, t in library.tags.items()):
            raise LibraryError("A tag with this name already exists. Choose that tag or another name.")
