"""Optional server-side iBroadcast WebSocket bridge. No credentials cross the local API."""

import copy
import json
import math
import re
import threading
import time
from urllib.parse import quote

import certifi
import websocket

from . import __version__
from .collections import track_ids
from .library import LibraryError, number, text

QUEUE_SCOPES = ["user.queue:read", "user.queue:write"]


def clean_state(value):
    if not isinstance(value, dict):
        raise LibraryError("Choose a valid queue state.")
    data = value.get("data") or {}
    if not isinstance(data, dict):
        raise LibraryError("Choose valid queue playback settings.")
    tracks, next_tracks = track_ids(value.get("tracks", [])), track_ids(value.get("play_next", []))
    index = data.get("play_index", 0)
    if type(index) is not int or not 0 <= index <= len(tracks):
        raise LibraryError("Choose a valid queue position.")
    repeat, play_from = data.get("repeat_mode", "none"), data.get("play_from", "tracks")
    if repeat not in ("none", "queue", "track") or play_from not in ("tracks", "play_next"):
        raise LibraryError("Choose a supported repeat mode and queue.")
    song = value.get("current_song", 0)
    if type(song) not in (int, str) or not str(song).isdigit():
        raise LibraryError("Choose a valid current track.")
    out = {"tracks": tracks, "play_next": next_tracks, "current_song": int(song),
           "pause": value.get("pause") is not False, "shuffle": value.get("shuffle") is True,
           "name": text(value.get("name"))[:500],
           "data": {"play_index": index, "repeat_mode": repeat, "play_from": play_from,
                    "crossfade": data.get("crossfade") is True}}
    for key, default, maximum in (("volume", 0.8, 1), ("start_position", 0, 86400),
                                  ("start_time", time.time(), 1e12)):
        v = value.get(key, default)
        if type(v) not in (float, int) or not math.isfinite(v) or not 0 <= v <= maximum:
            raise LibraryError("Choose valid playback timing and volume.")
        out[key] = v
    return out


