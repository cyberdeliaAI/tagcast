"""Offline B-03 probe: synthetic library, loopback status service, temporary settings.

Run with PYTHONPATH=src. No real account, credentials, audio or mutations.
--serve exposes the actual frontend/API for an optional browser probe.
"""

import argparse
import gc
import hashlib
import json
import platform
import statistics
import tempfile
import threading
import time
import weakref
from collections import Counter
from contextlib import ExitStack
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tagcast import app, client
from tagcast.library import Library


def fixture(albums=18739, tracks=291071, artists=2631):
    """Compact-table dimensions from the existing library-performance fixture."""
    artist_rows = {str(i): [f"Synthetic Artist {i:04d}"] for i in range(1, artists + 1)}
    artist_rows["map"] = {"name": 0}
    album_rows = {"map": {"name": 0, "tracks": 1, "artist_id": 2, "year": 3, "disc": 4}}
    track_rows = {"map": {key: i for i, key in enumerate([
        "title", "album_id", "artist_id", "year", "genre", "track", "rating", "length",
        "artists_additional", "path", "uploaded_on"])}}
    cursor = 0
    for album in range(1, albums + 1):
        artist = (album - 1) % artists + 1
        size = tracks // albums + (album <= tracks % albums)
        ids = list(range(cursor + 1, cursor + size + 1))
        year = 1950 + album % 75
        album_rows[str(album)] = [f"Synthetic Album {album:05d}", ids, artist, year, 1]
        for position, ident in enumerate(ids, 1):
            track_rows[str(ident)] = [f"Synthetic Track {position:02d}", album, artist, year,
                "Jazz" if album % 2 else "Rock", position, 5 if ident % 17 == 0 else 0, 240,
                [[artist, "", "composer"]] if position % 4 == 0 else [],
                f"/Synthetic/Artist {artist}/Album {album}", f"2021-10-{album % 28 + 1:02d}"]
        cursor += size
    tags = {str(i): {"name": f"Synthetic tag {i:03d}", "tracks": list(range(i, tracks + 1, 500)),
                    "archived": False} for i in range(1, 241)}
    return {"combine_sets": False, "status": {"lastmodified": "synthetic"}, "library": {
        "artists": artist_rows, "albums": album_rows, "tracks": track_rows,
        "tags": tags, "playlists": {"map": {}}}}


