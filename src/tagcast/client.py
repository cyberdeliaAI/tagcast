"""iBroadcast account connection: OAuth, token storage, library download and saving.

Built on the ``ibroadcast`` package (https://github.com/ctrueden/ibroadcast-python)
for OAuth (device code and PKCE authorization code flows) and token handling.
"""

import gzip
import json
import logging
import math
import os
import re
import secrets
import shutil
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path

import ibroadcast
import requests
from ibroadcast import oauth

from . import __version__, artwork, auth
from .album_guide import AlbumGuide
from .album_info import AlbumInformation
from .album_merge import AlbumMerge
from .artist_bios import ArtistBiographies
from .cleanup import Cleanup
from .collections import Collections
from .downloads import AudioDownloads
from .duplicate_cleanup import DuplicateCleanup
from .library import (
    ConflictError,
    Library,
    LibraryError,
    number,
    patch_artist_names,
    plan_save,
    text,
    verify,
    write_requests,
)
from .lyrics import Lyrics
from .metadata_export import MetadataExport
from .playlist_import import PlaylistImport
from .queue_sync import QUEUE_SCOPES, QueueSync
from .service_status import ServiceStatus
from .sources import KEYS as SOURCE_KEYS
from .sources import Lookup
from .tags import Tags
from .updates import UpdateChecker
from .year_review import YearReview

log = logging.getLogger("tagcast")

SCOPES = ["user.library:read", "user.library:write", "user.account:read"]
# Public OAuth identifier; device-code sign-in never uses a client secret.
DEFAULT_CLIENT_ID = "5d8e2ee2bfee11f1b50eb49691aa2236"
CLIENT_NAME = "tagcast"
TIMEOUT = 120
COMBINE_SETS_MESSAGE = ("“Combine Multi-Disc Album Sets” is on in your iBroadcast settings, and "
                        "iBroadcast doesn't accept album changes (title, album artist, year, disc) "
                        "while it is. Turn it off in iBroadcast, save the album changes, then turn "
                        "it back on.")
RETRY_DELAYS = (2, 6)  # seconds before the 2nd and 3rd attempt after a temporary failure
MAX_TRASH = 500  # tracks per trash request
RETRY_READS = {"library", "status", "get_artwork", "gettrackuserdata"}
CACHE_FILE = "library-cache.json.gz"
KEY_ENV = {"lastfm_api_key": "LASTFM_API_KEY", "discogs_token": "DISCOGS_TOKEN",
           "fanart_api_key": "FANART_API_KEY"}

API_URL = "https://api.ibroadcast.com"
LIBRARY_URL = "https://library.ibroadcast.com"
ARTWORK_UPLOAD_URL = "https://artwork-upload.ibroadcast.com"
AUDIO_DOWNLOAD_URL = "https://download.ibroadcast.com/"
STREAM_URL = "https://streaming.ibroadcast.com"

# Point everything at a test server, e.g. TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9000
_test_base = os.environ.get("TAGCAST_IBROADCAST_BASE", "").rstrip("/")
if _test_base:
    API_URL, LIBRARY_URL = f"{_test_base}/api", f"{_test_base}/library"
    ARTWORK_UPLOAD_URL, STREAM_URL = f"{_test_base}/artwork-upload", f"{_test_base}/stream"
    AUDIO_DOWNLOAD_URL = f"{_test_base}/download"
    oauth.OAUTH_BASE = f"{_test_base}/oauth"
    oauth.AUTHORIZE_URL = f"{oauth.OAUTH_BASE}/authorize"
    oauth.TOKEN_URL = f"{oauth.OAUTH_BASE}/token"
    oauth.DEVICE_CODE_URL = f"{oauth.OAUTH_BASE}/device/code"
    oauth.REVOKE_URL = f"{oauth.OAUTH_BASE}/revoke"


def mask_email(value):
    name, at, domain = str(value or "").partition("@")
    if not at:
        return ""
    return f"{name[:1]}•••••@{domain}"  # the same length for every name


def account_view(data):
    """The account details worth showing. Leaves out tokens, payment details, IP addresses,
    sessions and messages."""
    def section(key):
        value = data.get(key)
        return value if isinstance(value, dict) else {}
    user, status, lastfm = section("user"), section("status"), section("lastfm")
    prefs = user.get("preferences") if isinstance(user.get("preferences"), dict) else {}
    profiles = user.get("profiles") if isinstance(user.get("profiles"), list) else []
    profile = profiles[0].get("settings", {}) if profiles and isinstance(profiles[0], dict) else {}
    sub = user.get("subscription") if isinstance(user.get("subscription"), dict) else {}
    plan = sub.get("plan") if isinstance(sub.get("plan"), dict) else {}

    def flag(value):
        return str(value) in ("1", "True", "true")

    return {
        "username": text(user.get("username")),
        "email": mask_email(user.get("email_address")),
        "verified": bool(user.get("verified")),
        "verified_on": text(user.get("verified_on"))[:10],
        "premium": user.get("premium") in (True, 1, "1"),
        "tester": bool(user.get("tester")),
        "subscription": {"name": text(plan.get("name") or sub.get("display_title")),
                         "frequency": text(plan.get("frequency")),
                         "started_on": text(sub.get("started_on"))[:10],
                         "renews_on": text(sub.get("due_on"))[:10],
                         "canceled": bool(sub.get("canceled")), "expired": bool(sub.get("expired"))}
        if sub else None,
        "plays": number(status.get("plays")),
        "tracks": number(status.get("available")),
        "achievements": len(status.get("achievement_status") or {}),
        "lastmodified": text(status.get("lastmodified")),
        "preferences": {
            "bitrate": text(prefs.get("bitratepref") or profile.get("bitratepref")),
            "one_queue": flag(prefs.get("onequeue")),
            "combine_sets": flag(prefs.get("combine_sets")),
            "artist_images": profile.get("artistimages") if "artistimages" in profile else None,
            "replay_gain": profile.get("replaygain") if "replaygain" in profile else None,
        },
        "linked": {"lastfm": text(lastfm.get("user")) if lastfm.get("linked") else "",
                   "dropbox": bool(section("dropbox").get("linked")),
                   "googledrive": bool(section("googledrive").get("linked"))},
    }


class ApiError(Exception):
    pass


class NotConnected(ApiError):
    pass


class UncertainWrite(ApiError):
    """A request may have been applied; never resend it without a fresh review."""


