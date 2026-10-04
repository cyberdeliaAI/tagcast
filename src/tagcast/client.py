"""iBroadcast account connection: OAuth, token storage, library download and saving.

Built on the ``ibroadcast`` package (https://github.com/ctrueden/ibroadcast-python)
for OAuth (device code and PKCE authorization code flows) and token handling.
"""

import gzip
import json
import logging
import os
import secrets
import shutil
import threading
import time
from pathlib import Path

import ibroadcast
import requests
from ibroadcast import oauth

from . import __version__, artwork
from .library import (
    ConflictError,
    Library,
    LibraryError,
    number,
    plan_save,
    text,
    verify,
    write_requests,
)
from .sources import KEYS as SOURCE_KEYS
from .sources import Lookup

log = logging.getLogger("tagcast")

SCOPES = ["user.library:read", "user.library:write", "user.account:read"]
CLIENT_NAME = "tagcast"
TIMEOUT = 120
COMBINE_SETS_MESSAGE = ("“Combine Multi-Disc Album Sets” is on in your iBroadcast settings, and "
                        "iBroadcast doesn't accept album changes (title, album artist, year, disc) "
                        "while it is. Turn it off in iBroadcast, save the album changes, then turn "
                        "it back on.")
RETRY_DELAYS = (2, 6)  # seconds before the 2nd and 3rd attempt after a temporary failure
NO_RETRY = {"create_artist"}  # not safe to repeat: a lost answer would create a second artist
CACHE_FILE = "library-cache.json.gz"
KEY_ENV = {"lastfm_api_key": "LASTFM_API_KEY", "discogs_token": "DISCOGS_TOKEN",
           "fanart_api_key": "FANART_API_KEY"}

API_URL = "https://api.ibroadcast.com"
LIBRARY_URL = "https://library.ibroadcast.com"
ARTWORK_UPLOAD_URL = "https://artwork-upload.ibroadcast.com"
STREAM_URL = "https://streaming.ibroadcast.com"

# Point everything at a test server, e.g. TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9000
_test_base = os.environ.get("TAGCAST_IBROADCAST_BASE", "").rstrip("/")
if _test_base:
    API_URL, LIBRARY_URL = f"{_test_base}/api", f"{_test_base}/library"
    ARTWORK_UPLOAD_URL, STREAM_URL = f"{_test_base}/artwork-upload", f"{_test_base}/stream"
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
        "premium": bool(user.get("premium")),
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


