"""A tiny fake iBroadcast (OAuth + API + library) for end-to-end testing.

Run:  python tests/mock_ibroadcast.py 9555
Then: TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9555 IBROADCAST_CLIENT_ID=test \
      PYTHONPATH=src python -m tagcast.app

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
        900: {"title": "Running Up That Hill", "album_id": 72, "artist_id": 41, "year": 1985, "genre": "", "track": 1, "trashed": False, "artwork_id": 600},
        901: {"title": "Hounds of Love", "album_id": 72, "artist_id": 41, "year": 1985, "genre": "", "track": 2, "trashed": False, "artwork_id": 601},
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
    "artist_art": {41: 0, 42: 500},
    "next_artwork": 9000,
    "uploads": [],  # (filename, bytes) of uploaded artwork
    "combine_sets": False,  # the account setting that blocks update_album
    "busy": 0,  # answer this many writes with HTTP 503 first
}
AUDIO = bytes(range(256)) * 40  # 10 KB of "audio" for stream tests
# a 1x1 PNG, served at /image.png for image download tests
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")
LOCK = threading.Lock()
TOKEN = "access-1"


def library():
    tmap = {"title": 0, "album_id": 1, "artist_id": 2, "year": 3, "genre": 4, "track": 5,
            "trashed": 6, "artwork_id": 7, "artists_additional": 8, "file": 9, "type": 10,
            "artists_additional_map": {"artist_id": 0, "phrase": 1}}
    tracks = {"map": tmap}
    for i, t in STATE["tracks"].items():
        tracks[str(i)] = [t["title"], t["album_id"], t["artist_id"], t["year"], t["genre"],
                          t["track"], t["trashed"], t["artwork_id"], [], f"/128/abc/{i}", "audio/mpeg"]
    albums = {"map": {"name": 0, "tracks": 1, "artist_id": 2, "trashed": 3, "year": 4, "disc": 5}}
    for i, a in STATE["albums"].items():
        albums[str(i)] = [a["name"], a["tracks"], a["artist_id"], False, a["year"], a["disc"]]
    artists = {"map": {"name": 0, "tracks": 1, "trashed": 2, "artwork_id": 3}}
    for i, name in STATE["artists"].items():
        artists[str(i)] = [name, [], False, STATE["artist_art"].get(i, 0)]
    return {"result": True, "authenticated": True, "settings": {"artwork_server": "http://127.0.0.1:1"},
            "status": {"lastmodified": lastmodified()},
            "lastfm": {"sessionkey": "secret-lastfm-session"},
            "library": {"albums": albums, "tracks": tracks, "artists": artists, "expires": 1999999999,
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
        elif url.path == "/image.png":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        elif url.path.startswith("/stream/"):
            q = parse_qs(url.query)
            if q.get("Signature") != [TOKEN] or q.get("user_id") != ["7"]:
                return self.send(403, {})
            data, start = AUDIO, 0
            ranged = self.headers.get("Range", "").startswith("bytes=")
            if ranged:
                first, _, last = self.headers["Range"][6:].partition("-")
                start, end = int(first or 0), int(last) if last else len(AUDIO) - 1
                data = AUDIO[start:end + 1]
            self.send_response(206 if ranged else 200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(data)))
            if ranged:
                self.send_header("Content-Range", f"bytes {start}-{start + len(data) - 1}/{len(AUDIO)}")
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send(404, {})

    def do_POST(self):
        url = urlparse(self.path)
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if url.path == "/_reject":
            STATE["reject"] = set(json.loads(raw))
            return self.send(200, {})
        if url.path == "/_combine_sets":  # body: true or false
            STATE["combine_sets"] = bool(json.loads(raw or b"false"))
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
        if url.path == "/artwork-upload":
            if b'name="uploaded_file"' not in raw or b'name="user_id"' not in raw:
                return self.send(200, {"result": False, "message": "no file"})
            with LOCK:
                STATE["next_artwork"] += 1
                STATE["uploads"].append(raw)
                return self.send(200, {"result": True, "artwork_id": STATE["next_artwork"]})
        body = json.loads(raw)
        mode = body.get("mode")
        with LOCK:
            if mode in STATE["reject"]:
                return self.send(200, {"result": False, "message": f"{mode} is not allowed for this app"})
            if url.path == "/library":
                STATE["downloads"] += 1
                return self.send(200, library())
            if mode == "status":
                return self.send(200, {"result": True, "status": {"lastmodified": lastmodified(), "plays": 42,
                                                                  "available": 5, "achievement_status": {"1": {}}},
                                       "lastfm": {"linked": True, "user": "wilfred", "sessionkey": "secret"},
                                       "dropbox": {"linked": False}, "googledrive": {"linked": False},
                                       "user": {"username": "wilfred", "id": "7", "token": "x",
                                                "email_address": "wilfred@example.com", "verified": True,
                                                "verified_on": "2021-11-28 19:00:00", "premium": False,
                                                "preferences": {"combine_sets": "1" if STATE["combine_sets"] else "0"}}})
            if mode == "update_album" and STATE["combine_sets"]:
                return self.send(200, {"result": False, "message": "You currently have 'Combine Multi-Disc Album Sets' on."})
            if mode in ("update_album", "update_track", "create_artist", "set_artwork",
                        "set_artist_artwork"):
                if STATE["busy"]:
                    STATE["busy"] -= 1
                    return self.send(503, {"message": "busy"})
                STATE["writes"].append(body)
                STATE["version"] += 1
            if mode == "set_artwork":
                for track_id in body["tracks"]:
                    STATE["tracks"][track_id]["artwork_id"] = body["artwork_id"]
                return self.send(200, {"result": True})
            if mode == "set_artist_artwork":
                STATE["artist_art"][body["artist_id"]] = body["artwork_id"]
                return self.send(200, {"result": True})
            if mode == "get_artwork":
                return self.send(200, {"result": True, "art": [{"artwork_id": 77}, {"artwork_id": 78}]})
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