class StudioClient(ibroadcast.iBroadcast):
    """iBroadcast client that keeps server messages and refreshes tokens up front."""

    def __init__(self, **kwargs):
        super().__init__(client=CLIENT_NAME, version=__version__,
                         device_name="Tagcast", log=log, **kwargs)
        self._refresh_lock = threading.Lock()
        self._refreshing = None
        self._token_generation = 0

    def _post(self, url, args, retry=True, access_token=None):
        """Retry only known reads. Even setting the same value can overwrite a later edit.

        An explicit authentication rejection is handled separately by _jsonrequest.
        Unknown modes and status requests carrying play history are send-once writes.
        """
        read = args.get("mode") in RETRY_READS and "history" not in args
        retry = retry and read
        for attempt, delay in enumerate((0, *RETRY_DELAYS) if retry else (0,)):
            time.sleep(delay)
            last = attempt == (len(RETRY_DELAYS) if retry else 0)
            headers = self._auth_headers()
            if access_token is not None:
                headers["Authorization"] = f"Bearer {access_token}"
            try:
                response = requests.post(url, data=json.dumps(args), headers=headers,
                                         timeout=TIMEOUT if url == LIBRARY_URL else 45)
            except requests.RequestException as error:
                log.warning("%s: %s (attempt %d)", args.get("mode", "library"),
                            error.__class__.__name__, attempt + 1)
                if last:
                    failure = ApiError if read else UncertainWrite
                    raise failure(f"Could not confirm iBroadcast's response ({error.__class__.__name__}).") from None
                continue
            try:
                data = response.json()
            except ValueError:
                data = {}
            if not isinstance(data, dict):
                data = {}
            if (response.status_code == 429 or response.status_code >= 500) and not last:
                log.warning("%s: HTTP %d (attempt %d)", args.get("mode", "library"),
                            response.status_code, attempt + 1)
                continue
            if response.status_code == 401:
                data.setdefault("authenticated", False)
            elif not response.ok:
                if not read and (response.status_code == 429 or response.status_code >= 500):
                    raise UncertainWrite(f"iBroadcast returned HTTP {response.status_code}; the write may have been applied.")
                raise ApiError(data.get("message") or f"iBroadcast returned HTTP {response.status_code}.")
            if not data:
                failure = ApiError if read else UncertainWrite
                raise failure("iBroadcast returned no usable confirmation.")
            return data
        raise ApiError("iBroadcast did not answer.")

    def _jsonrequest(self, mode, url=None, _retry=True, **kwargs):
        access_token, generation = self._request_token()
        url = url or f"{API_URL}/{mode}"
        args = self._request_body(mode, **kwargs)
        data = self._post(url, args, retry=_retry, access_token=access_token)
        if data.get("authenticated") is False:
            if not (self._refresh_token and self._client_id):
                raise NotConnected("Your iBroadcast session expired. Connect again.")
            self._refresh_or_fail(generation)
            access_token, _ = self._token_snapshot()
            data = self._post(url, args, retry=_retry, access_token=access_token)
            if data.get("authenticated") is False:
                raise NotConnected("iBroadcast did not accept the session. Connect again.")
        if data.get("result") is False:
            raise ApiError(data.get("message") or f"iBroadcast rejected {mode}.")
        return data

    def _token_snapshot(self):
        with self._refresh_lock:
            return self._access_token, self._token_generation

    def _request_token(self):
        with self._refresh_lock:
            generation = self._token_generation
            token_set = getattr(self, "token_set", None)
            expired = token_set and token_set.is_expired and self._refresh_token and self._client_id
        if expired:
            self._refresh_or_fail(generation, expired_only=True)
        return self._token_snapshot()

    def _refresh_or_fail(self, generation=None, *, expired_only=False):
        try:
            self._refresh(generation, expired_only=expired_only)
        except (oauth.OAuthError, requests.RequestException, KeyError, ValueError):
            raise NotConnected("Your iBroadcast session expired. Connect again.") from None

    def _refresh(self, generation=None, *, expired_only=False):
        """Share an in-flight refresh; late failures must not rotate a newer token."""
        with self._refresh_lock:
            if generation is not None and generation != self._token_generation:
                return
            token_set = getattr(self, "token_set", None)
            if expired_only and token_set and not token_set.is_expired:
                return
            pending = self._refreshing
            leader = pending is None
            if leader:
                pending = self._refreshing = Future()
                refresh_token = self._refresh_token
        if not leader:
            pending.result()
            return
        try:
            token_set = auth.refresh_access_token(self._client_id, refresh_token)
        except BaseException as error:
            # Wake waiting requests even if this worker is interrupted.
            with self._refresh_lock:
                self._refreshing = None
                pending.set_exception(error)
            raise
        with self._refresh_lock:
            self._access_token = token_set.access_token
            self._refresh_token = token_set.refresh_token
            self.token_set = token_set
            self._token_generation += 1
            self._refreshing = None
            pending.set_result(token_set)
        # A queue request can hold Studio.lock while waiting for this refresh.
        # Never hold the gate or keep waiters blocked while persisting tokens.
        if self._token_refreshed_callback:
            self._token_refreshed_callback(token_set)

    def fetch_library(self):
        return Library(self._jsonrequest("library", url=LIBRARY_URL))

    def _with_fresh_token(self, send):
        """Run send() and retry once with a refreshed token if iBroadcast refuses it."""
        access_token, generation = self._request_token()
        response = send(access_token)
        if response.status_code in (401, 403) and self._refresh_token and self._client_id:
            response.close()
            self._refresh_or_fail(generation)
            access_token, _ = self._token_snapshot()
            response = send(access_token)
        return response

    def upload_artwork(self, data, filename, mime, user_id):
        """Store an image in iBroadcast's artwork library and return its artwork ID.

        Mirrors the web editor's upload (artwork-upload.ibroadcast.com, field
        uploaded_file) without an album or artist, so applying it stays a separate,
        checked step (set_artwork / set_artist_artwork).
        """
        def send(access_token):
            return requests.post(
                ARTWORK_UPLOAD_URL, timeout=TIMEOUT,
                headers={"Authorization": f"Bearer {access_token}",
                         "User-Agent": self._user_agent},
                data={"client": self._client, "version": self._version,
                      "device_name": self._device_name, "user_id": user_id},
                files={"uploaded_file": (filename, data, mime)})
        try:
            response = self._with_fresh_token(send)
        except requests.RequestException as error:
            raise ApiError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None
        try:
            result = response.json()
        except ValueError:
            result = {}
        if not response.ok or result.get("result") is False or not number(result.get("artwork_id")):
            raise ApiError(result.get("message")
                           or f"iBroadcast did not accept the image (HTTP {response.status_code}).")
        return number(result["artwork_id"])

    def open_download(self, track_id, user_id):
        """Read one original file from the official download service (streamed ZIP)."""
        def send(access_token):
            response = requests.post(AUDIO_DOWNLOAD_URL,
                data={"_user_id": str(user_id), "_token": access_token,
                      "mode": "downloadlibrary", "container_type": "track",
                      "ids": str(track_id), "end_marker": "1"},
                headers={"User-Agent": self._user_agent},
                stream=True, allow_redirects=False, timeout=(10, 30))
            content_type = response.headers.get("Content-Type", "").lower()
            if response.status_code == 200 and ("json" in content_type or content_type.startswith("text/")):
                try:
                    answer = json.loads(response.raw.read(4096, decode_content=True))
                except (ValueError, UnicodeError):
                    answer = {}
                # This service can reject a token in JSON with HTTP 200. Normalize
                # only that explicit rejection for the existing shared refresh gate.
                if isinstance(answer, dict) and answer.get("authenticated") is False:
                    response.status_code = 401
            return response
        try:
            return self._with_fresh_token(send)
        except requests.RequestException as error:
            raise ApiError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None

    def open_stream(self, path, file_id, user_id, expires, range_header=None, *, timeout=TIMEOUT):
        """Open the audio of one track. The caller closes the returned response."""
        def send(access_token):
            params = {"Signature": access_token, "file_id": file_id, "user_id": user_id,
                      "platform": self._client, "version": self._version}
            if expires:
                params["Expires"] = expires
            headers = {"User-Agent": self._user_agent}
            if range_header:
                headers["Range"] = range_header
            return requests.get(STREAM_URL + path, params=params, headers=headers,
                                stream=True, timeout=timeout)
        try:
            return self._with_fresh_token(send)
        except requests.RequestException as error:
            raise ApiError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None


