"""Explicit local or online artist discovery, matched to the loaded library."""

import math
from collections import defaultdict
from urllib.parse import quote

from .discover_lastfm import LastfmSimilar
from .discover_listenbrainz import ListenBrainzSimilar
from .library import ConflictError, LibraryError, number
from .sources import SourceError, artist_name_key

MAX_RESULTS = 6
DISCOVER_SOURCES = ("local", "lastfm", "listenbrainz")


def discovery_source(config):
    source = config.get("discover_source")
    if source in DISCOVER_SOURCES:
        return source
    legacy = config.get("discover_lastfm")
    if isinstance(legacy, bool):
        return "lastfm" if legacy else "local"
    return "listenbrainz"


class DiscoverIndex:
    """One snapshot's displayed albums and inverse genre index; no provider or audio reads."""

    def __init__(self, library):
        self.artists = {}
        self.albums = []
        self.genres = defaultdict(set)
        self.labels = {}
        self.names = defaultdict(list)
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
        for name, group in self.artists.items():
            if group["albums"]:
                self.names[artist_name_key(name)].append(name)

    def similar_recommendations(self, name, artists):
        """Unique strict local artist matches; provider similarity outranks native ratings."""
        seed = self.artists[name]["albums"]
        chosen, represented = [], set()
        for provider_name, reference in artists:
            matches = self.names.get(artist_name_key(provider_name), [])
            if len(matches) != 1:
                continue
            matched = matches[0]
            candidates = self.artists[matched]["albums"] - seed
            for position in sorted(candidates, key=lambda i: (
                    -self.albums[i]["rating"], -self.albums[i]["artist_rating"],
                    self.albums[i]["name"].casefold(), number(self.albums[i]["id"]))):
                album = self.albums[position]
                if album["artists"] & represented:
                    continue
                represented.update(album["artists"])
                chosen.append((album, (provider_name, reference)))
                break
            if len(chosen) == MAX_RESULTS:
                break
        return chosen

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
        self.generation = 0
        self.lastfm = LastfmSimilar(studio.lookup.http)
        self.listenbrainz = ListenBrainzSimilar(studio.lookup.http)

    def view(self, body):
        """Never refresh the library, inspect audio, persist a report or change playback."""
        if not isinstance(body, dict):
            raise LibraryError("Choose an album artist.", code="discover.invalid_artist")
        ids, name = body.get("artists"), body.get("name")
        source = body.get("source")
        if "source" in body and source not in DISCOVER_SOURCES:
            raise LibraryError("Choose a discovery source in Settings.", code="discover.invalid_source")
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
            generation = self.generation
            selected = discovery_source(studio.config)
            if source is None:
                source = selected
            if source == "listenbrainz" and selected != "listenbrainz":
                raise LibraryError("Choose a discovery source in Settings.", code="discover.invalid_source")
            musicbrainz_enabled = "musicbrainz" not in studio.disabled_sources()
            key = studio.source_keys().get("lastfm_api_key", "") if source == "lastfm" else ""
            if source == "lastfm":
                if selected != "lastfm":
                    raise LibraryError("Last.fm discovery is disabled. Enable it in Settings → Discovery.", code="discover.lastfm_discovery_disabled")
                if "lastfm" in studio.disabled_sources():
                    raise LibraryError("Last.fm is disabled. Enable it in Sources & keys in Settings.", code="discover.lastfm_disabled")
                if not isinstance(key, str) or not key:
                    raise LibraryError("Add a Last.fm API key in Sources & keys in Settings.", code="discover.lastfm_missing_key")
                if len(name) > 200:
                    raise LibraryError("Last.fm could not identify this artist exactly. You can turn off Last.fm in Settings → Discovery to use local genres.", code="discover.lastfm_identity")

        def current():
            return (studio.client is client and studio.library is library and studio.library_user == account
                    and studio.playback_session == session and library.lastmodified == revision
                    and studio.combine_sets == combine and self.generation == generation
                    and discovery_source(studio.config) == selected)

        def valid_online():
            with studio.lock:
                if not current() or (source == "lastfm" and (
                        studio.source_keys().get("lastfm_api_key", "") != key
                        or "lastfm" in studio.disabled_sources())) or (
                        source == "listenbrainz"
                        and musicbrainz_enabled != ("musicbrainz" not in studio.disabled_sources())):
                    raise ConflictError("The account, library or source changed. Start discovery again.", code="discover.online_stale")

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
        effective, fallback, ttl = source, False, None
        if source != "local":
            context = account, session, generation
            if source == "lastfm":
                related, ttl = self.lastfm.read(name, key, context, valid_online)
            else:
                related, ttl = (), 0
                if musicbrainz_enabled and len(artist["ids"]) == 1 and len(name) <= 200:
                    try:
                        related, ttl = self.listenbrainz.read(name, context, valid_online)
                    except SourceError:
                        pass  # The local genre result remains available on provider failure.
            valid_online()
            choices = index.similar_recommendations(name, related)
            status = "ready"
            if not choices:
                effective, fallback = "local", True
                choices, status = index.recommendations(name)
        else:
            choices, status = index.recommendations(name)
        albums = []
        for album, reason in choices:
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
            row = {"id": album["id"], "shared_genres": reason if effective == "local" else [], "playable": playable}
            if effective == "lastfm":
                provider_name, _ = reason
                row.update(related_artist=provider_name, lastfm_url="https://www.last.fm/music/" + quote(provider_name, safe=""))
            if effective == "listenbrainz":
                row.update(related_artist=reason[0], related_artist_mbid=reason[1])
            albums.append(row)
        if source != "local":
            valid_online()
        with studio.lock:
            if not current():
                raise ConflictError("The account, library or artist changed. Reopen the artist.", code="discover.stale")
        return {"artist": name, "session": session, "status": status, "albums": albums,
                "source": effective, "requested_source": source, "fallback": fallback,
                "expires_in": ttl}
