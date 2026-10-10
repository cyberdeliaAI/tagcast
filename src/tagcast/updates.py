"""Public GitHub release checks; never use iBroadcast or GitHub credentials."""

import json
import logging
import math
import re
import threading
import time

import requests

from . import __version__

RELEASE_API = "https://api.github.com/repos/cyberdeliaAI/tagcast/releases/latest"
RELEASE_PAGE = "https://github.com/cyberdeliaAI/tagcast/releases/tag/v"
CHECK_INTERVAL = 24 * 60 * 60
MAX_RESPONSE = 1024 * 1024
log = logging.getLogger("tagcast")


def version_order(version):
    """Compare the project's Python versions, including a beta before its final release."""
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:b(\d+))?", version)
    if not match:
        raise ValueError("Unsupported Tagcast version")
    major, minor, patch, beta = match.groups()
    return int(major), int(minor), int(patch), beta is None, int(beta or 0)


def release_info(data):
    """Keep only a stable version and a bounded label; construct our own release URL."""
    if not isinstance(data, dict) or data.get("draft") or data.get("prerelease"):
        raise ValueError("Not a stable release")
    tag = data.get("tag_name")
    if not isinstance(tag, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Unsupported release tag")
    version = tag[1:]
    version_order(version)
    name = data.get("name")
    return {"version": version, "name": name[:200] if isinstance(name, str) else f"Tagcast {version}"}


class UpdateChecker:
    """Serialize checks and persist attempts, including failures, across restarts."""

    def __init__(self, read, write):
        self.write = write
        self.lock = threading.Lock()
        self.cache = {}
        cached = read("updates.json")
        if isinstance(cached, dict):
            for key in ("attempted_at", "checked_at"):
                value = cached.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= time.time():
                    self.cache[key] = value
            latest = cached.get("latest")
            if isinstance(latest, dict):
                try:
                    self.cache["latest"] = release_info({"tag_name": f'v{latest.get("version")}', "name": latest.get("name")})
                except ValueError:
                    pass
            if cached.get("error"):
                self.cache["error"] = "Could not check for updates. Try again later or view GitHub releases."

    def _persist(self):
        try:
            self.write("updates.json", self.cache)
        except OSError:
            log.warning("Could not save the update cache; keeping it in memory.")

    def _result(self, enabled):
        latest = self.cache.get("latest")
        available = bool(latest and version_order(latest["version"]) > version_order(__version__))
        error = self.cache.get("error", "")
        state = "error" if error else "available" if available else "current" if latest else "unchecked" if enabled else "disabled"
        return {"current": __version__, "latest": latest["version"] if latest else None,
                "name": latest["name"] if latest else "", "available": available,
                "url": RELEASE_PAGE + latest["version"] if available else "",
                "checked_at": self.cache.get("checked_at"), "auto_updates": enabled,
                "state": state, "error": error}

    def check(self, enabled=True, manual=False):
        with self.lock:
            now = time.time()
            attempted = self.cache.get("attempted_at")
            if not manual and (not enabled or attempted is not None and 0 <= now - attempted < CHECK_INTERVAL):
                return self._result(enabled)
            self.cache["attempted_at"] = now
            self._persist()
            try:
                # No netrc credentials, cookies or iBroadcast session. Do not follow
                # redirects: the only destination is GitHub's public release API.
                with requests.Session() as session:
                    session.trust_env = False
                    with session.get(RELEASE_API, timeout=(3.05, 7), stream=True, allow_redirects=False,
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": f"Tagcast/{__version__}"}) as response:
                        if response.status_code != 200:
                            raise ValueError("Release check failed")
                        chunks, size = [], 0
                        for chunk in response.iter_content(8192):
                            size += len(chunk)
                            if size > MAX_RESPONSE:
                                raise ValueError("Release response too large")
                            chunks.append(chunk)
                        latest = release_info(json.loads(b"".join(chunks)))
                self.cache.update(latest=latest, checked_at=time.time())
                self.cache.pop("error", None)
            except (requests.RequestException, ValueError):
                self.cache["error"] = "Could not check for updates. Try again later or view GitHub releases."
            self._persist()
            return self._result(enabled)
