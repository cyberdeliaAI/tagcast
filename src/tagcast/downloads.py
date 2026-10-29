"""Explicit, account/session-bound downloads using the ibfetch transfer engine.

No iBroadcast metadata writes, second login, library download, or player state.
The queue and review live in memory; only local download options and the engine's
integrity manifests persist. Starting after an interruption is always explicit.
"""

import json
import secrets
import threading
import time
from pathlib import Path

from . import download_engine as engine
from .library import ConflictError, LibraryError, number, text

MAX_ALBUMS = 200
MAX_TRACKS = 10000
REVIEW_LIFETIME = 15 * 60
ACTIVE_STATES = {"ready", "planning", "running"}


class EngineTable:
    """Read compact Tagcast records without copying the entire library."""

    def __init__(self, table, members=None):
        self.table, self.members = table, members

    def get(self, row_id, field, default=None):
        row = self.table.get(number(row_id))
        if row is None:
            return default
        if field == "album_id" and self.members is not None:
            return self.members.get(number(row_id), default)
        return row.get(field, default)

    def __iter__(self):
        return iter(self.table)

    def __contains__(self, row_id):
        return row_id in self.table


class DownloadLibrary(engine.Library):
    """Adapter for the existing immutable loaded-library snapshot.

    Membership comes from active album rows, including iBroadcast combined sets;
    orphan tracks cannot enter the planner through their stale album_id alone.
    """

    def __init__(self, library, user, premium, stop):
        members = {}
        for album_id in library.album_ids():
            if stop.is_set():
                raise engine.Fail("Download preparation stopped.")
            for tid in library.active_track_ids(album_id):
                if tid in members and members[tid] != album_id:
                    raise engine.Fail("Ambiguous album membership. Reload the library.")
                members[tid] = album_id
        self.artists, self.albums = EngineTable(library.artists), EngineTable(library.albums)
        self.tracks = EngineTable(library.tracks, members)
        self.user_id, self.premium = user, premium
        self.expires = library.expires
        self._discs = self._album_members = self._default_directories = None
        self.plan_lock = threading.Lock()
        self._path_plans = {}
        self.members = members

    def artist_name(self, artist_id):
        return "Various Artists" if not number(artist_id) else super().artist_name(artist_id)

    def active(self, track_id):
        return track_id in self.members and not self.tracks.get(track_id, "trashed")


class DownloadResponse:
    """Bounded requests transport exposed as the engine's streaming reader."""

    def __init__(self, response, owner):
        self.response, self.owner = response, owner
        self.headers, self.status = response.headers, response.status_code
        with owner.response_lock:
            if owner.cancelled.is_set():
                response.close()
                raise engine.Fail("Download stopped.")
            owner.responses.add(self)

    def read(self, size=-1):
        if self.owner.cancelled.is_set() or not self.owner.valid():
            raise engine.Fail("Download stopped: the connection changed.")
        try:
            return self.response.raw.read(size, decode_content=True)
        except Exception as error:
            # Never expose requests/urllib3 exception text: URLs can contain tokens.
            raise OSError(f"Audio connection interrupted ({type(error).__name__}).") from None

    def close(self):
        try:
            self.response.close()
        finally:
            with self.owner.response_lock:
                self.owner.responses.discard(self)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class DownloadSession:
    """Use Tagcast's shared token refresh gate, never a second token store."""

    def __init__(self, studio, context):
        self.studio, self.context = studio, context
        self.client, _, self.user, self.session, _ = context
        self.cancelled = threading.Event()
        self.response_lock = threading.Lock()
        self.responses = set()

    def valid(self):
        s = self.studio
        with s.lock:
            return not self.cancelled.is_set() and s.client is self.client \
                and s.playback_session == self.session and s.library_user == self.user

    def _open(self, send):
        if not self.valid():
            raise engine.Fail("Download stopped: the connection changed.")
        try:
            response = send()
        except Exception as error:
            raise OSError(f"Could not reach iBroadcast ({type(error).__name__}).") from None
        if not self.valid():
            response.close()
            raise engine.Fail("Download stopped: the connection changed.")
        return DownloadResponse(response, self)

    def stream(self, path, track_id, user_id, expires, offset=0):
        return self._open(lambda: self.client.open_stream(
            path, track_id, user_id, expires, f"bytes={offset}-" if offset else None,
            timeout=(10, 30)))

    def download(self, track_id, user_id):
        response = self._open(lambda: self.client.open_download(track_id, user_id))
        if response.status == 200 and not engine.textual(response):
            return response
        code = response.status
        response.close()
        # Do not echo the provider body (it may contain request/account data).
        raise engine.ServiceError(f"iBroadcast download service returned HTTP {code}",
                                  retry=code == 429 or code >= 500)

    def close(self):
        self.cancelled.set()
        with self.response_lock:
            responses = list(self.responses)
        for response in responses:
            response.close()