class QueueSync:
    def __init__(self, studio):
        self.studio = studio
        # Share the session lock: role transitions and OAuth replacement are atomic.
        self.lock = studio.lock
        self.send_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.socket = None
        self.owner = ""
        self.binding = ""
        self.own_session = self.target = ""
        self.revision = 0
        self.state = {}
        self.sessions = []
        self.status = "disconnected"
        self.error = ""
        self.library_changed = ""

    @staticmethod
    def clean_sessions(values):
        if not isinstance(values, list):
            return []
        return [{"id": text(v.get("session_uuid")),
                 "name": text(v.get("nickname") or v.get("device_name") or v.get("client"))[:200],
                 "joinable": v.get("joinable") in (True, 1, "1")}
                for v in values[:100] if isinstance(v, dict) and
                re.fullmatch(r"[A-Za-z0-9_-]{1,100}", text(v.get("session_uuid")))]

    def view(self):
        with self.lock:
            state = copy.deepcopy(self.state)
            library = self.studio.library if self.binding == self.studio.playback_session else None
            track = library.tracks.get(number(state.get("current_song"))) if library else None
            if track:
                state["name"] = text(track.get("title"))
            return {"authenticated": bool(self.studio.client), "status": self.status, "error": self.error, "revision": self.revision,
                    "owner": self.owner, "session": self.binding, "own": self.target == self.own_session,
                    "state": state, "devices": copy.deepcopy(self.sessions),
                    "library_changed": self.library_changed}

    def disconnect(self):
        self.stop_event.set()
        with self.lock:
            sock, self.socket = self.socket, None
            self.status = "disconnected"
            self.owner = self.binding = ""
            self.state = {}
            self.sessions = []
            self.revision += 1
        if sock:
            try:
                sock.close()
            except Exception:
                pass

    def check_owner(self, body):
        if body.get("session") != self.studio.playback_session or not self.studio.client:
            raise LibraryError("The iBroadcast connection changed. Open Devices again.")
        if self.studio.config.get("queue_sync") is not True:
            raise LibraryError("Enable queue synchronisation in Settings first.")
        owner = body.get("browser")
        if not isinstance(owner, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", owner):
            raise LibraryError("Choose a valid browser session.")
        if self.binding == self.studio.playback_session and self.owner and owner != self.owner and not (body.get("action") == "disconnect" and body.get("force") is True):
            raise LibraryError("Another browser tab owns the queue connection. Disconnect it there first.")
        return owner

    def action(self, body):
        with self.lock:
            owner = self.check_owner(body)
            action = body.get("action")
            if action == "disconnect":
                self.disconnect()
                return self.view()
            if action == "connect":
                client = self.studio._require_client()
                scopes = getattr(getattr(client, "token_set", None), "scope", [])
                if not set(QUEUE_SCOPES).issubset(scopes):
                    raise LibraryError("Reconnect iBroadcast to approve the queue read/write permissions.")
                status = client._jsonrequest("status")
                session = status.get("user", {}).get("session", {})
                own = text(session.get("session_uuid"))
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", own):
                    raise LibraryError("iBroadcast did not return this app's session ID.")
                sessions = self.clean_sessions(session.get("sessions", []))
                target = body.get("target") or own
                if target != own and not any(s["id"] == target and s["joinable"] for s in sessions):
                    raise LibraryError("Choose an available device belonging to this account.")
                self.disconnect()
                self.stop_event = threading.Event()
                self.owner, self.binding = owner, self.studio.playback_session
                self.own_session, self.target, self.sessions = own, target, sessions
                self.status, self.error = "connecting", ""
                threading.Thread(target=self.run, args=(client, self.stop_event, self.binding), daemon=True).start()
                return self.view()
            if action != "state" or self.status != "connected" or not self.socket:
                raise LibraryError("Connect a queue before sending playback commands.")
            if body.get("revision") != self.revision:
                raise LibraryError("The device changed its queue. Refresh before sending this command.")
            value = clean_state(body.get("state"))
            # A remote controller cannot claim the player role; only the server assigns roles.
            if self.target == self.own_session:
                library, _ = self.studio._library()
                for i in set(value["tracks"] + value["play_next"]):
                    library.active_track_album(i)
            role = self.state.get("role", "controller")
            try:
                self.send("set_state", value)
            except Exception:
                raise LibraryError("Queue command could not be confirmed. Refresh the device before trying again.") from None
            self.state = {**value, "role": role}
            self.revision += 1
            return self.view()

    def send(self, command, value=None):
        payload = {"session_uuid": self.target, "client": "tagcast", "version": __version__,
                   "device_name": "Tagcast", "local_addr": "", "command": command}
        if value is not None:
            payload["value"] = value
        with self.send_lock:
            self.socket.send(json.dumps(payload))

    def receive(self, message):
        with self.lock:
            if message.get("result") is False:
                raise LibraryError("iBroadcast refused the queue connection.")
            command = message.get("command")
            if command == "set_state":
                value = clean_state(message.get("value", message))
                self.state = {**value, "role": "player" if message.get("role") == "player" else "controller"}
            elif command == "sessions":
                self.sessions = self.clean_sessions(message.get("value"))
            elif command == "update_library":
                self.library_changed = text(message.get("lastmodified"))[:100]
            elif command == "end_session":
                self.disconnect()
                self.studio._disconnect()
                return
            else:
                return
            self.revision += 1

    def run(self, client, stop, binding):
        while not stop.is_set() and client is self.studio.client and binding == self.studio.playback_session:
            sock = None
            try:
                token = client._jsonrequest("playqueue_token").get("token")
                if not isinstance(token, str) or not token:
                    raise LibraryError("iBroadcast returned no queue token.")
                # Fixed TLS endpoint; never log its one-use token or relay it to the browser.
                sock = websocket.create_connection("wss://queue.ibroadcast.com/ws?token=" + quote(token, safe=""), timeout=15,
                                                   sslopt={"ca_certs": certifi.where()})
                sock.settimeout(1)
                with self.lock:
                    if stop.is_set():
                        break
                    self.socket, self.status, self.error = sock, "connected", ""
                    self.revision += 1
                    self.send("get_state")
                ping_at = time.monotonic()
                while not stop.is_set():
                    try:
                        raw = sock.recv()
                        if not raw:
                            break
                        if len(raw) > 2_000_000:
                            raise LibraryError("Queue response is too large.")
                        if not stop.is_set() and stop is self.stop_event:
                            self.receive(json.loads(raw))
                    except websocket.WebSocketTimeoutException:
                        pass
                    if time.monotonic() - ping_at > 30:
                        sock.ping()
                        ping_at = time.monotonic()
            except Exception as failure:
                from .client import NotConnected
                if isinstance(failure, NotConnected) and client is self.studio.client:
                    self.studio._disconnect()
                # Exceptions from WebSocket libraries can include the URL/token.
                with self.lock:
                    if not stop.is_set():
                        self.error = "Queue connection interrupted. Reconnecting in five seconds."
            finally:
                if sock:
                    sock.close()
                with self.lock:
                    if not stop.is_set():
                        self.socket, self.status = None, "reconnecting"
                        self.revision += 1
            if stop.wait(5):
                break