def graph_size(value):
    """Retained derived containers/values, counted once; excludes native tables and RSS."""
    import sys

    seen = set()
    def visit(item):
        if id(item) in seen:
            return 0
        seen.add(id(item))
        total = sys.getsizeof(item)
        if isinstance(item, dict):
            total += sum(visit(k) + visit(v) for k, v in item.items())
        elif isinstance(item, (list, tuple, set, frozenset)):
            total += sum(map(visit, item))
        return total
    return visit(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--status-delay-ms", type=float, default=50)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--albums", type=int, default=18739)
    parser.add_argument("--tracks", type=int, default=291071)
    parser.add_argument("--artists", type=int, default=2631)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    data = fixture(args.albums, args.tracks, args.artists)
    state = {"outage": False, "counts": Counter()}

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            mode = body.get("mode")
            if mode not in ("status", "library"):
                raise AssertionError(f"No mutation is permitted: {mode}")
            state["counts"][mode] += 1
            time.sleep(args.status_delay_ms / 1000 if mode == "status" else 0)
            response = {"result": True, **(data if mode == "library" else {
                "status": data["status"], "user": {"id": "synthetic", "premium": True}})}
            encoded = json.dumps({"message": "Synthetic outage"} if state["outage"] else response).encode()
            self.send_response(503 if state["outage"] else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{upstream.server_port}"
    with tempfile.TemporaryDirectory(prefix="tagcast-browse-probe-") as home, ExitStack() as stack:
        stack.callback(upstream.server_close)
        stack.callback(upstream.shutdown)
        stack.enter_context(patch.object(client, "API_URL", origin))
        stack.enter_context(patch.object(client, "LIBRARY_URL", origin + "/library"))
        # Only the experiment's outage backoff is shortened. Production defaults stay 2s/6s.
        stack.enter_context(patch.object(client, "RETRY_DELAYS", (.01, .02)))
        studio = client.Studio(home)
        studio.client = client.StudioClient(access_token="synthetic-probe-only")
        studio.library = Library(data)
        studio.library_user, studio.account, studio.playback_session = "synthetic", "Synthetic", "probe-session"
        studio.config["auto_updates"] = False
        if args.serve:
            class Frontend(app.Handler):
                def do_GET(self):
                    if self.path.startswith("/_benchmark/"):
                        if self.path.endswith("outage-on"):
                            state["outage"] = True
                        elif self.path.endswith("outage-off"):
                            state["outage"] = False
                        return self._json(200, state)
                    return super().do_GET()
            Frontend.studio = studio
            server = app.Server(("127.0.0.1", 0), partial(Frontend, directory=str(app.STATIC)))
            Frontend.port = server.server_port
            print(json.dumps({"origin": f"http://127.0.0.1:{server.server_port}", "synthetic": True}), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return

        initial_snapshot = weakref.ref(studio.library)
        result = {"python": platform.python_version(), "platform": platform.platform(),
            "fixture": {"albums": args.albums, "tracks": args.tracks, "artists": args.artists, "tags": 240},
            "status_delay_ms": args.status_delay_ms, "repeats": args.repeats, "operations": {}}
        result["source_sha256"] = {name: hashlib.sha256((Path(client.__file__).parent / name).read_bytes()).hexdigest()
                                   for name in ("client.py", "tags.py")}
        def measure(name, operation, count=None):
            samples, statuses, downloads, successes, digests = [], [], [], [], []
            for _ in range(count or args.repeats):
                before = state["counts"].copy()
                start = time.perf_counter()
                value = None
                try:
                    value = operation()
                    successes.append(True)
                except client.ApiError:
                    successes.append(False)
                samples.append((time.perf_counter() - start) * 1000)
                digests.append(hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest())
                statuses.append(state["counts"]["status"] - before["status"])
                downloads.append(state["counts"]["library"] - before["library"])
            result["operations"][name] = {"median_ms": statistics.median(samples), "samples_ms": samples,
                "status_requests": statuses, "library_downloads": downloads, "success": successes, "response_sha256": digests}
            print(name, round(statistics.median(samples), 3), statuses, flush=True)

        measure("cold_track_artist_index", lambda: studio.browse("track-artists", limit="60"), 1)
        for kind in ("composers", "genres", "years", "decades", "tags", "upload-folders", "uploaded"):
            studio.browse(kind, limit="60")
        studio.favourites()
        studio.tags.catalogue()
        operations = {
            "browse_genres": lambda: studio.browse("genres"),
            "browse_artist_page": lambda: studio.browse("track-artists", offset="60", limit="60", sort="count"),
            "category_changes": lambda: [studio.browse(k) for k in ("genres", "years", "composers", "tags")],
            "favourites": lambda: studio.favourites(query="Synthetic", limit="100"),
            "tag_catalogue": lambda: studio.tags.catalogue(),
            "tag_selection": lambda: studio.tags.selection(["1"]),
            "continuous_20_pages": lambda: [studio.browse("track-artists", offset=str(i * 60), limit="60") for i in range(20)],
            "restore_40_pages": lambda: [studio.browse("track-artists", offset=str(i * 60), limit="60") for i in range(40)],
        }
        for name, operation in operations.items():
            measure(name, operation)
        def retained():
            lib = studio.library
            return graph_size([lib._browse_indexes, lib._browse_tracks, lib._browse_albums, lib._favourites])
        first_size = retained()
        for _ in range(10):
            for kind in ("track-artists", "composers", "genres", "years", "tags"):
                studio.browse(kind)
        result["memory"] = {"derived_bytes_before_repetition": first_size,
                            "derived_bytes_after_repetition": retained(), "same_snapshot": studio.library is initial_snapshot()}
        state["outage"] = True
        for name in ("browse_genres", "favourites", "tag_catalogue", "tag_selection"):
            measure("outage_" + name, operations[name], 1)
        old = weakref.ref(studio.library)
        studio.library = None
        gc.collect()
        result["memory"]["replaced_snapshot_collected"] = old() is None
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
