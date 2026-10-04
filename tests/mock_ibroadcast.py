"""A tiny fake iBroadcast (OAuth + API + library) for end-to-end testing.

Run:  python tests/mock_ibroadcast.py 9555
Then: LIBRARY_STUDIO_IBROADCAST_BASE=http://127.0.0.1:9555 IBROADCAST_CLIENT_ID=test \
      PYTHONPATH=src python -m ibroadcast_editor.app

The device code is approved automatically on the second poll. Every write
request is appended to the "writes" list, visible at GET /_writes.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE = {
    "artists": {41: "Kate Bush", 42: "Pink Floyd", 43: "pink floyd"},
    "albums": {
        72: {"name": "Hounds of Love", "artist_id": 41, "year": 0, "disc": 1, "tracks": [900, 901, 902]},
        73: {"name": "The Dreaming", "artist_id": 41, "year": 1982, "disc": 1, "tracks": [903]},
        74: {"name": "Wish You Were Here", "artist_id": 42, "year": 1975, "disc": 1, "tracks": [904]},
    },
    "tracks": {
        900: {"title": "Running Up That Hill", "album_id": 72, "artist_id": 41, "year": 1985, "genre": "", "track": 1, "trashed": False, "artwork_id": 0},
        901: {"title": "Hounds of Love", "album_id": 72, "artist_id": 41, "year": 1985, "genre": "", "track": 2, "trashed": False, "artwork_id": 0},
        902: {"title": "Old deleted", "album_id": 72, "artist_id": 41, "year": 1985, "genre": "", "track": 3, "trashed": True, "artwork_id": 0},
        903: {"title": "Sat in Your Lap", "album_id": 73, "artist_id": 41, "year": 1982, "genre": "Art Pop", "track": 1, "trashed": False, "artwork_id": 0},
        904: {"title": "Wish You Were Here", "album_id": 74, "artist_id": 42, "year": 1975, "genre": "Rock", "track": 4, "trashed": False, "artwork_id": 0},
    },
    "writes": [],
    "polls": 0,
    "downloads": 0,  # full library downloads
    "version": 1,  # bumped on every write, reported as lastmodified
    "next_artist": 100,
    "reject": set(),  # modes to reject, set via POST /_reject
}
LOCK = threading.Lock()
TOKEN = "access-1"


def library():
    tmap = {"title": 0, "album_id": 1, "artist_id": 2, "year": 3, "genre": 4, "track": 5,
            "trashed": 6, "artwork_id": 7, "artists_additional": 8,
            "artists_additional_map": {"artist_id": 0, "phrase": 1}}
    tracks = {"map": tmap}
    for i, t in STATE["tracks"].items():
        tracks[str(i)] = [t["title"], t["album_id"], t["artist_id"], t["year"], t["genre"],
                          t["track"], t["trashed"], t["artwork_id"], []]
    albums = {"map": {"name": 0, "tracks": 1, "artist_id": 2, "trashed": 3, "year": 4, "disc": 5}}
    for i, a in STATE["albums"].items():
        albums[str(i)] = [a["name"], a["tracks"], a["artist_id"], False, a["year"], a["disc"]]
    artists = {"map": {"name": 0, "tracks": 1, "trashed": 2}}
    for i, name in STATE["artists"].items():
        artists[str(i)] = [name, [], False]
    return {"result": True, "authenticated": True, "settings": {"artwork_server": "http://127.0.0.1:1"},
            "status": {"lastmodified": lastmodified()},
            "lastfm": {"sessionkey": "secret-lastfm-session"},
            "library": {"albums": albums, "tracks": tracks, "artists": artists,
                        "playlists": {"map": {}}, "tags": {}}}


def lastmodified():
    return f"2026-10-04 12:00:{STATE['version']:02d}"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/oauth/device/code":
            q = parse_qs(url.query)
            assert q["client_id"] == ["test"], q
            self.send(200, {"device_code": "dev-1", "user_code": "WXYZ-1234", "interval": 1,
                            "expires_in": 600, "verification_uri": "https://example.invalid/device"})
        elif url.path == "/_writes":
            self.send(200, STATE["writes"])
        else:
            self.send(404, {})

    def do_POST(self):
        url = urlparse(self.path)
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if url.path == "/_reject":
            STATE["reject"] = set(json.loads(raw))
            return self.send(200, {})
        if url.path == "/_edit_elsewhere":
            STATE["albums"][73]["year"] += 1
            STATE["version"] += 1
            return self.send(200, {})
        if url.path.startswith("/oauth/"):
            form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            if url.path == "/oauth/token":
                if form.get("grant_type") == "device_code":
                    STATE["polls"] += 1
                    if STATE["polls"] < 2:
                        return self.send(400, {"error": "authorization_pending"})
                return self.send(200, {"access_token": TOKEN, "refresh_token": "refresh-1",
                                       "expires_in": 3600, "scope": "user.library:read user.library:write"})
            return self.send(200, {})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self.send(200, {"result": False, "authenticated": False})
        body = json.loads(raw)
        mode = body.get("mode")
        with LOCK:
            if mode in STATE["reject"]:
                return self.send(200, {"result": False, "message": f"{mode} is not allowed for this app"})
            if url.path == "/library":
                STATE["downloads"] += 1
                return self.send(200, library())
            if mode == "status":
                return self.send(200, {"result": True, "status": {"lastmodified": lastmodified()},
                                       "user": {"username": "wilfred", "id": "7", "token": "x"}})
            if mode in ("update_album", "update_track", "create_artist"):
                STATE["writes"].append(body)
                STATE["version"] += 1
            if mode == "create_artist":
                STATE["next_artist"] += 1
                STATE["artists"][STATE["next_artist"]] = body["name"]
                return self.send(200, {"result": True, "artist_id": STATE["next_artist"]})
            if mode == "update_album":
                for row in body["albums"]:
                    a = STATE["albums"][row["album_id"]]
                    for k in ("name", "artist_id"):
                        if k in row:
                            a[k] = row[k]
                    for k in ("year", "disc"):
                        if k in row:
                            a[k] = int(row[k] or 0)
                return self.send(200, {"result": True})
            if mode == "update_track":
                for row in body["tracks"]:
                    t = STATE["tracks"][row["file_id"]]
                    for k in ("title", "genre", "artist_id"):
                        if k in row:
                            t[k] = row[k]
                    if "year" in row:
                        t["year"] = int(row["year"] or 0)
                    if "track_no" in row:
                        t["track"] = int(row["track_no"])
                return self.send(200, {"result": True})
        self.send(200, {"result": False, "message": "unknown mode"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
