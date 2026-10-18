"""An opt-in, local comparison with a bundled listening list. Never writes to iBroadcast."""

import hashlib
import json
import re
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

from .library import ConflictError, LibraryError, number, text

CATALOGUE = Path(__file__).with_name("static") / "1001-albums.json"
GUIDE_MATCHER_VERSION = 2


@lru_cache(maxsize=1)
def guide_catalogue():
    raw = CATALOGUE.read_bytes()
    data = json.loads(raw)
    return data["entries"], hashlib.sha256(raw).hexdigest()


@lru_cache(maxsize=1)
def guide_selection():
    """Spelling repairs do not change which reference entry a manual link belongs to."""
    return json.loads(CATALOGUE.read_bytes())["source_sha256"]


def guide_key(value, artist=False):
    value = unicodedata.normalize("NFKD", str(value or "")).casefold()
    value = "".join(c for c in value if not unicodedata.combining(c))
    value = value.replace("&", " and ")
    value = re.sub(r"['’‘\"“”]", "", value)
    if artist:
        value = re.sub(r"^the\s+", "", value.strip())
    return "".join(c for c in value if c.isalnum())


def guide_title_text(value):
    """Remove only recognised edition suffixes; keep live/remix/subtitle distinctions."""
    value = str(value or "").strip()
    safe = re.compile(r"^(?:\d+|\d+(?:st|nd|rd|th)|remaster(?:ed)?|deluxe|edition|anniversary|"
                      r"expanded|reissue|mono|stereo|bonus|selections?|tracks?|disc|cd|digital|version|mix|"
                      r"with|and|the|s|super|collector|collectors|original|album|issue|edtion|"
                      r"definitive|master|preserved|complete|us|internet|release|explicit)$", re.I)
    while match := re.search(r"\s*(?:\(([^()]*)\)|\[([^\[\]]*)\]|\s[-–—]\s(.+))$", value):
        suffix = next(g for g in match.groups() if g is not None)
        words = re.findall(r"\w+", suffix)
        # 'Mix' alone may be a different recording. Only allow it with mono/stereo.
        if not words or not all(safe.fullmatch(w) for w in words) \
                or not any(re.fullmatch(r"remaster(?:ed)?|deluxe|edition|anniversary|expanded|"
                                       r"reissue|mono|stereo|disc|cd|collector|collectors|bonus|"
                                       r"issue|preserved|master|release|explicit", w, re.I) for w in words):
            break
        value = value[:match.start()].strip()
    return value


def guide_title(value):
    return guide_key(guide_title_text(value))


def guide_numbers(value):
    """Fuzzy matching must not suggest volume II/IV or #2 for a different album."""
    return tuple(re.findall(r"\b(?:\d+|[ivx]+)\b", guide_title_text(value).casefold()))


def _guide_id(value):
    return isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,31}", value) is not None


def match_guide(entries, albums):
    """Index once; fuzzy comparisons are bounded by artist, never every album pair."""
    artists, exact = defaultdict(list), defaultdict(list)
    for album in albums:
        artist = guide_key(album["artist"], artist=True)
        title = guide_title(album["name"])
        if artist and title:
            row = {"id": str(album["id"]), "title": title, "numbers": guide_numbers(album["name"])}
            artists[artist].append(row)
            exact[artist, title].append(row["id"])
    artist_grams = defaultdict(set)
    for name in artists:
        for gram in {name[i:i + 3] for i in range(len(name) - 2)}:
            artist_grams[gram].add(name)
    rows = []
    for entry in entries:
        artist = guide_key(entry["artist"], artist=True)
        title = guide_title(entry["album"])
        found = exact.get((artist, title), [])
        possible = []
        if not found:
            names = [artist] if artist in artists else []
            if not names:
                votes = Counter(name for gram in {artist[i:i + 3] for i in range(len(artist) - 2)}
                                for name in artist_grams.get(gram, ()))
                names = [name for name, _ in sorted(votes.items(), key=lambda item: (-item[1], item[0]))[:24]
                         if SequenceMatcher(None, artist, name).ratio() >= .82][:3]
            for name in names:
                artist_score = SequenceMatcher(None, artist, name).ratio()
                for album in artists[name]:
                    if guide_numbers(entry["album"]) != album["numbers"]:
                        continue
                    title_score = SequenceMatcher(None, title, album["title"]).ratio()
                    if title_score >= .86 and .4 * artist_score + .6 * title_score >= .90:
                        possible.append((artist_score + title_score, album["id"]))
        ids = list(dict.fromkeys(found or [i for _, i in sorted(possible, reverse=True)[:5]]))
        rows.append({"id": entry["id"], "status": "found" if found else "possible" if ids else "missing",
                     "album_ids": ids})
    return rows


