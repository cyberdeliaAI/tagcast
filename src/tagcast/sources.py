"""Online metadata sources: look up an album or an artist and return suggestions.

Every source returns plain dicts that the editor shows side by side, like a tag
editor's "tag sources". Nothing here writes anything: the person picks a year,
genre or image, reviews it, and only then is it saved to iBroadcast.

Album suggestion:  {source, title, artist, year, date, note, genres, cover, thumb, url, score}
Artist suggestion: {source, name, image, thumb, url, genres, score}

Sources without a key: MusicBrainz (+ Cover Art Archive), Deezer, iTunes, TheAudioDB.
With a key in Settings: Discogs (personal token), Last.fm (API key), fanart.tv (API key).
"""

import difflib
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from urllib.parse import urlparse

import requests

from . import __version__

USER_AGENT = (f"Tagcast/{__version__} "
              "( https://github.com/cyberdeliaAI/tagcast )")
TIMEOUT = 20
MIN_SCORE = 0.45
LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"


class SourceError(Exception):
    pass


# -- matching ---------------------------------------------------------------

def normalize(value):
    """Lowercase, no accents, no '(Remastered)' or '[Deluxe]', no 'The', no punctuation."""
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(c for c in value if not unicodedata.combining(c)).casefold()
    value = value.replace("&", " and ")
    value = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", value)
    value = re.sub(r"\s(feat|ft|featuring)\.?\s.*$", " ", value)
    value = re.sub(r"^the\s+", "", value.strip())
    value = re.sub(r"[^\w\s]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


EDITION_WORDS = (r"remaster(ed)?|edition|deluxe|version|anniversary|expanded|mono|stereo|"
                 r"bonus|reissue|special|collector'?s|live|explicit")


def search_title(value):
    """'Hounds of Love (2018 Remaster)' or 'X - Deluxe Edition' -> 'Hounds of Love', 'X'."""
    value = str(value or "").strip()
    cleaned = re.sub(r"(\s*[(\[][^)\]]*[)\]])+$", "", value)  # trailing (…) and […] only
    cleaned = re.sub(rf"\s+[-–:]\s+[^-–:]*\b({EDITION_WORDS})\b.*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip() or value


def similarity(a, b):
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if sorted(a.split()) == sorted(b.split()):
        return 0.97
    return difflib.SequenceMatcher(None, a, b).ratio()


def album_score(want_artist, want_album, artist, album):
    return round(0.6 * similarity(want_album, album) + 0.4 * similarity(want_artist, artist), 2)


def year_of(value):
    match = re.match(r"\s*(\d{4})", str(value or ""))
    return int(match.group(1)) if match else 0


def tidy_genre(value):
    """'trip-hop' -> 'Trip-Hop'; keeps 'R&B', '80s' and existing capitals."""
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return re.sub(r"(^|[\s\-/])([a-z])", lambda m: m.group(1) + m.group(2).upper(), value)


def unique(values):
    seen, out = set(), []
    for value in values:
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            out.append(value)
    return out


# -- HTTP with per-host pacing and a small cache --------------------------

class Http:
    def __init__(self, pacing=None):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.pacing = pacing or {}
        self.locks = {}
        self.last = {}
        self.cache = OrderedDict()
        self.guard = threading.Lock()

    def _wait(self, host):
        with self.guard:
            lock = self.locks.setdefault(host, threading.Lock())
        with lock:
            gap = self.pacing.get(host, 0.2)
            delay = self.last.get(host, 0) + gap - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last[host] = time.monotonic()

    def json(self, url, params=None, headers=None, ttl=3600):
        key = (url, tuple(sorted((params or {}).items())), tuple(sorted((headers or {}).items())))
        with self.guard:
            hit = self.cache.get(key)
            if hit and hit[0] > time.monotonic():
                self.cache.move_to_end(key)
                return hit[1]
        self._wait(urlparse(url).hostname)
        try:
            response = self.session.get(url, params=params, headers=headers, timeout=TIMEOUT)
        except requests.RequestException as error:
            raise SourceError(f"could not be reached ({error.__class__.__name__})") from None
        if response.status_code == 404:
            data = None
        elif response.status_code in (401, 403):
            raise SourceError("refused the request; check the key in Settings")
        elif response.status_code == 429 or response.status_code == 503:
            raise SourceError("is busy; try again in a minute")
        elif not response.ok:
            raise SourceError(f"returned HTTP {response.status_code}")
        else:
            try:
                data = response.json()
            except ValueError:
                raise SourceError("returned something that isn't JSON") from None
        with self.guard:
            self.cache[key] = (time.monotonic() + ttl, data)
            while len(self.cache) > 3000:
                self.cache.popitem(last=False)
        return data


PACING = {
    "musicbrainz.org": 1.1,          # 1 request per second
    "api.deezer.com": 0.15,          # 50 per 5 seconds
    "itunes.apple.com": 3.0,         # about 20 per minute
    "api.discogs.com": 1.1,          # 60 per minute with a token
    "ws.audioscrobbler.com": 0.25,
    "www.theaudiodb.com": 2.1,       # 30 per minute on the free key
    "webservice.fanart.tv": 0.5,
}


# -- sources ------------------------------------------------------------------

class Source:
    name = ""
    label = ""
    key = None          # config key needed, or None
    key_help = ""
    albums = True
    artists = False

    def __init__(self, http, keys):
        self.http, self.keys = http, keys

    @property
    def enabled(self):
        return not self.key or bool(self.keys.get(self.key))

    def album(self, artist, album):
        return []

    def artist(self, name):
        return []


class MusicBrainz(Source):
    name, label = "musicbrainz", "MusicBrainz"
    artists = False
    API = "https://musicbrainz.org/ws/2"

    @staticmethod
    def _quote(value):
        return '"' + re.sub(r'([\\"])', r"\\\1", value) + '"'

    def album(self, artist, album):
        query = f"releasegroup:{self._quote(album)} AND artist:{self._quote(artist)}"
        data = self.http.json(f"{self.API}/release-group", {"query": query, "fmt": "json", "limit": 6})
        out = []
        for group in (data or {}).get("release-groups", []):
            credit = "".join(c.get("name", "") + c.get("joinphrase", "")
                             for c in group.get("artist-credit", []))
            score = album_score(artist, album, credit, group.get("title"))
            if score < MIN_SCORE:
                continue
            date = group.get("first-release-date", "")
            out.append({
                "source": self.name, "id": group["id"], "title": group.get("title", ""),
                "artist": credit, "year": year_of(date), "date": date,
                "note": "First release" + (f" · {group['primary-type']}" if group.get("primary-type") else ""),
                "genres": [], "score": score,
                "cover": f"https://coverartarchive.org/release-group/{group['id']}/front-1200",
                "thumb": f"https://coverartarchive.org/release-group/{group['id']}/front-250",
                "url": f"https://musicbrainz.org/release-group/{group['id']}",
                "kind": group.get("primary-type") or "",
            })
        out.sort(key=lambda c: (-c["score"], c["kind"] != "Album", c["year"] or 9999))
        for item in out[:2]:  # genres need one more request each
            detail = self.http.json(f"{self.API}/release-group/{item['id']}",
                                    {"inc": "genres tags", "fmt": "json"}) or {}
            genres = sorted(detail.get("genres") or [], key=lambda g: -g.get("count", 0))
            if not genres:
                genres = [t for t in sorted(detail.get("tags") or [], key=lambda t: -t.get("count", 0))
                          if t.get("count", 0) > 0]
            item["genres"] = unique([tidy_genre(g["name"]) for g in genres[:6]])
        return out[:5]

    def artist_mbid(self, name):
        data = self.http.json(f"{self.API}/artist", {"query": f"artist:{self._quote(name)}",
                                                     "fmt": "json", "limit": 5}) or {}
        best = max(data.get("artists", []), default=None,
                   key=lambda a: (similarity(name, a.get("name")), int(a.get("score", 0))))
        if best and similarity(name, best.get("name")) >= 0.8:
            return best["id"]
        return ""


class Deezer(Source):
    name, label = "deezer", "Deezer"
    artists = True
    API = "https://api.deezer.com"

    def _get(self, path, params=None):
        data = self.http.json(f"{self.API}/{path}", params) or {}
        if isinstance(data, dict) and data.get("error"):
            message = data["error"].get("message") if isinstance(data["error"], dict) else ""
            if "quota" in str(message).lower():
                raise SourceError("is busy; try again in a minute")
            return {}
        return data

    def album(self, artist, album):
        found = self._get("search/album", {"q": f'artist:"{artist}" album:"{album}"', "limit": 6})
        rows = found.get("data") or self._get("search/album", {"q": f"{artist} {album}",
                                                               "limit": 6}).get("data") or []
        out = []
        for row in rows:
            score = album_score(artist, album, (row.get("artist") or {}).get("name"), row.get("title"))
            if score >= MIN_SCORE:
                out.append({"source": self.name, "id": row["id"], "title": row.get("title", ""),
                            "artist": (row.get("artist") or {}).get("name", ""), "year": 0, "date": "",
                            "note": "Release date of this edition", "genres": [], "score": score,
                            "cover": row.get("cover_xl") or "", "thumb": row.get("cover_medium") or "",
                            "url": row.get("link") or ""})
        out.sort(key=lambda c: -c["score"])
        for item in out[:3]:
            detail = self._get(f"album/{item['id']}")
            item["date"] = detail.get("release_date") or ""
            item["year"] = year_of(item["date"])
            item["genres"] = unique([g.get("name", "") for g in
                                     (detail.get("genres") or {}).get("data", [])])
        return out[:5]

    def artist(self, name):
        rows = self._get("search/artist", {"q": name, "limit": 6}).get("data") or []
        out = []
        for row in rows:
            image = row.get("picture_xl") or ""
            score = round(similarity(name, row.get("name")), 2)
            if score >= 0.75 and image and "/artist//" not in image:
                out.append({"source": self.name, "name": row.get("name", ""), "image": image,
                            "thumb": row.get("picture_medium") or image, "url": row.get("link") or "",
                            "genres": [], "score": score})
        return sorted(out, key=lambda c: -c["score"])[:4]


class ITunes(Source):
    name, label = "itunes", "Apple Music"

    def album(self, artist, album):
        data = self.http.json("https://itunes.apple.com/search",
                              {"term": f"{artist} {album}", "entity": "album", "media": "music",
                               "limit": 8}) or {}
        out = []
        for row in data.get("results", []):
            score = album_score(artist, album, row.get("artistName"), row.get("collectionName"))
            art = row.get("artworkUrl100") or ""
            if score >= MIN_SCORE:
                out.append({"source": self.name, "title": row.get("collectionName", ""),
                            "artist": row.get("artistName", ""), "date": (row.get("releaseDate") or "")[:10],
                            "year": year_of(row.get("releaseDate")), "note": "Release date of this edition",
                            "genres": unique([row.get("primaryGenreName") or ""]), "score": score,
                            "cover": art.replace("100x100bb", "1200x1200bb"),
                            "thumb": art.replace("100x100bb", "300x300bb"),
                            "url": row.get("collectionViewUrl") or ""})
        return sorted(out, key=lambda c: -c["score"])[:5]


class Discogs(Source):
    name, label = "discogs", "Discogs"
    key = "discogs_token"
    key_help = "Discogs → Settings → Developers → Generate new token"
    artists = True
    API = "https://api.discogs.com/database/search"

    def _search(self, params):
        headers = {"Authorization": f"Discogs token={self.keys.get(self.key)}"}
        return (self.http.json(self.API, {**params, "per_page": 8}, headers) or {}).get("results", [])

    def album(self, artist, album):
        rows = self._search({"type": "master", "artist": artist, "release_title": album}) \
            or self._search({"type": "release", "artist": artist, "release_title": album})
        out = []
        for row in rows:
            row_artist, _, row_title = str(row.get("title", "")).partition(" - ")
            score = album_score(artist, album, row_artist, row_title or row.get("title"))
            image = row.get("cover_image") or ""
            if score >= MIN_SCORE:
                out.append({"source": self.name, "title": row_title, "artist": row_artist,
                            "year": year_of(row.get("year")), "date": str(row.get("year") or ""),
                            "note": "Original release" if row.get("type") == "master" else "This release",
                            "genres": unique((row.get("style") or []) + (row.get("genre") or [])),
                            "score": score,
                            "cover": "" if image.endswith("spacer.gif") else image,
                            "thumb": "" if image.endswith("spacer.gif") else row.get("thumb") or image,
                            "url": "https://www.discogs.com" + row["uri"] if row.get("uri") else ""})
        return sorted(out, key=lambda c: -c["score"])[:5]

    def artist(self, name):
        out = []
        for row in self._search({"type": "artist", "q": name}):
            image = row.get("cover_image") or ""
            score = round(similarity(name, row.get("title")), 2)
            if score >= 0.6 and image and not image.endswith("spacer.gif"):
                out.append({"source": self.name, "name": row.get("title", ""), "image": image,
                            "thumb": row.get("thumb") or image, "genres": [], "score": score,
                            "url": "https://www.discogs.com" + row["uri"] if row.get("uri") else ""})
        return sorted(out, key=lambda c: -c["score"])[:4]


class LastFm(Source):
    name, label = "lastfm", "Last.fm"
    key = "lastfm_api_key"
    key_help = "last.fm/api/account/create (only the API key is needed)"
    API = "https://ws.audioscrobbler.com/2.0/"

    def _call(self, method, **params):
        data = self.http.json(self.API, {"method": method, "api_key": self.keys.get(self.key),
                                         "format": "json", "autocorrect": 1, **params}) or {}
        if data.get("error") in (10, 26):
            raise SourceError("refused the API key; check it in Settings")
        if data.get("error") == 29:
            raise SourceError("is busy; try again in a minute")
        return data

    def album(self, artist, album):
        info = self._call("album.getinfo", artist=artist, album=album).get("album")
        if not info:
            return []
        score = album_score(artist, album, info.get("artist"), info.get("name"))
        if score < MIN_SCORE:
            return []
        images = {i.get("size"): i.get("#text") for i in info.get("image", []) if i.get("#text")}
        thumb = images.get("extralarge") or images.get("large") or ""
        cover = "" if LASTFM_PLACEHOLDER in thumb else re.sub(r"/i/u/\d+x\d+/", "/i/u/", thumb)
        tags = (info.get("tags") or {}).get("tag") or []
        if isinstance(tags, dict):
            tags = [tags]
        genres = [tidy_genre(t.get("name")) for t in tags]
        if not genres:  # fall back on the artist's tags
            top = self._call("artist.gettoptags", artist=artist).get("toptags", {}).get("tag", [])
            genres = [tidy_genre(t.get("name")) for t in top[:5] if int(t.get("count", 0)) >= 10]
        return [{"source": self.name, "title": info.get("name", ""), "artist": info.get("artist", ""),
                 "year": 0, "date": "", "note": "Tags from Last.fm listeners",
                 "genres": unique(genres)[:6], "score": score, "cover": cover,
                 "thumb": "" if not cover else thumb, "url": info.get("url") or ""}]


class TheAudioDB(Source):
    name, label = "theaudiodb", "TheAudioDB"
    artists = True
    API = "https://www.theaudiodb.com/api/v1/json/123"

    def album(self, artist, album):
        data = self.http.json(f"{self.API}/searchalbum.php", {"s": artist, "a": album}) or {}
        out = []
        for row in data.get("album") or []:
            score = album_score(artist, album, row.get("strArtist"), row.get("strAlbum"))
            image = row.get("strAlbumThumb") or ""
            if score >= MIN_SCORE:
                out.append({"source": self.name, "title": row.get("strAlbum", ""),
                            "artist": row.get("strArtist", ""), "year": year_of(row.get("intYearReleased")),
                            "date": str(row.get("intYearReleased") or ""), "note": "",
                            "genres": unique([row.get("strStyle") or "", row.get("strGenre") or ""]),
                            "score": score, "cover": image, "thumb": f"{image}/preview" if image else "",
                            "url": f"https://www.theaudiodb.com/album/{row['idAlbum']}" if row.get("idAlbum") else ""})
        return sorted(out, key=lambda c: -c["score"])[:3]

    def artist(self, name):
        data = self.http.json(f"{self.API}/search.php", {"s": name}) or {}
        out = []
        for row in data.get("artists") or []:
            image = row.get("strArtistThumb") or ""
            score = round(similarity(name, row.get("strArtist")), 2)
            if score >= 0.6 and image:
                out.append({"source": self.name, "name": row.get("strArtist", ""), "image": image,
                            "thumb": f"{image}/preview", "score": score,
                            "genres": unique([row.get("strStyle") or "", row.get("strGenre") or ""]),
                            "url": f"https://www.theaudiodb.com/artist/{row['idArtist']}" if row.get("idArtist") else ""})
        return out[:3]


class FanartTv(Source):
    name, label = "fanart", "fanart.tv"
    key = "fanart_api_key"
    key_help = "fanart.tv/get-an-api-key (a personal API key)"
    albums = False
    artists = True

    def artist(self, name):
        mbid = MusicBrainz(self.http, self.keys).artist_mbid(name)
        if not mbid:
            return []
        data = self.http.json(f"https://webservice.fanart.tv/v3/music/{mbid}",
                              {"api_key": self.keys.get(self.key)}) or {}
        thumbs = sorted(data.get("artistthumb") or [], key=lambda t: -int(t.get("likes") or 0))
        return [{"source": self.name, "name": data.get("name") or name, "image": t["url"],
                 "thumb": t["url"].replace("/fanart/", "/preview/"), "genres": [], "score": 1.0,
                 "url": f"https://fanart.tv/artist/{mbid}"} for t in thumbs[:4] if t.get("url")]


SOURCES = [MusicBrainz, Deezer, ITunes, Discogs, LastFm, TheAudioDB, FanartTv]
KEYS = {cls.key: cls for cls in SOURCES if cls.key}


class Lookup:
    """All sources, sharing one paced HTTP session and cache."""

    def __init__(self, keys_func):
        self.http = Http(PACING)
        self.keys_func = keys_func  # returns the current {config key: value}

    def _sources(self):
        keys = self.keys_func()
        return {cls.name: cls(self.http, keys) for cls in SOURCES}

    def describe(self):
        return [{"name": s.name, "label": s.label, "albums": s.albums, "artists": s.artists,
                 "enabled": s.enabled, "key": s.key or "", "key_help": s.key_help}
                for s in self._sources().values()]

    def _get(self, name, kind):
        source = self._sources().get(name)
        if not source or not getattr(source, kind):
            raise SourceError(f"Unknown {kind[:-1]} source.")
        if not source.enabled:
            raise SourceError(f"{source.label} needs a key. Add it in Settings.")
        return source

    def album(self, name, artist, album):
        source = self._get(name, "albums")
        artist, album = str(artist or "").strip(), str(album or "").strip()
        if not artist or not album:
            raise SourceError("Enter an artist and an album to search for.")
        try:
            return source.album(artist[:200], search_title(album)[:200])
        except SourceError as error:
            raise SourceError(f"{source.label} {error}.") from None

    def artist(self, name, artist):
        source = self._get(name, "artists")
        artist = str(artist or "").strip()
        if not artist:
            raise SourceError("Enter an artist to search for.")
        try:
            return source.artist(artist[:200])
        except SourceError as error:
            raise SourceError(f"{source.label} {error}.") from None
