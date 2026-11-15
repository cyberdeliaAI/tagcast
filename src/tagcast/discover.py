"""Explicit, read-only album discovery from the loaded library's own metadata."""

import math
from collections import defaultdict

from .library import ConflictError, LibraryError, number

MAX_RESULTS = 6


class DiscoverIndex:
    """One snapshot's displayed albums and inverse genre index; no provider or audio reads."""

    def __init__(self, library):
        self.artists = {}
        self.albums = []
        self.genres = defaultdict(set)
        self.labels = {}
        sets = defaultdict(list)
        for album in library.album_index():
            for artist in album["album_artists"]:
                if number(artist["id"]) > 0:
                    group = self.artists.setdefault(artist["name"], {"ids": set(), "albums": set()})
                    group["ids"].add(str(artist["id"]))
            sets[library.album_set_key(number(album["id"]))].append(album)
        for discs in sets.values():
            # Same display rule as albumShelf: repeated disc numbers remain separate copies.
            groups = [discs] if len({a["disc"] for a in discs}) == len(discs) else [[a] for a in discs]
            for group in groups:
                group.sort(key=lambda a: (a["disc"], number(a["id"])))
                first = group[0]
                if number(first["artist_id"]) <= 0:
                    continue
                genres = set()
                for album in group:
                    for label in album["genres"]:
                        label = label.strip()
                        if label and len(label) <= 200:
                            key = label.casefold()
                            genres.add(key)
                            # Stable original metadata spelling, independent of table order.
                            self.labels[key] = min(self.labels.get(key, label), label)
                artists = {a["name"] for album in group for a in album["album_artists"]
                           if number(a["id"]) > 0}
                position = len(self.albums)
                self.albums.append({"id": first["id"], "ids": tuple(a["id"] for a in group),
                                    "name": first["name"], "artists": artists,
                                    "genres": genres, "rating": min(a["rating"] for a in group),
                                    "artist_rating": first["artist_rating"]})
                for name in artists:
                    self.artists[name]["albums"].add(position)
                for genre in genres:
                    self.genres[genre].add(position)
        self.weights = {g: 1 + math.log((1 + len(self.albums)) / (1 + len(ids)))
                        for g, ids in self.genres.items()}
        for album in self.albums:
            album["weight"] = sum(self.weights[g] for g in sorted(album["genres"]))

    def recommendations(self, name):
        seed = self.artists[name]["albums"]
        genres = set().union(*(self.albums[i]["genres"] for i in seed))
        if not genres:
            return [], "missing_genres"
        weight = sum(self.weights[g] for g in sorted(genres))
        candidates = set().union(*(self.genres[g] for g in genres)) - seed
        ranked = []
        for position in candidates:
            album = self.albums[position]
            shared = genres & album["genres"]
            overlap = sum(self.weights[g] for g in sorted(shared))
            score = overlap / (weight + album["weight"] - overlap)
            ranked.append((-score, -album["rating"], -album["artist_rating"],
                           album["name"].casefold(), number(album["id"]), position, shared))
        chosen, represented = [], set()
        for *_, position, shared in sorted(ranked, key=lambda row: row[:5]):
            album = self.albums[position]
            if album["artists"] & represented:
                continue
            represented.update(album["artists"])
            labels = sorted(shared, key=lambda g: (-self.weights[g], g))[:3]
            chosen.append((album, [self.labels[g] for g in labels]))
            if len(chosen) == MAX_RESULTS:
                break
        return chosen, "ready" if chosen else "no_matches"


class ArtistDiscover:
    def __init__(self, studio):
        self.studio = studio

    def view(self, body):
        """Never refresh the library, inspect audio, persist a report or change playback."""
        if not isinstance(body, dict):
            raise LibraryError("Choose an album artist.", code="discover.invalid_artist")
        ids, name = body.get("artists"), body.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 1000 \
                or not isinstance(ids, list) \
                or not 0 < len(ids) <= 100 or any(not isinstance(i, str) or not i.isascii()
                                               or not i.isdigit() or len(i) > 32 or int(i) <= 0 for i in ids) \
                or len(set(ids)) != len(ids):
            raise LibraryError("Choose an album artist.", code="discover.invalid_artist")
        studio = self.studio
        with studio.lock:
            client = studio._require_client()
            library, account, session = studio.library, studio.library_user, studio.playback_session
            if library is None or not account or not session or body.get("session") != session:
                raise ConflictError("The account, library or artist changed. Reopen the artist.", code="discover.stale")
            revision, combine = library.lastmodified, studio.combine_sets

        def current():
            return (studio.client is client and studio.library is library and studio.library_user == account
                    and studio.playback_session == session and library.lastmodified == revision
                    and studio.combine_sets == combine)

        # Derived data belongs to the Library object, so an old snapshot is not retained
        # by Studio after Disconnect/replacement, even when lastmodified is unchanged.
        with library._discover_lock:
            if library._discover_index is None:
                index = DiscoverIndex(library)
                with studio.lock:
                    if not current():
                        raise ConflictError("The account, library or artist changed. Reopen the artist.", code="discover.stale")
                    library._discover_index = index
            index = library._discover_index
        artist = index.artists.get(name)
        if not artist or set(ids) != artist["ids"]:
            raise ConflictError("The account, library or artist changed. Reopen the artist.", code="discover.stale")
        choices, status = index.recommendations(name)
        albums = []
        for album, genres in choices:
            playable = True
            for album_id in album["ids"]:
                tracks = library.active_track_ids(number(album_id))
                if not tracks:
                    playable = False
                for track_id in tracks:
                    try:
                        library.stream_info(track_id)
                    except LibraryError:
                        playable = False
            albums.append({"id": album["id"], "shared_genres": genres, "playable": playable})
        with studio.lock:
            if not current():
                raise ConflictError("The account, library or artist changed. Reopen the artist.", code="discover.stale")
        return {"artist": name, "session": session, "status": status, "albums": albums}
