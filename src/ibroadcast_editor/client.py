"""iBroadcast account connection: OAuth, token storage, library download and saving.

Built on the ``ibroadcast`` package (https://github.com/ctrueden/ibroadcast-python)
for OAuth (device code and PKCE authorization code flows) and token handling.
"""

import gzip
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path

import ibroadcast
import requests
from ibroadcast import oauth

from . import __version__
from .library import Library, LibraryError, number, plan_save, text, verify, write_requests

log = logging.getLogger("library-studio")

SCOPES = ["user.library:read", "user.library:write", "user.account:read"]
CLIENT_NAME = "library-studio"
TIMEOUT = 120
CACHE_FILE = "library-cache.json.gz"

API_URL = "https://api.ibroadcast.com"
LIBRARY_URL = "https://library.ibroadcast.com"

# Point everything at a test server, e.g. LIBRARY_STUDIO_IBROADCAST_BASE=http://127.0.0.1:9000
_test_base = os.environ.get("LIBRARY_STUDIO_IBROADCAST_BASE", "").rstrip("/")
if _test_base:
    API_URL, LIBRARY_URL = f"{_test_base}/api", f"{_test_base}/library"
    oauth.OAUTH_BASE = f"{_test_base}/oauth"
    oauth.AUTHORIZE_URL = f"{oauth.OAUTH_BASE}/authorize"
    oauth.TOKEN_URL = f"{oauth.OAUTH_BASE}/token"
    oauth.DEVICE_CODE_URL = f"{oauth.OAUTH_BASE}/device/code"
    oauth.REVOKE_URL = f"{oauth.OAUTH_BASE}/revoke"


class ApiError(Exception):
    pass


class NotConnected(ApiError):
    pass


class StudioClient(ibroadcast.iBroadcast):
    """iBroadcast client that keeps server messages and refreshes tokens up front."""

    def __init__(self, **kwargs):
        super().__init__(client=CLIENT_NAME, version=__version__,
                         device_name="Library Studio", log=log, **kwargs)

    def _post(self, url, args):
        headers = self._auth_headers()
        try:
            response = requests.post(url, data=json.dumps(args), headers=headers, timeout=TIMEOUT)
        except requests.RequestException as error:
            raise ApiError(f"Could not reach iBroadcast ({error.__class__.__name__}).") from None
        try:
            data = response.json()
        except ValueError:
            data = {}
        if response.status_code == 401:
            data.setdefault("authenticated", False)
        elif not response.ok:
            raise ApiError(data.get("message") or f"iBroadcast returned HTTP {response.status_code}.")
        return data

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


class Studio:
    """Holds the connection state for the local server. Thread safe."""

    def __init__(self, home=None):
        self.home = Path(home or os.environ.get("LIBRARY_STUDIO_HOME")
                         or Path.home() / ".library-studio")
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.client = None
        self.library = None
        self.library_user = None
        self.account = None
        self.cache_lock = threading.Lock()
        self.device = None
        self._device_gen = 0
        self._pkce = {}
        self.config = self._read("config.json") or {}
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
        return text(status.get("lastmodified")), text(user.get("id") or user.get("user_id"))

    def _keep(self, library, user_id):
        with self.lock:
            self.library, self.library_user = library, user_id
        self._write_cache(library, user_id)

    def _current(self, client, refresh=False):
        """The library as iBroadcast has it now. Downloads only when it changed since our copy.

        iBroadcast has no partial library download, but its status call reports
        "lastmodified", which changes with every library edit (the web player relies on
        the same signal). Returns (library, source) with source memory, cache or download.
        """
        lastmodified, user_id = self._remote_state(client)
        if lastmodified and not refresh:
            with self.lock:
                library, owner = self.library, self.library_user
            if library and owner == user_id and library.lastmodified == lastmodified:
                return library, "memory"
            library = self._read_cache(user_id, lastmodified)
            if library:
                with self.lock:
                    self.library, self.library_user = library, user_id
                return library, "cache"
        library = self._fetch(client)
        self._keep(library, user_id)
        return library, "download"

    def load_library(self, refresh=False):
        library, source = self._current(self._require_client(), refresh)
        return {"albums": library.album_index(), "artists": library.artist_names(),
                "source": source, "lastmodified": library.lastmodified}

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

        artist_ids, created, error = dict(plan["artists"]), [], ""
        for name in plan["new_artists"]:
            try:
                artist_id = number(client._jsonrequest("create_artist", name=name).get("artist_id"))
            except ApiError as failure:
                raise ApiError(f"Could not create artist “{name}”: {failure}") from None
            if not artist_id:
                raise ApiError(f"iBroadcast did not return an ID for new artist “{name}”.")
            artist_ids[name] = artist_id
            created.append(name)

        failed = {}
        for mode, body in write_requests(plan, artist_ids):
            kind = "album" if mode == "update_album" else "track"
            rows = next(iter(body.values()))
            ids = [row["album_id" if kind == "album" else "file_id"] for row in rows]
            if error:
                failed.update({(kind, i): "not_sent" for i in ids})
                continue
            try:
                client._jsonrequest(mode, **body)
            except ApiError as failure:
                error = str(failure)
                failed.update({(kind, i): "failed" for i in ids})

        try:
            after, _ = self._current(client, refresh=True)
        except ApiError as failure:
            results = [{"kind": i["kind"], "id": str(i["id"]), "label": i["label"],
                        "fields": sorted(i["patch"]),
                        "status": failed.get((i["kind"], i["id"]), "unverified")}
                       for i in plan["items"]]
            return {"results": results, "albums": None, "created_artists": created,
                    "error": error or f"Saved, but the library could not be read back: {failure}"}
        return {"results": verify(after, plan, artist_ids, failed), "albums": after.album_index(),
                "created_artists": created, "error": error}


__all__ = ["ApiError", "LibraryError", "NotConnected", "Studio", "StudioClient"]