class Studio:
    """Holds the connection state for the local server. Thread safe."""

    @staticmethod
    def default_home():
        if os.environ.get("TAGCAST_HOME"):
            return Path(os.environ["TAGCAST_HOME"])
        home, legacy = Path.home() / ".tagcast", Path.home() / ".library-studio"
        if not home.exists() and legacy.is_dir():  # settings from before the rename
            try:
                shutil.copytree(legacy, home, ignore=shutil.ignore_patterns("*.log*", "*.tmp"))
            except OSError as error:
                log.warning("Could not copy settings from %s: %s", legacy, error)
        return home

    def __init__(self, home=None):
        self.home = Path(home) if home else self.default_home()
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.play_lock = threading.Lock()
        self.play_events = {}
        self.playback_session = ""
        self.client = None
        self.library = None
        self.library_user = None
        self.premium = False
        self.collections = Collections(self)
        self.playlist_import = PlaylistImport(self)
        self.metadata_export = MetadataExport(self)
        self.audio_downloads = AudioDownloads(self)
        self.lyrics = Lyrics(self)
        self.tags = Tags(self)
        self.album_merge = AlbumMerge(self)
        self.queue_sync = QueueSync(self)
        self.combine_sets = False  # iBroadcast refuses update_album while this setting is on
        self.downloads = 0  # library downloads started so far; numbers each one
        self.library_started = 0  # the number of the download the copy in memory came from
        self.account = None
        self.cache_lock = threading.Lock()
        self.download_lock = threading.Lock()  # one full library download at a time
        self.jobs = {}  # background read-backs after a save, by job ID
        self.device = None
        self._device_gen = 0
        self._pkce = {}
        self._pkce_gen = 0
        self.config = self._read("config.json") or {}
        self.album_guide = AlbumGuide(self)
        self.updates = UpdateChecker(self._read, self._write)
        self.service_status = ServiceStatus()
        self.lookup = Lookup(self.source_keys, self.disabled_sources)
        self.artist_bios = ArtistBiographies(self)
        self.album_info = AlbumInformation(self)
        self.cleanup = Cleanup(self)
        self.duplicate_cleanup = DuplicateCleanup(self)
        self.year_review = YearReview(self)
        tokens = self._read("tokens.json")
        if tokens and tokens.get("client_id") == self.client_id and tokens.get("token_set"):
            try:
                self._connect(oauth.TokenSet.from_dict(tokens["token_set"]), save=False)
            except (KeyError, TypeError):
                pass

    # -- storage -------------------------------------------------------------

    def _read(self, name):
        try:
            return json.loads((self.home / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _write(self, name, data):
        self._write_bytes(name, json.dumps(data, indent=2).encode())

    def _write_bytes(self, name, data):
        self.home.mkdir(parents=True, exist_ok=True)
        path = self.home / name
        tmp = path.with_name(path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)

    def _read_cache(self, user_id, lastmodified):
        try:
            data = json.loads(gzip.decompress((self.home / CACHE_FILE).read_bytes()))
            if data.get("user_id") != user_id or data.get("status", {}).get("lastmodified") != lastmodified \
                    or data.get("combine_sets") != self.combine_sets:
                return None
            return Library(data)
        except (OSError, ValueError, AttributeError, EOFError, LibraryError):
            return None

    def _write_cache(self, library, user_id, client):
        """Write the library to disk in the background; a failed write only costs a download."""
        def write():
            with self.cache_lock:
                if client is not self.client:  # disconnected before the write started
                    return
                try:
                    data = {"user_id": user_id, **library.to_cache()}
                    self._write_bytes(CACHE_FILE, gzip.compress(
                        json.dumps(data, separators=(",", ":")).encode(), compresslevel=5))
                except (OSError, ValueError) as error:
                    log.warning("Could not write the library cache: %s", error)
        threading.Thread(target=write, daemon=True).start()

    def _forget_cache(self):
        with self.cache_lock:
            try:
                (self.home / CACHE_FILE).unlink()
            except OSError:
                pass

    @property
    def client_id(self):
        return (os.environ.get("IBROADCAST_CLIENT_ID") or self.config.get("client_id")
                or DEFAULT_CLIENT_ID)

    @property
    def scopes(self):
        return SCOPES + (QUEUE_SCOPES if self.config.get("queue_sync") is True else [])

    def set_client_id(self, client_id):
        client_id = str(client_id or "").strip()
        if not client_id or len(client_id) > 200 or any(c.isspace() for c in client_id):
            raise ApiError("Enter the client ID of your iBroadcast app.")
        with self.lock:
            if client_id != self.client_id:
                self._disconnect()
            self.config["client_id"] = client_id
            self._write("config.json", self.config)

    def use_default_client(self):
        """Switch explicitly after disconnecting; never migrate an existing session."""
        with self.lock:
            if os.environ.get("IBROADCAST_CLIENT_ID"):
                raise ApiError("The client ID is set by IBROADCAST_CLIENT_ID. Remove that override and restart to use Tagcast sign-in.")
            if self.client:
                raise ApiError("Disconnect before switching to Tagcast sign-in.")
            if self.client_id != DEFAULT_CLIENT_ID:
                self._disconnect()
            self.config.pop("client_id", None)
            self._write("config.json", self.config)

    # -- connection ----------------------------------------------------------

    def _save_tokens(self, token_set, client):
        with self.lock:
            if client is self.client and token_set is client.token_set:
                self._write("tokens.json", {"client_id": self.client_id,
                                            "token_set": token_set.to_dict()})

    def _connect(self, token_set, save=True):
        self.audio_downloads.close()
        self.queue_sync.disconnect()
        client = StudioClient(access_token=token_set.access_token,
                              refresh_token=token_set.refresh_token,
                              client_id=self.client_id,
                              token_refreshed_callback=lambda tokens: self._save_tokens(tokens, client))
        client.token_set = token_set
        with self.lock:
            self.client, self.library, self.account = client, None, None
            self.playback_session = secrets.token_hex(16)
            if save:
                self._save_tokens(token_set, client)

    def _disconnect(self):
        self.audio_downloads.close()
        self.queue_sync.disconnect()
        with self.lock:
            self.client = self.library = self.account = self.device = None
            self.playback_session = ""
            self._device_gen += 1
            self._pkce.clear()
            self._pkce_gen += 1
            try:
                (self.home / "tokens.json").unlink()
            except OSError:
                pass

    def status(self):
        with self.lock:
            device = dict(self.device) if self.device else None
            client = self.client
        if client and self.account is None:
            self.account = self._account_name(client)
        return {
            "configured": bool(self.client_id),
            "client_id_from_env": bool(os.environ.get("IBROADCAST_CLIENT_ID")),
            "using_default_client": self.client_id == DEFAULT_CLIENT_ID,
            "connected": bool(client),
            "combine_sets": self.combine_sets,
            "premium": self.premium,
            "account": self.account or "",
            "device": device,
            "scopes": self.scopes,
            "playback_session": self.playback_session if client else "",
        }

    def _account_name(self, client):
        try:
            data = client._jsonrequest("status")
        except NotConnected:
            self._disconnect()
            return None
        except ApiError:
            return ""
        user = data.get("user") if isinstance(data.get("user"), dict) else {}
        self.premium = user.get("premium") in (True, 1, "1")
        return str(user.get("username") or user.get("email") or "")

    def start_device(self):
        if not self.client_id:
            raise ApiError("Enter your app's client ID first.")
        with self.lock:
            self._device_gen += 1
            gen, client_id = self._device_gen, self.client_id
        try:
            code = auth.device_code_request(client_id, self.scopes)
        except (oauth.OAuthError, requests.RequestException, ValueError) as error:
            raise ApiError(f"iBroadcast did not start the sign-in: {error}") from None
        if "device_code" not in code or "user_code" not in code:
            raise ApiError("iBroadcast returned an unexpected sign-in response.")
        with self.lock:
            if gen != self._device_gen:
                raise ApiError("This sign-in was canceled. Try again.")
            self.device = {
                "state": "pending",
                "user_code": code["user_code"],
                "verification_uri": code.get("verification_uri", "https://oauth.ibroadcast.com/device"),
                "verification_uri_complete": code.get("verification_uri_complete", ""),
                "expires_at": time.time() + number(code.get("expires_in") or 600),
                "error": "",
            }
        threading.Thread(target=self._poll, args=(gen, code["device_code"],
                                                  number(code.get("interval")) or 5),
                         daemon=True).start()
        return dict(self.device)

    def _poll(self, gen, device_code, interval):
        try:
            token_set = auth.poll_for_token(self.client_id, device_code, interval)
        except Exception as error:  # report any failure to the browser
            with self.lock:
                if gen == self._device_gen and self.device:
                    self.device.update(state="error", error=str(error) or "Sign-in failed.")
            return
        with self.lock:
            if gen != self._device_gen:
                return
            self._connect(token_set)
            self.device = {"state": "done"}

    def cancel_device(self):
        with self.lock:
            self._device_gen += 1
            self.device = None

    def browser_url(self, redirect_uri):
        if not self.client_id:
            raise ApiError("Enter your app's client ID first.")
        state = secrets.token_urlsafe(24)
        verifier = oauth.generate_code_verifier()
        with self.lock:
            self._pkce_gen += 1
            self._pkce = {state: (verifier, redirect_uri, time.time(), self._pkce_gen)}
        return oauth.build_authorize_url(self.client_id, state,
                                         oauth.generate_code_challenge(verifier),
                                         self.scopes, redirect_uri)

    def finish_browser(self, code, state):
        with self.lock:
            entry = self._pkce.pop(state, None)
            client_id = self.client_id
        if not entry or time.time() - entry[2] > 900:
            raise ApiError("This sign-in link expired or was not started here. Try again.")
        try:
            token_set = auth.exchange_auth_code(client_id, code, entry[1], entry[0])
        except (oauth.OAuthError, requests.RequestException, KeyError, ValueError) as error:
            raise ApiError(f"iBroadcast did not complete the sign-in: {error}") from None
        with self.lock:
            if entry[3] != self._pkce_gen:
                raise ApiError("This sign-in was canceled. Try again.")
            self._connect(token_set)

    def logout(self):
        with self.lock:
            client = self.client
            client_id = self.client_id
            self._disconnect()
        self._forget_cache()
        if client and client._refresh_token:
            try:
                auth.revoke_token(client_id, client._refresh_token)
            except Exception:  # still forget the tokens locally
                pass

    # -- library -------------------------------------------------------------

    def _require_client(self):
        with self.lock:
            if not self.client:
                raise NotConnected("Connect your iBroadcast account first.")
            return self.client

    def _fetch(self, client):
        try:
            return client.fetch_library()
        except NotConnected:
            self._disconnect()
            raise

    def _remote_state(self, client):
        """Ask iBroadcast (cheaply) when the library last changed, and for whom."""
        try:
            data = client._jsonrequest("status")
        except NotConnected:
            self._disconnect()
            raise
        user = data.get("user") if isinstance(data.get("user"), dict) else {}
        status = data.get("status") if isinstance(data.get("status"), dict) else {}
        prefs = user.get("preferences") if isinstance(user.get("preferences"), dict) else {}
        self.premium = user.get("premium") in (True, 1, "1")
        self.combine_sets = text(prefs.get("combine_sets")) in ("1", "true", "True")
        return text(status.get("lastmodified")), text(user.get("id") or user.get("user_id"))

    def _keep(self, library, user_id, started, client):
        """Keep a download, unless the session it belongs to ended meanwhile (Disconnect)."""
        with self.lock:
            if client is not self.client:
                return False
            self.library, self.library_user, self.library_started = library, user_id, started
        self._write_cache(library, user_id, client)
        return True

    def _current(self, client, refresh=False, after=None):
        """The library as iBroadcast has it now. Downloads only when it changed since our copy.

        iBroadcast has no partial library download, but its status call reports
        "lastmodified", which changes with every library edit (the web player relies on
        the same signal). Returns (library, source) with source memory, cache or download.

        refresh skips that check. after=<download number> also skips it, but accepts a
        download that started after that one, so a read-back can share a download.
        (Numbers, not times: on Windows the clock ticks only every ~15 ms.)
        """
        lastmodified, user_id = self._remote_state(client)
        if lastmodified and not refresh and after is None:  # a read-back always reads fresh data
            if library := self._in_memory(user_id, lastmodified):
                return library, "memory"
            if library := self._read_cache(user_id, lastmodified):
                with self.lock:
                    if client is not self.client:
                        raise NotConnected("You disconnected from iBroadcast.")
                    self.library, self.library_user = library, user_id
                return library, "cache"
        with self.download_lock:
            # a download that finished while we waited (e.g. a read-back) may be current
            if lastmodified and not refresh and after is None \
                    and (library := self._in_memory(user_id, lastmodified)):
                return library, "memory"
            with self.lock:
                if after is not None and self.library and self.library_user == user_id \
                        and self.library_started > after:
                    return self.library, "memory"
            with self.lock:
                self.downloads += 1
                started = self.downloads
            library = self._fetch(client)
            library.combine_sets = self.combine_sets  # as read by _remote_state just before
            if not self._keep(library, user_id, started, client):
                raise NotConnected("You disconnected from iBroadcast.")
        return library, "download"

    def _in_memory(self, user_id, lastmodified):
        with self.lock:
            library, owner = self.library, self.library_user
        if library and owner == user_id and library.lastmodified == lastmodified \
                and library.combine_sets == self.combine_sets:
            return library
        return None

    def account_settings(self):
        """iBroadcast settings that change what can be saved, checked now."""
        self._remote_state(self._require_client())
        return {"combine_sets": self.combine_sets}

    def load_library(self, refresh=False):
        library, source = self._current(self._require_client(), refresh)
        albums = library.album_index()
        try:
            favourites = self.collections.album_favourites(library)
        except LibraryError as error:
            favourites = {"albums": None, "error": str(error)}
        try:
            artist_favourites = self.collections.artist_favourites(
                library, {entry["id"] for a in albums for entry in a["album_artists"] if entry["id"] != "0"})
        except LibraryError as error:
            artist_favourites = {"artists": None, "error": str(error)}
        return {"albums": albums, "artists": library.artist_names(),
                "editor_names": library.editor_names(),
                "album_favourites": favourites,
                "artist_favourites": artist_favourites,
                "favourites_count": library.favourites()["count"], "premium": self.premium,
                "source": source, "lastmodified": library.lastmodified,
                "combine_sets": self.combine_sets}

    def album_details(self, ids):
        with self.lock:
            library = self.library
        if library is None:
            library, _ = self._current(self._require_client())
        if not ids or len(ids) > 500:
            raise ApiError("Choose between 1 and 500 albums.")
        return [library.album_view(number(i)) for i in ids]

    def search_tracks(self, query):
        query = str(query or "").strip()
        if len(query) > 200:
            raise ApiError("Use a shorter search.")
        with self.lock:
            library = self.library
        if library is None:
            library, _ = self._current(self._require_client())
        return library.search_tracks(query)

    def favourites(self, query="", offset="0", limit="50"):
        query = str(query or "").strip()
        try:
            offset, limit = int(offset), int(limit)
        except (TypeError, ValueError):
            raise ApiError("Choose a valid favourites page.") from None
        if len(query) > 200 or offset < 0 or limit not in (50, 100, 200):
            raise ApiError("Choose a valid favourites page and a search of at most 200 characters.")
        library, _ = self._current(self._require_client())
        return library.favourites(query, offset, limit)

    def recently_played(self, query="", offset="0", limit="50", refresh=False):
        query = str(query or "").strip()
        try:
            offset, limit = int(offset), int(limit)
        except (TypeError, ValueError):
            raise ApiError("Choose a valid recently played page.") from None
        if len(query) > 200 or offset < 0 or limit not in (50, 100, 200):
            raise ApiError("Choose a valid page and a search of at most 200 characters.")
        with self.lock:
            if self.config.get("record_plays") is not True:
                return {"enabled": False, "available": False, "tracks": [], "total": 0}
        client = self._require_client()
        library, _ = self._current(client, refresh=refresh)
        if not library.recent_loaded:
            library, _ = self._current(client, refresh=True)
        with self.lock:
            if client is not self.client:
                raise NotConnected("You disconnected from iBroadcast.")
            if self.config.get("record_plays") is not True:
                return {"enabled": False, "available": False, "tracks": [], "total": 0}
        return {"enabled": True, **library.recently_played(query, offset, limit)}

    def browse(self, kind, key=None, query="", offset="0", limit="50", sort="az"):
        query = str(query or "").strip()
        try:
            offset, limit = int(offset), int(limit)
        except (TypeError, ValueError):
            raise ApiError("Choose a valid browse page.") from None
        uploads = kind in ("upload-folders", "uploaded")
        if kind not in ("track-artists", "composers", "genres", "years", "decades", "tags", "upload-folders", "uploaded") \
                or sort not in (("az", "za", "album") if uploads and key is not None else ("az", "za", "count")) \
                or len(query) > 200 or offset < 0 or limit not in (24, 50, 100, 200) \
                or (key is not None and (not isinstance(key, str) or len(key) > 500)):
            raise ApiError("Choose a valid group, page and a search of at most 200 characters.")
        if uploads:
            client = self._require_client()
            with self.lock:
                library = self.library
                if client is not self.client or library is None or self.library_user is None:
                    raise ApiError("Load the library before browsing uploads.")
                owner = self.library_user, self.playback_session
            result = library.browse(kind, key, query, offset, limit, sort)
            with self.lock:
                if client is not self.client or library is not self.library \
                        or owner != (self.library_user, self.playback_session):
                    raise ConflictError("The library changed. Open the upload group again.")
            return result
        library, _ = self._current(self._require_client())
        if kind == "tags" and not library.tags_loaded:
            _, library = self.tags.library()
        return library.browse(kind, key, query, offset, limit, sort)

    def record_play(self, body):
        """Send one opted-in play, using cached membership and no ambiguous retries.

        The documented history API adds counts, unlike metadata setters. Keep each
        event's outcome for this connection so repeated local requests cannot add it
        again. A new connection gets a different playback session; old pages cannot
        send their events to another account. No whole-library read-back per play.
        """
        track_id, event_id = body.get("track_id"), body.get("event_id")
        session, stamp, listened = body.get("session"), body.get("played_at"), body.get("listened")
        if not isinstance(track_id, str) or not track_id.isdigit() or int(track_id) <= 0 \
                or not isinstance(event_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", event_id) \
                or not isinstance(session, str) or not isinstance(stamp, str) \
                or type(listened) not in (int, float) or not math.isfinite(listened) \
                or not 10 < listened <= 86400:
            raise ApiError("Choose a track, playback event and more than ten seconds of listening.")
        try:
            played_at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if played_at.utcoffset() is None:
                raise ValueError
            played_at = played_at.astimezone(timezone.utc)
        except (ValueError, OverflowError):
            raise ApiError("Choose a valid playback timestamp with a timezone.") from None
        now = time.time()
        if not now - 86400 <= played_at.timestamp() <= now + 60:
            raise ApiError("This playback event is too old or is in the future.")
        with self.play_lock:
            with self.lock:
                if self.config.get("record_plays") is not True:
                    return {"status": "disabled"}
                client = self._require_client()
                if session != self.playback_session:
                    raise NotConnected("The playback connection changed. Reload Tagcast.")
                bridge = self.queue_sync
                if body.get("browser") == bridge.owner and bridge.owner \
                        and bridge.binding == session and (bridge.target != bridge.own_session
                        or bridge.state.get("role") != "player"):
                    return {"status": "controller"}
                fingerprint = (track_id, played_at.isoformat())
                key = (session, event_id)
                if previous := self.play_events.get(key):
                    if previous["fingerprint"] != fingerprint:
                        raise ApiError("This playback event was already used for another play.")
                    return {"status": previous["status"]}
                # Keep all eligible event IDs; never evict a recent ID and risk counting it twice.
                self.play_events = {k: v for k, v in self.play_events.items() if v["created"] >= now - 86400}
                if len(self.play_events) >= 10000:
                    raise ApiError("Too many playback events. Recording is temporarily unavailable.")
                library, _ = self._library()
                library.active_track_album(int(track_id))
                event = {"fingerprint": fingerprint, "created": now, "status": "unconfirmed"}
                self.play_events[key] = event  # remember the attempt before sending anything
            history = [{"day": played_at.strftime("%Y-%m-%d"), "plays": {track_id: 1},
                        "detail": {track_id: [{"event": "play", "ts": played_at.strftime("%Y-%m-%d %H:%M:%S")}]}}]
            try:
                result = client._jsonrequest("status", history=history)
                if result.get("result") is not True:
                    raise ApiError("iBroadcast did not acknowledge the play.")
            except ApiError:
                raise ApiError("The play could not be confirmed and will not be retried automatically.") from None
            event["status"] = "sent"
            return {"status": "sent"}

    def favourite(self, body):
        """Set one native track rating, comparing the displayed value before writing."""
        track_id, before, rating = body.get("track_id"), body.get("before"), body.get("rating")
        if not isinstance(track_id, str) or not track_id.isdigit() or int(track_id) <= 0 \
                or type(before) is not int or not 0 <= before <= 10 \
                or type(rating) is not int or rating not in (0, 1, 5):
            raise ApiError("Choose a track and its current rating: 0 clears, 1 dislikes, 5 likes.")
        track_id = int(track_id)
        client = self._require_client()
        if not self.save_lock.acquire(blocking=False):
            raise ApiError("Another save is still running.")
        try:
            fresh, _ = self._current(client)
            track = fresh.track_view(track_id)
            fresh.active_track_album(track_id)
            if track["rating"] != before:
                raise ConflictError("This track's rating changed in iBroadcast. Reload the library and try again.")
            if before == rating:
                return {"track_id": str(track_id), "rating": rating, "status": "saved"}
            # Official web player and API: ratetrack, track_id array, 5 = thumbs up, 0 = unset.
            try:
                client._jsonrequest("ratetrack", track_id=[track_id], rating=rating)
            except UncertainWrite:
                pass  # The fresh read-back, not a lost reply, determines the result.

            def verify_rating(after):
                current = after.tracks.get(track_id, {})
                actual = number(current.get("rating"))
                try:
                    after.active_track_album(track_id)
                    confirmed = actual == rating
                except LibraryError:
                    confirmed = False
                return [{"id": str(track_id), "rating": actual,
                         "status": "saved" if confirmed else "unverified"}]

            job = self._check_later(client, self.downloads, verify_rating, include_albums=False)
            return {"track_id": str(track_id), "rating": rating, "status": "sent", "job": job}
        finally:
            self.save_lock.release()

    def save(self, changes):
        client = self._require_client()
        if not self.save_lock.acquire(blocking=False):
            raise ApiError("Another save is still running.")
        try:
            return self._save(client, changes)
        finally:
            self.save_lock.release()

    def _save(self, client, changes):
        fresh, _ = self._current(client)
        plan = plan_save(fresh, changes)  # raises ConflictError before anything is written
        if not plan["items"]:
            return {"results": [], "albums": fresh.album_index(), "editor_names": fresh.editor_names(), "created_artists": [],
                    "error": "", "message": "iBroadcast already has these values."}

        failed, error = {}, ""
        if self.combine_sets and any(i["kind"] == "album" for i in plan["items"]):
            blocked = [i for i in plan["items"] if i["kind"] == "album"]
            failed.update({("album", i["id"]): "blocked" for i in blocked})
            error = (f"{COMBINE_SETS_MESSAGE} {len(blocked)} album "
                     f"{'change was' if len(blocked) == 1 else 'changes were'} not sent; "
                     "track changes were saved as usual.")
        sendable = {**plan, "items": [i for i in plan["items"] if (i["kind"], i["id"]) not in failed]}
        needed = {name for i in sendable["items"] for name in patch_artist_names(i["patch"])}

        artist_ids, created = dict(plan["artists"]), []
        for name in [n for n in plan["new_artists"] if n in needed]:
            try:
                artist_id = number(client._jsonrequest("create_artist", name=name).get("artist_id"))
            except ApiError as failure:
                raise ApiError(f"Could not create artist “{name}”: {failure}") from None
            if not artist_id:
                raise ApiError(f"iBroadcast did not return an ID for new artist “{name}”.")
            artist_ids[name] = artist_id
            created.append(name)

        stopped = False
        for mode, body in write_requests(sendable, artist_ids):
            kind = "album" if mode == "update_album" else "track"
            rows = next(iter(body.values()))
            ids = [row["album_id" if kind == "album" else "file_id"] for row in rows]
            if stopped:
                failed.update({(kind, i): "not_sent" for i in ids})
                continue
            try:
                client._jsonrequest(mode, **body)
            except UncertainWrite as failure:
                stopped = True
                error = f"{error} {mode} could not be confirmed: {failure} Remaining requests were not sent; checking the library.".strip()
            except ApiError as failure:
                stopped = True
                error = f"{error} iBroadcast refused {mode}: {failure}".strip()
                log.error("%s for %s %s failed: %s — request: %s", mode, kind, ids, failure,
                          json.dumps(body, ensure_ascii=False)[:2000])
                failed.update({(kind, i): "failed" for i in ids})

        results = [{"kind": i["kind"], "id": str(i["id"]), "label": i["label"],
                    "fields": sorted(i["patch"]),
                    "status": failed.get((i["kind"], i["id"]), "sent")} for i in plan["items"]]
        job = self._check_later(client, self.downloads,
                                lambda after: verify(after, plan, artist_ids, failed))
        return {"results": results, "job": job, "created_artists": created, "error": error}

    # -- read-back -----------------------------------------------------------

    def _check_later(self, client, written, check, include_albums=True):
        """Download the library in the background and run check(library) -> results.

        A full download takes as long as half a minute for a large library, so saves
        return as soon as iBroadcast accepted the writes and the browser asks for the
        read-back with job(). The next save waits for this download instead of starting
        another one.
        """
        job_id = secrets.token_urlsafe(9)
        with self.lock:
            self.jobs[job_id] = {"state": "checking"}
            for old in list(self.jobs)[:-20]:
                del self.jobs[old]

        def run():
            try:
                after, _ = self._current(client, after=written)
                result = {"state": "done", "results": check(after)}
                if include_albums:
                    result["albums"] = after.album_index()
                    result["editor_names"] = after.editor_names()
            except (ApiError, LibraryError) as failure:
                result = {"state": "error",
                          "error": f"The write could not be verified because the library could not be read back: {failure}"}
            except Exception:  # report, never leave the browser waiting
                log.exception("Read-back failed")
                result = {"state": "error", "error": "The write could not be verified. Reload the library before reviewing another change."}
            with self.lock:
                self.jobs[job_id] = result

        threading.Thread(target=run, daemon=True).start()
        return job_id

    def job(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise ApiError("This read-back is no longer available. Reload the library.")
            return self.jobs[job_id]


    # -- overview -----------------------------------------------------------------

    def overview(self):
        client = self._require_client()
        try:
            data = client._jsonrequest("status")
        except NotConnected:
            self._disconnect()
            raise
        library, _ = self._library()
        return {"account": account_view(data), "stats": library.stats()}

    # -- settings and online sources ------------------------------------------

    def source_keys(self):
        return {key: os.environ.get(KEY_ENV[key]) or self.config.get(key, "") for key in KEY_ENV}

    def disabled_sources(self):
        disabled = self.config.get("disabled_sources", [])
        return disabled if isinstance(disabled, list) else []

    def settings(self):
        return {"sources": self.lookup.describe(),
                "keys_from_env": [k for k, env in KEY_ENV.items() if os.environ.get(env)],
                "auto_lookup": self.config.get("auto_lookup", True),
                "auto_updates": self.config.get("auto_updates", True),
                "record_plays": self.config.get("record_plays") is True,
                "stream_quality": self.config.get("stream_quality", "128"),
                "queue_sync": self.config.get("queue_sync") is True,
                "album_guide": self.config.get("album_guide") is True,
                "artist_biographies": self.config.get("artist_biographies") is True,
                "artist_biographies_revision": self.artist_bios.revision,
                "album_information": self.config.get("album_information") is True,
                "album_information_revision": self.album_info.revision,
                "guide_matching_details": self.config.get("guide_matching_details"),
                "premium": self.premium}

    def check_updates(self, manual=False):
        with self.lock:
            enabled = self.config.get("auto_updates", True)
        return self.updates.check(enabled=enabled, manual=manual)

    def save_settings(self, body):
        with self.lock:
            if "disabled_sources" in body:
                disabled = body["disabled_sources"]
                names = {source["name"] for source in self.lookup.describe()}
                if not isinstance(disabled, list) or len(disabled) > len(names) \
                        or any(not isinstance(name, str) or name not in names for name in disabled) \
                        or len(set(disabled)) != len(disabled):
                    raise ApiError("Choose valid online sources to enable or disable.")
            if "album_information" in body and type(body["album_information"]) is not bool:
                raise ApiError("Choose whether album information is enabled.")
            if "artist_biographies" in body and type(body["artist_biographies"]) is not bool:
                raise ApiError("Choose whether artist biographies are enabled.")
            if "album_guide" in body and type(body["album_guide"]) is not bool:
                raise ApiError("Choose whether 1001 Albums is enabled.")
            if "guide_matching_details" in body and type(body["guide_matching_details"]) is not bool:
                raise ApiError("Choose whether matching details are shown.")
            if "auto_updates" in body and not isinstance(body["auto_updates"], bool):
                raise ApiError("Choose whether automatic update checks are enabled.")
            if "record_plays" in body and not isinstance(body["record_plays"], bool):
                raise ApiError("Choose whether playback is recorded in iBroadcast.")
            if "stream_quality" in body:
                if body["stream_quality"] not in ("96", "128", "192", "256", "320", "orig"):
                    raise ApiError("Choose a supported streaming quality.")
                self.config["stream_quality"] = body["stream_quality"]
            if "queue_sync" in body:
                if type(body["queue_sync"]) is not bool:
                    raise ApiError("Choose whether queue synchronisation is enabled.")
                self.config["queue_sync"] = body["queue_sync"]
            for key in KEY_ENV:
                if key in body:
                    value = str(body[key] or "").strip()
                    if len(value) > 200 or any(c.isspace() for c in value):
                        raise ApiError(f"That {SOURCE_KEYS[key].label} key doesn't look right.")
                    if value:
                        self.config[key] = value
                    else:
                        self.config.pop(key, None)
            if "auto_lookup" in body:
                self.config["auto_lookup"] = bool(body["auto_lookup"])
            if "disabled_sources" in body:
                self.config["disabled_sources"] = list(body["disabled_sources"])
            if "auto_updates" in body:
                self.config["auto_updates"] = body["auto_updates"]
            if "record_plays" in body:
                self.config["record_plays"] = body["record_plays"]
            if "album_guide" in body:
                self.config["album_guide"] = body["album_guide"]
            if "artist_biographies" in body:
                if body["artist_biographies"] != self.config.get("artist_biographies", False):
                    self.artist_bios.revision += 1
                self.config["artist_biographies"] = body["artist_biographies"]
            if "album_information" in body:
                if body["album_information"] != self.config.get("album_information", False):
                    self.album_info.revision += 1
                self.config["album_information"] = body["album_information"]
            if "guide_matching_details" in body:
                self.config["guide_matching_details"] = body["guide_matching_details"]
            self._write("config.json", self.config)
        if not self.config.get("queue_sync"):
            self.queue_sync.disconnect()
        return self.settings()

    def _library(self):
        with self.lock:
            library, user_id = self.library, self.library_user
        if library is None:
            library, _ = self._current(self._require_client())
            with self.lock:
                user_id = self.library_user
        return library, user_id

    def lookup_album(self, source, album_id=None, artist=None, album=None):
        if album_id and not (artist and album):
            library, _ = self._library()
            view = library.album_view(number(album_id))
            artist, album = artist or view["artist"], album or view["name"]
        return {"source": source, "artist": artist, "album": album,
                "candidates": self.lookup.album(source, artist, album)}

    def lookup_artist(self, source, name):
        return {"source": source, "name": name, "candidates": self.lookup.artist(source, name)}

    # -- artwork --------------------------------------------------------------

    def related_artwork(self, album_id=None, artist_id=None):
        """Images iBroadcast already has for this album or artist (the web editor's picker)."""
        client = self._require_client()
        library, _ = self._library()
        # Like the web editor, ask with one of the album's or the artist's own tracks; with
        # track_id 0 iBroadcast answers with images of unrelated artists.
        if album_id:
            track_id = next(iter(library.album_art_state(number(album_id))), 0)
        else:
            track_id = library.first_track_of_artist(number(artist_id))
        if not track_id:
            return {"artwork": []}
        data = client._jsonrequest("get_artwork", track_id=track_id, artist_id=number(artist_id))
        ids = []
        for item in data.get("art") or []:
            artwork_id = number(item.get("artwork_id") if isinstance(item, dict) else item)
            if artwork_id and artwork_id not in ids:
                ids.append(artwork_id)
        return {"artwork": [{"artwork_id": i, "thumb": library.art_url(i, 150),
                             "image": library.art_url(i, 1000)} for i in ids[:40]]}

    def _image(self, client, source, user_id):
        if number(source.get("artwork_id")):
            return number(source["artwork_id"])
        if source.get("url"):
            data, name, mime = artwork.from_url(source["url"], allow_private=bool(_test_base))
        else:
            data, name, mime = artwork.from_data_url(source.get("data"), source.get("name") or "artwork")
        return client.upload_artwork(data, name, mime, user_id)

    def change_artwork(self, body):
        """Replace an album's cover (all its tracks) or an artist's image.

        body: {target: album|artist, id, label, before, source}
          before: album {"tracks": {track_id: artwork_id}}, artist {"artwork_id": n}
          source: {"url"} | {"data": data URL, "name"} | {"artwork_id"} (already in iBroadcast)
        """
        return self._artwork(body, body.get("source") or {})

    def undo_artwork(self, body):
        """Put back the previous cover or image: body as change_artwork, plus "previous"."""
        return self._artwork(body, None, body.get("previous"))

    def _artwork(self, body, source, previous=None):
        target, item_id = body.get("target"), number(body.get("id"))
        if target not in ("album", "artist") or not item_id:
            raise ApiError("Choose an album or an artist.")
        client = self._require_client()
        if not self.save_lock.acquire(blocking=False):
            raise ApiError("Another save is still running.")
        try:
            fresh, _ = self._current(client)
            with self.lock:
                user_id = self.library_user
            before = body.get("before") if isinstance(body.get("before"), dict) else {}
            if target == "album":
                now = fresh.album_art_state(item_id)
                expected = {number(k): number(v) for k, v in (before.get("tracks") or {}).items()}
                if now != expected:
                    raise ConflictError("The cover changed in iBroadcast since you loaded it. "
                                        "Reload the library and try again.")
            else:
                now = fresh.artist_art(item_id)
                if now != number(before.get("artwork_id")):
                    raise ConflictError("The artist image changed in iBroadcast since you loaded it. "
                                        "Reload the library and try again.")

            note = ""
            assignments = 0

            def assign(mode, **values):
                nonlocal note, assignments
                try:
                    client._jsonrequest(mode, **values)
                    assignments += 1
                    return True
                except ApiError as failure:
                    if not isinstance(failure, UncertainWrite) and not assignments:
                        raise
                    note = (f"The artwork request could not be confirmed: {failure} "
                            "Remaining assignments were not sent. Checking the library; no automatic retry.")
                    return False

            if previous is None:  # a new image
                new_id = self._image(client, source, user_id)
                if target == "album":
                    wanted = dict.fromkeys(now, new_id)
                    assign("set_artwork", tracks=list(now), artwork_id=new_id)
                else:
                    wanted = new_id
                    assign("set_artist_artwork", artist_id=item_id, artwork_id=new_id)
            elif target == "album":  # undo: the previous artwork per track
                wanted = {number(k): number(v) for k, v in (previous.get("tracks") or {}).items()}
                if set(wanted) != set(now):
                    raise ApiError("This cover can't be restored: the album's tracks changed.")
                # iBroadcast has no way to remove a cover, so tracks that had none keep the new one
                bare = [t for t, artwork_id in wanted.items() if not artwork_id]
                wanted.update({t: now[t] for t in bare})
                groups = {}
                for track_id, artwork_id in wanted.items():
                    if track_id not in bare:
                        groups.setdefault(artwork_id, []).append(track_id)
                if not groups:
                    raise ApiError("This album had no cover before, and iBroadcast can't remove one, "
                                   "so there is nothing to restore.")
                for artwork_id, tracks in groups.items():
                    if not assign("set_artwork", tracks=tracks, artwork_id=artwork_id):
                        break
                new_id = max(groups, key=lambda i: len(groups[i]))
                if bare:
                    note += (f" {len(bare)} {'track' if len(bare) == 1 else 'tracks'} had no cover before "
                            f"and {'keeps' if len(bare) == 1 else 'keep'} the new one: iBroadcast can't "
                            "remove a cover.")
            else:
                wanted = new_id = number((previous or {}).get("artwork_id"))
                if not new_id:
                    raise ApiError("There was no artist image before, so there is nothing to restore.")
                assign("set_artist_artwork", artist_id=item_id, artwork_id=new_id)

            label = str(body.get("label") or target)[:300]
            field = "cover" if target == "album" else "image"

            def check(after):
                try:
                    got = after.album_art_state(item_id) if target == "album" else after.artist_art(item_id)
                    status = "saved" if got == wanted else "unverified"
                except LibraryError:
                    status = "unverified"
                return [{"kind": target, "id": str(item_id), "label": label, "fields": [field],
                         "status": status}]

            job = self._check_later(client, self.downloads, check)
            return {"artwork_id": new_id, "image": fresh.art_url(new_id, 300), "job": job, "note": note,
                    "previous": {"tracks": {str(k): v for k, v in now.items()}} if target == "album"
                    else {"artwork_id": now},
                    "results": [{"kind": target, "id": str(item_id), "label": label,
                                 "fields": [field], "status": "sent"}]}
        finally:
            self.save_lock.release()

    def trash_tracks(self, body):
        """Move tracks to iBroadcast's trash after checking them against the library.

        body: {"tracks": [{"id", "album_id", "title"}]}, the tracks as the page showed them.
        An album is in the trash once all of its tracks are. Tagcast can't take tracks
        out of the trash again.
        """
        items = [i for i in body.get("tracks") or [] if isinstance(i, dict)]
        wanted = {number(i.get("id")): (number(i.get("album_id")), text(i.get("title"))[:300]) for i in items}
        if not wanted or len(wanted) != len(items) or 0 in wanted or any(not a for a, _ in wanted.values()):
            raise ApiError("Choose the tracks to move to the trash.")
        if len(wanted) > MAX_TRASH:
            raise ApiError(f"Move at most {MAX_TRASH} tracks to the trash at once.")
        client = self._require_client()
        if not self.save_lock.acquire(blocking=False):
            raise ApiError("Another save is still running.")
        try:
            fresh, _ = self._current(client)
            if any(track_id not in fresh.active_track_ids(album_id) for track_id, (album_id, _) in wanted.items()):
                raise ConflictError("These tracks changed in iBroadcast since you loaded them. "
                                    "Reload the library and try again.")
            return self._trash_checked(client, wanted)
        finally:
            self.save_lock.release()

    def trash_albums(self, body):
        """Reviewed complete albums; never accept a partial/stale set.

        The browser reviews all chosen albums, then sends bounded batches. Each
        batch checks the full membership, including added tracks and merged discs.
        """
        albums = body.get("albums")
        if body.get("approved") is not True or not isinstance(albums, list) or not albums \
                or len(albums) > 500 or not isinstance(body.get("combine_sets"), bool):
            raise ApiError("Review and approve the selected albums first.")
        wanted, snapshots = {}, {}
        for album in albums:
            if not isinstance(album, dict) or not number(album.get("id")) \
                    or number(album["id"]) in snapshots or not isinstance(album.get("tracks"), list) \
                    or not album["tracks"]:
                raise ApiError("Choose complete albums for the trash.")
            album_id = number(album["id"])
            snapshots[album_id] = album
            for track in album["tracks"]:
                if not isinstance(track, dict) or not number(track.get("id")) \
                        or number(track["id"]) in wanted or not isinstance(track.get("title"), str):
                    raise ApiError("Choose each reviewed track once.")
                wanted[number(track["id"])] = (album_id, track["title"])
        if len(wanted) > MAX_TRASH:
            raise ApiError(f"Move at most {MAX_TRASH} tracks in one batch.")
        client = self._require_client()
        if not self.save_lock.acquire(blocking=False):
            raise ApiError("Another save is still running.")
        try:
            fresh, _ = self._current(client)
            if bool(fresh.combine_sets) != body["combine_sets"]:
                raise ConflictError("The multi-disc setting changed. Review the albums again.")
            fresh._browse_index("genres")
            groups = set()
            for album_id, before in snapshots.items():
                active = fresh.active_track_ids(album_id)
                if album_id not in fresh._browse_albums or set(active) != {
                        number(t["id"]) for t in before["tracks"]}:
                    raise ConflictError("An album's tracks changed. Reload and review the albums again.")
                now = fresh.albums[album_id]
                artist = fresh.artist_name(now.get("artist_id"))
                if text(now.get("name")) != before.get("name") or artist != before.get("artist") \
                        or any(fresh.track_view(t)["title"] != wanted[t][1] for t in active):
                    raise ConflictError("An album or track changed. Reload and review the albums again.")
                groups.add(fresh._browse_albums[album_id])
            if len(groups) > 20:
                raise ApiError("Choose at most 20 displayed albums per batch.")
            if any(album_id not in snapshots for album_id, group in fresh._browse_albums.items()
                   if group in groups):
                raise ConflictError("The discs of an album set changed. Review the complete set again.")
            return self._trash_checked(client, wanted)
        finally:
            self.save_lock.release()

    def _trash_checked(self, client, wanted):
        if client is not self.client:
            raise NotConnected("The connection changed. Review the selection again.")
        client._jsonrequest("trash", tracks=list(wanted))

        def result(track_id, status):
            return {"kind": "track", "id": str(track_id), "label": wanted[track_id][1][:300] or "Track",
                    "fields": ["trash"], "status": status}

        def check(after):
            return [result(t, "saved" if t not in after.tracks or after.tracks[t].get("trashed")
                           else "unverified") for t in wanted]

        job = self._check_later(client, self.downloads, check)
        return {"results": [result(t, "sent") for t in wanted], "job": job}

    # -- playback -------------------------------------------------------------

    def stream(self, track_id, range_header=None, quality=None):
        """Open a track's audio from iBroadcast. Returns (response, mime); close the response."""
        client = self._require_client()
        library, user_id = self._library()
        quality = quality or self.config.get("stream_quality", "128")
        if quality not in ("96", "128", "192", "256", "320", "orig"):
            raise ApiError("Choose a supported streaming quality.")
        if quality != "128" and not self.premium:
            raise ApiError("This streaming quality requires iBroadcast Premium.")
        path, mime = library.stream_info(number(track_id), quality)
        if quality != "orig":
            mime = "audio/mpeg"
        response = client.open_stream(path, number(track_id), user_id, library.expires, range_header)
        if response.status_code in (401, 403):
            response.close()
            raise NotConnected("iBroadcast did not accept the session for playback. Connect again.")
        if not response.ok and response.status_code != 416:
            response.close()
            raise ApiError(f"iBroadcast could not play this track (HTTP {response.status_code}).")
        return response, mime


__all__ = ["ApiError", "LibraryError", "NotConnected", "Studio", "StudioClient"]