class AudioDownloads:
    def __init__(self, studio):
        self.studio = studio
        self.lock = threading.RLock()
        self.owner = None
        self.queue = {}
        self.generation = 0
        self.review = None
        self.transfer = self.transport = self.thread = None
        self.preparing = self.picker = False
        self.error = ""
        self.stop = threading.Event()
        self.options = self._read_options()

    def _read_options(self):
        defaults = {"out": str(Path.home() / "Music" / "Tagcast"), "quality": "orig",
                    "source": "download", "workers": 1, "layout": engine.DEFAULT_LAYOUT,
                    "work": "", "verify": False}
        try:
            saved = json.loads((self.studio.home / "download-options.json").read_text("utf-8"))
            return self._options({**defaults, **saved})
        except (OSError, ValueError, TypeError, engine.Fail, LibraryError):
            return defaults

    @staticmethod
    def _options(body):
        out, work = body.get("out"), body.get("work", "")
        if not isinstance(out, str) or not out.strip() or len(out) > 4096 or "\0" in out:
            raise LibraryError("Choose a download folder on this computer.")
        if not isinstance(work, str) or len(work) > 4096 or "\0" in work:
            raise LibraryError("Choose a valid local work folder, or leave it empty.")
        quality, source = body.get("quality", "orig"), body.get("source", "download")
        if quality not in engine.QUALITIES:
            raise LibraryError("Choose a supported download quality.")
        source = engine.resolve_source(source if quality == "orig" else "stream", quality)
        workers = body.get("workers", 1)
        if type(workers) is not int or not 1 <= workers <= 4:
            raise LibraryError("Choose between one and four simultaneous downloads.")
        if type(body.get("verify", False)) is not bool:
            raise LibraryError("Invalid checksum option.")
        layout = body.get("layout", engine.DEFAULT_LAYOUT)
        if not isinstance(layout, str) or len(layout) > 500:
            raise LibraryError("Choose a valid folder layout.")
        engine.Layout(layout)
        if not Path(out.strip()).expanduser().is_absolute() or work.strip() and not Path(work.strip()).expanduser().is_absolute():
            raise LibraryError("Use a full folder path (or a path beginning with ~).")
        out = Path(out.strip()).expanduser().resolve()
        work = Path(work.strip()).expanduser().resolve() if work.strip() else None
        if work and (work == out or work in out.parents or out in work.parents):
            raise LibraryError("Use a work folder outside the download folder.")
        return {"out": str(out), "work": str(work) if work else "", "quality": quality,
                "source": source, "workers": workers, "layout": layout,
                "verify": body.get("verify", False)}

    def _context(self, session):
        s = self.studio
        with s.lock:
            if not s.client or not s.library or not s.library_user or not session \
                    or session != s.playback_session:
                raise ConflictError("Connect and load your library before downloading.")
            return s.client, s.library, s.library_user, s.playback_session, s.premium

    def _bind(self, context):
        owner = context[0], context[2], context[3]
        if owner != self.owner:
            self._cancel()
            self.owner, self.queue = owner, {}
            self.review = self.transfer = self.transport = None
            self.generation += 1
            self.preparing, self.error = False, ""

    def _active(self):
        return self.preparing or self.transfer is not None and self.transfer.state in ACTIVE_STATES

    def _idle(self):
        if self._active():
            raise ConflictError("Stop the current download task before changing its selection.")

    def _invalidate(self):
        self.review, self.error = None, ""
        self.generation += 1

    def view(self, session):
        context = self._context(session)
        with self.lock:
            self._bind(context)
            options = dict(self.options)
            if not context[4]:
                options.update(quality="128", source="stream")
            review = self.review
            if review and (review["context"][1] is not context[1]
                           or time.monotonic() - review["created"] > REVIEW_LIFETIME):
                self.review = review = None
                self.error = "The library or review changed. Prepare the download again."
            return {"albums": list(self.queue.values()),
                    "tracks": sum(a["tracks"] for a in self.queue.values()),
                    "options": options, "premium": bool(context[4]), "preparing": self.preparing,
                    "review": review["view"] if review else None, "error": self.error,
                    "transfer": self.transfer.snapshot() if self.transfer else None}

    def add(self, body):
        context = self._context(body.get("session"))
        ids = body.get("albums")
        if not isinstance(ids, list) or not ids or len(ids) > MAX_ALBUMS \
                or any(isinstance(i, bool) or not str(i).isdigit() or int(i) <= 0 for i in ids):
            raise LibraryError(f"Choose up to {MAX_ALBUMS} album discs.")
        library = context[1]
        additions = {}
        for album_id in dict.fromkeys(map(int, ids)):
            album = library.albums.get(album_id)
            tracks = library.active_track_ids(album_id)
            if not album or album.get("trashed") or not tracks:
                raise ConflictError("An album is no longer available. Reload the library.")
            additions[str(album_id)] = {"id": str(album_id), "title": text(album.get("name")),
                                       "artist": library.artist_name(album.get("artist_id")),
                                       "disc": number(album.get("disc")) or 1, "tracks": len(tracks)}
        with self.lock:
            self._bind(context)
            self._idle()
            combined = {**self.queue, **additions}
            if len(combined) > MAX_ALBUMS or sum(a["tracks"] for a in combined.values()) > MAX_TRACKS:
                raise LibraryError(f"Download up to {MAX_ALBUMS} discs / {MAX_TRACKS:,} tracks at a time.")
            self.queue = combined
            self._invalidate()
        return self.view(body.get("session"))

    def remove(self, body):
        context = self._context(body.get("session"))
        with self.lock:
            self._bind(context)
            self._idle()
            if body.get("clear") is True:
                self.queue.clear()
            else:
                self.queue.pop(str(body.get("album")), None)
            self._invalidate()
        return self.view(body.get("session"))

    def prepare(self, body):
        context = self._context(body.get("session"))
        try:
            options = self._options(body)
        except engine.Fail as error:
            raise LibraryError(str(error)) from None
        if not context[4] and options["quality"] != "128":
            raise LibraryError("Free accounts can download 128 kbps MP3 only.")
        with self.lock:
            self._bind(context)
            self._idle()
            if not self.queue:
                raise LibraryError("Add albums to Downloads first.")
            groups = []
            for album_id in self.queue:
                album = context[1].albums.get(int(album_id))
                tracks = context[1].active_track_ids(int(album_id))
                if not album or album.get("trashed") or not tracks:
                    raise ConflictError("The selection changed. Clear it and choose the albums again.")
                groups.append((int(album_id), tracks))
            if sum(len(t) for _, t in groups) > MAX_TRACKS:
                raise LibraryError("The selection is too large. Choose fewer albums.")
            self.queue = {str(a): {"id": str(a), "title": text(context[1].albums[a].get("name")),
                "artist": context[1].artist_name(context[1].albums[a].get("artist_id")),
                "disc": number(context[1].albums[a].get("disc")) or 1, "tracks": len(tracks)}
                for a, tracks in groups}
            self._invalidate()
            generation = self.generation
            self.stop = stop = threading.Event()
            self.preparing = True
            self.transfer = self.transport = None
        def plan():
            try:
                # Reuse the player's quality/path validation; never label original
                # bytes as converted MP3 when an unknown path cannot select quality.
                for _, tracks in groups:
                    for track_id in tracks:
                        if stop.is_set():
                            raise engine.Fail("Download preparation stopped.")
                        context[1].stream_info(track_id, options["quality"])
                adapted = DownloadLibrary(context[1], context[2], context[4], stop)
                jobs = engine.plan_jobs(adapted, groups, options["quality"], engine.Layout(options["layout"]), stop)
                if not jobs:
                    raise engine.Fail("No active tracks in this selection.")
                if any(not path for _, path, _ in jobs):
                    raise engine.Fail("A selected track has no supported stream path. Reload the library.")
                review = {"id": secrets.token_urlsafe(24), "tracks": len(jobs), "discs": len(groups),
                          "examples": [str(rel) for rel, _, _ in jobs[:8]], "options": options}
                with self.lock:
                    if generation == self.generation and not stop.is_set():
                        self.review = {"view": review, "jobs": jobs, "library": adapted,
                                       "context": context, "created": time.monotonic()}
            except Exception as error:
                with self.lock:
                    if generation == self.generation and not stop.is_set():
                        self.error = str(error) if isinstance(error, (engine.Fail, LibraryError)) else "Could not prepare the download."
            finally:
                with self.lock:
                    if generation == self.generation:
                        self.preparing = False
        threading.Thread(target=plan, daemon=True, name="tagcast-download-plan").start()
        return self.view(body.get("session"))

    def start(self, body):
        context = self._context(body.get("session"))
        with self.lock:
            self._bind(context)
            self._idle()
            review = self.review
            if not review or body.get("id") != review["view"]["id"] \
                    or context != review["context"] \
                    or time.monotonic() - review["created"] > REVIEW_LIFETIME:
                raise ConflictError("This review expired or the library changed. Prepare the download again.")
            self.review = None  # one explicit start per review, even when setup fails
            options = review["view"]["options"]
            out = Path(options["out"])
            try:
                out.mkdir(parents=True, exist_ok=True)
                if options["work"]:
                    engine.check_work_folder(options["work"], out)
                engine.write_private(self.studio.home / "download-options.json", json.dumps(options).encode())
            except (OSError, engine.Fail) as error:
                raise LibraryError(f"Could not use the download folders ({type(error).__name__}).") from None
            self.options = options
            transport = DownloadSession(self.studio, context)
            self.transport = transport
            transfer = engine.Transfer(transport, review["library"], review["jobs"], out,
                options["workers"], quality=options["quality"], source=options["source"],
                verify=options["verify"], locks=engine.lock_folder(self.studio.home),
                work=Path(options["work"]) if options["work"] else None, valid=transport.valid)
            self.transfer = transfer
            def run():
                try:
                    transfer.run()
                except Exception as error:
                    transfer._finish("Download task", "fail", 0,
                                     f"Task stopped ({type(error).__name__}). Completed files are kept.")
                    transfer.finished, transfer.state = time.time(), "done"
                finally:
                    transport.close()
                    # Keep compact results, not a second full library, after finishing.
                    transfer.jobs, transfer.futures = [], {}
                    transfer.lib = transfer.session = None
                    transport.context = None
            self.thread = threading.Thread(target=run, daemon=True, name="tagcast-downloads")
            self.thread.start()
        return self.view(body.get("session"))

    def cancel(self, body):
        context = self._context(body.get("session"))
        with self.lock:
            self._bind(context)
            self._cancel()
        return self.view(body.get("session"))

    def _cancel(self):
        self.stop.set()
        if self.transfer:
            self.transfer.cancel()
        if self.transport and not self.transport.cancelled.is_set():
            self.transport.cancelled.set()
            # Closing a requests reader may wait for its current read. Do not hold
            # the HTTP request, session lock or UI while the bounded read unwinds.
            threading.Thread(target=self.transport.close, daemon=True,
                             name="tagcast-download-close").start()

    def close(self):
        with self.lock:
            self._cancel()
            self.generation += 1
            self.preparing = False
            self.queue.clear()
            self.review = None
            self.owner = None

    def folder(self, body):
        context = self._context(body.get("session"))
        with self.lock:
            if self.picker:
                raise ConflictError("A folder chooser is already open.")
            self.picker = True
        try:
            folder = engine.choose_folder(self.options["out"])
            if self._context(body.get("session"))[0] is not context[0]:
                raise ConflictError("The connection changed.")
            return {"folder": folder, "unavailable": folder is None}
        finally:
            with self.lock:
                self.picker = False