class AlbumGuide:
    """One account-scoped report on disk. Reading or enabling never starts analysis."""

    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.RLock()
        self.report = None
        self.analysed_library = None
        self.note_index = None

    def notes_for_album(self, album_id, session, expected_album=None, expected_artist=None):
        """Resolve only a visited album locally, independently of the discovery page/report."""
        if not _guide_id(album_id):
            raise LibraryError("Choose one album for background text.")
        with self.lock:
            studio = self.studio
            with studio.lock:
                client = studio._require_client()
                library, user = studio.library, studio.library_user
                if not library or not user or not session or session != studio.playback_session:
                    raise ConflictError("The account or library changed. Reload the library.")
                album = library.albums.get(int(album_id))
                if not album or album.get("trashed") or not library.active_track_ids(int(album_id)):
                    raise ConflictError("This album is no longer available. Reload the library.")
                if expected_album is not None and expected_album != (text(album.get("name")) or "Untitled album") \
                        or expected_artist is not None and expected_artist != library.artist_name(album.get("artist_id")):
                    raise ConflictError("This album's name or artist changed. Reload the library.")
                name = text(album.get("name"))
                artist = text(library.artists.get(number(album.get("artist_id")), {}).get("name"))
            entries, revision = guide_catalogue()
            if self.note_index is None or self.note_index[0] != revision:
                index = defaultdict(list)
                for entry in entries:
                    key = guide_key(entry["artist"], True), guide_title(entry["album"])
                    if all(key):
                        index[key].append(entry["id"])
                self.note_index = (revision, index)
            key = guide_key(artist, True), guide_title(name)
            candidates = self.note_index[1].get(key, []) if all(key) else []
            _, links = self._links(user)
            # A manual choice overrides automatic matching, including another copy of the album.
            chosen = {candidates[0]} if len(candidates) == 1 and str(candidates[0]) not in links else set()
            for entry_id, ids in links.items():
                if album_id in ids and all(
                        number(i) in library.albums and not library.albums[number(i)].get("trashed")
                        and library.active_track_ids(number(i)) for i in ids):
                    chosen.add(int(entry_id))
            with studio.lock:
                current = library.albums.get(int(album_id), {})
                if studio.client is not client or studio.library is not library or studio.library_user != user \
                        or studio.playback_session != session or current.get("trashed") \
                        or not library.active_track_ids(int(album_id)) \
                        or text(current.get("name")) != name \
                        or text(library.artists.get(number(current.get("artist_id")), {}).get("name")) != artist:
                    raise ConflictError("The account, library or album changed. Reload the library.")
            return {"entries": [{key: entries[i - 1][key] for key in ("id", "album", "artist")}
                                for i in sorted(chosen)]}

    def _state(self):
        s = self.studio
        with s.lock:
            return (s.config.get("album_guide") is True, s.library, s.library_user, s.client)

    def _stamp(self, library):
        return {"catalogue": guide_catalogue()[1], "lastmodified": library.lastmodified,
                "combine_sets": library.combine_sets, "matcher": GUIDE_MATCHER_VERSION}

    def _links(self, user):
        data = self.studio._read("album-guide-links.json")
        accounts = data.get("accounts", {}) if isinstance(data, dict) else {}
        accounts = accounts if isinstance(accounts, dict) else {}
        saved = accounts.get(user, {})
        links = saved.get("links", {}) if isinstance(saved, dict) and saved.get("selection") == guide_selection() else {}
        valid = {}
        if isinstance(links, dict):
            for key, ids in links.items():
                if _guide_id(key) and 1 <= int(key) <= len(guide_catalogue()[0]) \
                        and isinstance(ids, list) and 0 < len(ids) <= 100 \
                        and all(_guide_id(i) for i in ids):
                    valid[str(key)] = list(dict.fromkeys(ids))
        return accounts, valid

    def view(self):
        with self.lock:
            enabled, library, user, client = self._state()
            if not enabled:
                return {"enabled": False, "state": "disabled"}
            if not client or library is None or not user:
                return {"enabled": True, "state": "unavailable"}
            entries, _ = guide_catalogue()
            report = self.report or self.studio._read("album-guide.json")
            base = {"enabled": True, "total": len(entries), "revision": guide_catalogue()[1],
                    "lastmodified": library.lastmodified}
            if not isinstance(report, dict) or report.get("user_id") != user:
                return {**base, "state": "empty"}
            if report.get("stamp") != self._stamp(library) \
                    or not library.lastmodified and library is not self.analysed_library:
                return {**base, "state": "stale"}
            rows = report.get("rows")
            if not isinstance(rows, list) or len(rows) != len(entries) \
                    or any(not isinstance(row, dict) or row.get("id") != entry["id"]
                           or row.get("status") not in ("found", "possible", "missing")
                           or not isinstance(row.get("album_ids"), list)
                           for row, entry in zip(rows, entries)):
                return {**base, "state": "empty"}
            _, links = self._links(user)
            rows = [dict(row) for row in rows]
            for row in rows:
                if ids := links.get(str(row["id"])):
                    active = [
                        i for i in ids if number(i) in library.albums
                        and not library.albums[number(i)].get("trashed")
                        and library.active_track_ids(number(i))]
                    row.update(manual=True, manual_ids=ids, album_ids=active,
                               status="found" if len(active) == len(ids) else "possible" if active else "missing")
            counts = {key: sum(row["status"] == key for row in rows)
                      for key in ("found", "possible", "missing")}
            with self.studio.lock:
                if self._state() != (enabled, library, user, client):
                    return {"enabled": False, "state": "unavailable"}
                return {**base, "state": "ready", "analysed_at": report.get("analysed_at"),
                        "counts": counts, "entries": [{**entry, "status": row["status"],
                                                       "album_ids": row["album_ids"],
                                                       "manual": row.get("manual", False),
                                                       "manual_ids": row.get("manual_ids", [])}
                                                      for entry, row in zip(entries, rows)]}

    def link(self, body):
        """An explicit, reversible local link, with account/library and concurrent-edit checks."""
        with self.lock:
            enabled, library, user, client = self._state()
            view = self.view()
            if not enabled or view["state"] != "ready":
                raise LibraryError("Run an analysis of your current library before linking an album.")
            entry_id, ids = body.get("entry_id"), body.get("album_ids")
            if type(entry_id) is not int or not 1 <= entry_id <= len(guide_catalogue()[0]) \
                    or not isinstance(ids, list) or len(ids) > 100 \
                    or any(not _guide_id(i) for i in ids) \
                    or len(set(ids)) != len(ids):
                raise LibraryError("Choose one reference entry and one album from your library.")
            if body.get("revision") != view["revision"] or body.get("lastmodified") != library.lastmodified:
                raise ConflictError("Your library or reference changed. Analyse again before linking.")
            accounts, links = self._links(user)
            key = str(entry_id)
            if body.get("before") != links.get(key, []):
                raise ConflictError("This link changed in another window. Reopen 1001 Albums.")
            if ids:
                for i in ids:
                    album = library.albums.get(number(i))
                    if not album or album.get("trashed") or not library.active_track_ids(number(i)):
                        raise ConflictError("That album is no longer available. Reload and analyse again.")
                keys = {library.album_set_key(number(i)) for i in ids}
                discs = {number(library.albums[number(i)].get("disc")) for i in ids}
                if len(ids) > 1 and (len(keys) != 1 or len(discs) != len(ids)):
                    raise LibraryError("Choose one album or the discs of one displayed set.")
                links[key] = ids
            else:
                links.pop(key, None)
            accounts[user] = {"selection": guide_selection(), "links": links}
            with self.studio.lock:
                if self._state() != (enabled, library, user, client):
                    raise ConflictError("Your account or library changed. Reopen 1001 Albums.")
                self.studio._write("album-guide-links.json", {"accounts": accounts})
            return self.view()

    def analyse(self):
        with self.lock:
            enabled, library, user, client = self._state()
            if not enabled:
                raise LibraryError("Enable 1001 Albums in Settings first.")
            if not client or library is None or not user:
                raise LibraryError("Connect iBroadcast and load your library before analysing.")
            # Use the library already in memory: no status call, download, track details or writes.
            albums = [{"id": str(i), "name": library.albums[i].get("name"),
                       "artist": library.artist_name(library.albums[i].get("artist_id"))}
                      for i in library.album_ids()]
            entries, _ = guide_catalogue()
            report = {"user_id": user, "stamp": self._stamp(library), "analysed_at": time.time(),
                      "rows": match_guide(entries, albums)}
            with self.studio.lock:
                if self._state() != (enabled, library, user, client):
                    raise LibraryError("Your library or settings changed. Start the analysis again.")
                self.studio._write("album-guide.json", report)
                self.report, self.analysed_library = report, library
        return self.view()