class StudioClient(ibroadcast.iBroadcast):
    """iBroadcast client that keeps server messages and refreshes tokens up front."""

    def __init__(self, **kwargs):
        super().__init__(client=CLIENT_NAME, version=__version__,
                         device_name="Tagcast", log=log, **kwargs)

    def _post(self, url, args, retry=True):
        """POST JSON. Network errors, HTTP 429 and 5xx are retried (writes here set values,
        so sending one twice does no harm), except for modes in NO_RETRY."""
        retry = retry and args.get("mode") not in NO_RETRY
        for attempt, delay in enumerate((0, *RETRY_DELAYS) if retry else (0,)):
            time.sleep(delay)
            last = attempt == (len(RETRY_DELAYS) if retry else 0)
            headers = self._auth_headers()
            try:
                response = requests.post(url, data=json.dumps(args), headers=headers,
                                         timeout=TIMEOUT if url == LIBRARY_URL else 45)
            except requests.RequestException as error:
                log.warning("%s: %s (attempt %d)", args.get("mode", "library"),
                            error.__class__.__name__, attempt + 1)
                if last:
                    raise ApiError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None
                continue
            try:
                data = response.json()
            except ValueError:
                data = {}
            if (response.status_code == 429 or response.status_code >= 500) and not last:
                log.warning("%s: HTTP %d (attempt %d)", args.get("mode", "library"),
                            response.status_code, attempt + 1)
                continue
            if response.status_code == 401:
                data.setdefault("authenticated", False)
            elif not response.ok:
                raise ApiError(data.get("message") or f"iBroadcast returned HTTP {response.status_code}.")
            return data
        raise ApiError("iBroadcast did not answer.")

    def _jsonrequest(self, mode, url=None, **kwargs):
        token_set = getattr(self, "token_set", None)
        if token_set and token_set.is_expired and self._refresh_token and self._client_id:
            self._refresh_or_fail()
        url = url or f"{API_URL}/{mode}"
        args = self._request_body(mode, **kwargs)
        data = self._post(url, args)
        if data.get("authenticated") is False:
            if not (self._refresh_token and self._client_id):
                raise NotConnected("Your iBroadcast session expired. Connect again.")
            self._refresh_or_fail()
            data = self._post(url, args)
            if data.get("authenticated") is False:
                raise NotConnected("iBroadcast did not accept the session. Connect again.")
        if data.get("result") is False:
            raise ApiError(data.get("message") or f"iBroadcast rejected {mode}.")
        return data

    def _refresh_or_fail(self):
        try:
            self._refresh()
        except (oauth.OAuthError, requests.RequestException, KeyError, ValueError):
            raise NotConnected("Your iBroadcast session expired. Connect again.") from None

    def fetch_library(self):
        return Library(self._jsonrequest("library", url=LIBRARY_URL))

    def _with_fresh_token(self, send):
        """Run send() and retry once with a refreshed token if iBroadcast refuses it."""
        token_set = getattr(self, "token_set", None)
        if token_set and token_set.is_expired and self._refresh_token and self._client_id:
            self._refresh_or_fail()
        response = send()
        if response.status_code in (401, 403) and self._refresh_token and self._client_id:
            response.close()
            self._refresh_or_fail()
            response = send()
        return response

    def upload_artwork(self, data, filename, mime, user_id):
        """Store an image in iBroadcast's artwork library and return its artwork ID.

        Mirrors the web editor's upload (artwork-upload.ibroadcast.com, field
        uploaded_file) without an album or artist, so applying it stays a separate,
        checked step (set_artwork / set_artist_artwork).
        """
        def send():
            return requests.post(
                ARTWORK_UPLOAD_URL, timeout=TIMEOUT,
                headers={"Authorization": f"Bearer {self._access_token}",
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

    def open_stream(self, path, file_id, user_id, expires, range_header=None):
        """Open the audio of one track. The caller closes the returned response."""
        def send():
            params = {"Signature": self._access_token, "file_id": file_id, "user_id": user_id,
                      "platform": self._client, "version": self._version}
            if expires:
                params["Expires"] = expires
            headers = {"User-Agent": self._user_agent}
            if range_header:
                headers["Range"] = range_header
            return requests.get(STREAM_URL + path, params=params, headers=headers,
                                stream=True, timeout=TIMEOUT)
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
        self.client = None
        self.library = None
        self.library_user = None
        self.combine_sets = False  # iBroadcast refuses update_album while this setting is on
        self.library_started = 0.0  # time.monotonic() when the copy in memory began downloading
        self.account = None
        self.cache_lock = threading.Lock()
        self.download_lock = threading.Lock()  # one full library download at a time
        self.jobs = {}  # background read-backs after a save, by job ID
        self.device = None
        self._device_gen = 0
        self._pkce = {}
        self.config = self._read("config.json") or {}
        self.lookup = Lookup(self.source_keys)
        tokens = self._read("tokens.json")
        if tokens and tokens.get("client_id") == self.client_id and tokens.get("token_set"):
            try:
                self._connect(oauth.TokenSet.from_dict(tokens["token_set"]), save=False)
            except (KeyError, TypeError):
                pass

    # -- storage -------------------------------------------------------------

    def _read(self, name):
        try:
            return json.loads((self.home / name).read_text())
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
            if data.get("user_id") != user_id or data.get("status", {}).get("lastmodified") != lastmodified:
                return None
            return Library(data)
        except (OSError, ValueError, AttributeError, EOFError, LibraryError):
            return None

    def _write_cache(self, library, user_id):
        """Write the library to disk in the background; a failed write only costs a download."""
        def write():
            with self.cache_lock:
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
        return os.environ.get("IBROADCAST_CLIENT_ID") or self.config.get("client_id") or ""

    def set_client_id(self, client_id):
        client_id = str(client_id or "").strip()
        if not client_id or len(client_id) > 200 or any(c.isspace() for c in client_id):
            raise ApiError("Enter the client ID of your iBroadcast app.")
        with self.lock:
            if client_id != self.client_id:
                self._disconnect()
            self.config["client_id"] = client_id
            self._write("config.json", self.config)

    # -- connection ----------------------------------------------------------

    def _save_tokens(self, token_set):
        self._write("tokens.json", {"client_id": self.client_id, "token_set": token_set.to_dict()})

    def _connect(self, token_set, save=True):
        client = StudioClient(access_token=token_set.access_token,
                              refresh_token=token_set.refresh_token,
                              client_id=self.client_id,
                              token_refreshed_callback=self._save_tokens)
        client.token_set = token_set
        with self.lock:
            self.client, self.library, self.account = client, None, None
        if save:
            self._save_tokens(token_set)

    def _disconnect(self):
        with self.lock:
            self.client = self.library = self.account = self.device = None
            self._device_gen += 1
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
            "connected": bool(client),
            "combine_sets": self.combine_sets,
            "account": self.account or "",
            "device": device,
            "scopes": SCOPES,
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
        return str(user.get("username") or user.get("email") or "")

    def start_device(self):
        if not self.client_id:
            raise ApiError("Enter your app's client ID first.")
        try:
            code = oauth.device_code_request(self.client_id, SCOPES)
        except (oauth.OAuthError, requests.RequestException, ValueError) as error:
            raise ApiError(f"iBroadcast did not start the sign-in: {error}") from None
        if "device_code" not in code or "user_code" not in code:
            raise ApiError("iBroadcast returned an unexpected sign-in response.")
        with self.lock:
            self._device_gen += 1
            gen = self._device_gen
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
            token_set = oauth.poll_for_token(self.client_id, device_code, interval)
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
            self._pkce = {state: (verifier, redirect_uri, time.time())}
        return oauth.build_authorize_url(self.client_id, state,
                                         oauth.generate_code_challenge(verifier),
                                         SCOPES, redirect_uri)

    def finish_browser(self, code, state):
        with self.lock:
            entry = self._pkce.pop(state, None)
        if not entry or time.time() - entry[2] > 900:
            raise ApiError("This sign-in link expired or was not started here. Try again.")
        try:
            token_set = oauth.exchange_auth_code(self.client_id, code, entry[1], entry[0])
        except (oauth.OAuthError, requests.RequestException, KeyError, ValueError) as error:
            raise ApiError(f"iBroadcast did not complete the sign-in: {error}") from None
        self._connect(token_set)

    def logout(self):
        with self.lock:
            client = self.client
        if client and client._refresh_token:
            try:
                oauth.revoke_token(self.client_id, client._refresh_token)
            except Exception:  # still forget the tokens locally
                pass
        self._disconnect()
        self._forget_cache()

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
        self.combine_sets = text(prefs.get("combine_sets")) in ("1", "true", "True")
        return text(status.get("lastmodified")), text(user.get("id") or user.get("user_id"))

    def _keep(self, library, user_id, started):
        with self.lock:
            self.library, self.library_user, self.library_started = library, user_id, started
        self._write_cache(library, user_id)

    def _current(self, client, refresh=False, after=None):
        """The library as iBroadcast has it now. Downloads only when it changed since our copy.

        iBroadcast has no partial library download, but its status call reports
        "lastmodified", which changes with every library edit (the web player relies on
        the same signal). Returns (library, source) with source memory, cache or download.

        refresh skips that check. after=<monotonic time> also skips it, but accepts a
        download that started after that time, so a read-back can share a download.
        """
        lastmodified, user_id = self._remote_state(client)
        if lastmodified and not refresh:
            if library := self._in_memory(user_id, lastmodified):
                return library, "memory"
            if library := self._read_cache(user_id, lastmodified):
                with self.lock:
                    self.library, self.library_user = library, user_id
                return library, "cache"
        with self.download_lock:
            # a download that finished while we waited (e.g. a read-back) may be current
            if lastmodified and not refresh and after is None \
                    and (library := self._in_memory(user_id, lastmodified)):
                return library, "memory"
            with self.lock:
                if after is not None and self.library and self.library_user == user_id \
                        and self.library_started >= after:
                    return self.library, "memory"
            started = time.monotonic()
            library = self._fetch(client)
            self._keep(library, user_id, started)
        return library, "download"

    def _in_memory(self, user_id, lastmodified):
        with self.lock:
            library, owner = self.library, self.library_user
        if library and owner == user_id and library.lastmodified == lastmodified:
            return library
        return None

    def account_settings(self):
        """iBroadcast settings that change what can be saved, checked now."""
        self._remote_state(self._require_client())
        return {"combine_sets": self.combine_sets}

    def load_library(self, refresh=False):
        library, source = self._current(self._require_client(), refresh)
        return {"albums": library.album_index(), "artists": library.artist_names(),
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
            return {"results": [], "albums": fresh.album_index(), "created_artists": [],
                    "error": "", "message": "iBroadcast already has these values."}

        failed, error = {}, ""
        if self.combine_sets and any(i["kind"] == "album" for i in plan["items"]):
            blocked = [i for i in plan["items"] if i["kind"] == "album"]
            failed.update({("album", i["id"]): "blocked" for i in blocked})
            error = (f"{COMBINE_SETS_MESSAGE} {len(blocked)} album "
                     f"{'change was' if len(blocked) == 1 else 'changes were'} not sent; "
                     "track changes were saved as usual.")
        sendable = {**plan, "items": [i for i in plan["items"] if (i["kind"], i["id"]) not in failed]}
        needed = {i["patch"]["artist"] for i in sendable["items"] if "artist" in i["patch"]}

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
            except ApiError as failure:
                stopped = True
                error = f"{error} iBroadcast refused {mode}: {failure}".strip()
                log.error("%s for %s %s failed: %s — request: %s", mode, kind, ids, failure,
                          json.dumps(body, ensure_ascii=False)[:2000])
                failed.update({(kind, i): "failed" for i in ids})

        results = [{"kind": i["kind"], "id": str(i["id"]), "label": i["label"],
                    "fields": sorted(i["patch"]),
                    "status": failed.get((i["kind"], i["id"]), "sent")} for i in plan["items"]]
        job = self._check_later(client, time.monotonic(),
                                lambda after: verify(after, plan, artist_ids, failed))
        return {"results": results, "job": job, "created_artists": created, "error": error}

    # -- read-back -----------------------------------------------------------

    def _check_later(self, client, written, check):
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
                result = {"state": "done", "results": check(after), "albums": after.album_index()}
            except (ApiError, LibraryError) as failure:
                result = {"state": "error",
                          "error": f"Saved, but the library could not be read back: {failure}"}
            except Exception:  # report, never leave the browser waiting
                log.exception("Read-back failed")
                result = {"state": "error", "error": "Saved, but the read-back failed. Reload the library."}
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

    def settings(self):
        return {"sources": self.lookup.describe(),
                "keys_from_env": [k for k, env in KEY_ENV.items() if os.environ.get(env)],
                "auto_lookup": self.config.get("auto_lookup", True)}

    def save_settings(self, body):
        with self.lock:
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
            self._write("config.json", self.config)
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
        track_id = 0
        if album_id:
            track_id = next(iter(library.album_art_state(number(album_id))), 0)
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

            if previous is None:  # a new image
                new_id = self._image(client, source, user_id)
                if target == "album":
                    client._jsonrequest("set_artwork", tracks=list(now), artwork_id=new_id)
                    wanted = dict.fromkeys(now, new_id)
                else:
                    client._jsonrequest("set_artist_artwork", artist_id=item_id, artwork_id=new_id)
                    wanted = new_id
            elif target == "album":  # undo: the previous artwork per track
                wanted = {number(k): number(v) for k, v in (previous.get("tracks") or {}).items()}
                if set(wanted) != set(now) or not all(wanted.values()):
                    raise ApiError("This cover can't be restored: the album's tracks changed.")
                groups = {}
                for track_id, artwork_id in wanted.items():
                    groups.setdefault(artwork_id, []).append(track_id)
                for artwork_id, tracks in groups.items():
                    client._jsonrequest("set_artwork", tracks=tracks, artwork_id=artwork_id)
                new_id = max(groups, key=lambda i: len(groups[i]))
            else:
                wanted = new_id = number((previous or {}).get("artwork_id"))
                if not new_id:
                    raise ApiError("There was no artist image before, so there is nothing to restore.")
                client._jsonrequest("set_artist_artwork", artist_id=item_id, artwork_id=new_id)

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

            job = self._check_later(client, time.monotonic(), check)
            return {"artwork_id": new_id, "image": fresh.art_url(new_id, 300), "job": job,
                    "previous": {"tracks": {str(k): v for k, v in now.items()}} if target == "album"
                    else {"artwork_id": now},
                    "results": [{"kind": target, "id": str(item_id), "label": label,
                                 "fields": [field], "status": "sent"}]}
        finally:
            self.save_lock.release()

    # -- playback -------------------------------------------------------------

    def stream(self, track_id, range_header=None):
        """Open a track's audio from iBroadcast. Returns (response, mime); close the response."""
        client = self._require_client()
        library, user_id = self._library()
        path, mime = library.stream_info(number(track_id))
        response = client.open_stream(path, number(track_id), user_id, library.expires, range_header)
        if response.status_code in (401, 403):
            response.close()
            raise NotConnected("iBroadcast did not accept the session for playback. Connect again.")
        if not response.ok and response.status_code != 416:
            response.close()
            raise ApiError(f"iBroadcast could not play this track (HTTP {response.status_code}).")
        return response, mime


__all__ = ["ApiError", "LibraryError", "NotConnected", "Studio", "StudioClient"]
