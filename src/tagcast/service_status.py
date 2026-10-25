"""Bounded public service health; independent of account, library and playback locks."""

import copy
import json
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

STATUS_URL = "https://status.ibroadcast.com/status.json"
PAGE_URL = "https://status.ibroadcast.com/"
REFRESH_SECONDS = 300
STALE_SECONDS = 900
MAX_BYTES = 64 * 1024
SERVICES = (("streaming", "Streaming", "Streaming"), ("api", "API Server", "API Server"),
            ("queue", "Play Queue", "Play Queue"), ("artwork", "Album Artwork", "Artwork"),
            ("library", "Library Generation", "Library Generation"))


class NoStatusRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def status_time(value):
    """The official page interprets its MySQL-formatted timestamps as UTC."""
    if not isinstance(value, str) or len(value) != 19:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def iso_status_time(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def public_text(value, limit=600):
    return value[:limit].strip() if isinstance(value, str) else ""


def read_status():
    request = Request(STATUS_URL, headers={"Accept": "application/json", "User-Agent": "Tagcast service status"})
    # No account client/session, credentials, redirects, library identifiers or persistence.
    with build_opener(NoStatusRedirect()).open(request, timeout=5) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Oversized status response")
    result = json.loads(data)
    if not isinstance(result, dict) or not isinstance(result.get("services"), dict):
        raise ValueError("Invalid status response")
    return result


class ServiceStatus:
    def __init__(self, fetch=read_status, clock=time.time, monotonic=time.monotonic):
        self.fetch, self.clock, self.monotonic = fetch, clock, monotonic
        self.lock = threading.Lock()
        self.payload = None
        self.attempt = None
        self.fetched = None
        self.checked = None
        self.error = ""

    def get(self, refresh=False):
        # A separate short-lived lock coalesces concurrent tabs. Never acquire Studio.lock.
        with self.lock:
            tick = self.monotonic()
            interval = 30 if refresh else REFRESH_SECONDS
            if self.attempt is None or tick - self.attempt >= interval:
                self.attempt = tick
                self.checked = self.clock()
                try:
                    payload = self.fetch()
                    if not isinstance(payload, dict) or not isinstance(payload.get("services"), dict):
                        raise ValueError("Invalid status response")
                    self.payload = copy.deepcopy(payload)
                    self.fetched = self.clock()
                    self.error = ""
                except (OSError, ValueError, TypeError, TimeoutError, HTTPError, URLError):
                    self.error = "The public status feed could not be checked. This does not mean iBroadcast is down."
            return self.snapshot()

    def snapshot(self):
        now, data = self.clock(), self.payload or {}
        reported = status_time(data.get("last_check"))
        def fresh(stamp):
            return stamp is not None and -300 <= now - stamp <= STALE_SECONDS
        stale = not fresh(reported) or self.fetched is None or now - self.fetched > STALE_SECONDS
        valid = not self.error and not stale
        services = []
        for identifier, key, label in SERVICES:
            row = data.get("services", {}).get(key)
            row = row if isinstance(row, dict) else {}
            stamp = status_time(row.get("last_check"))
            state = "unknown"
            available, raw = row.get("available"), row.get("status")
            if valid and fresh(stamp):
                if raw == "green" and available is True:
                    state = "operational"
                elif raw in ("outage", "red") and available is False:
                    state = "outage"
                elif raw in ("degraded", "yellow", "warning") and available is True:
                    state = "degraded"
            services.append({"id": identifier, "name": label, "state": state,
                             "reported_at": iso_status_time(stamp) if stamp is not None else None,
                             "details": public_text(row.get("issues")) if state in ("outage", "degraded") else ""})
        states = {s["state"] for s in services}
        overall = "outage" if "outage" in states else "degraded" if "degraded" in states else "unknown"
        if states == {"operational"} and data.get("status") == "green":
            overall = "operational"
        return {"overall": overall, "services": services, "stale": stale,
                "error": self.error, "message": public_text(data.get("message")),
                "checked_at": iso_status_time(self.checked) if self.checked is not None else None,
                "fetched_at": iso_status_time(self.fetched) if self.fetched is not None else None,
                "reported_at": iso_status_time(reported) if reported is not None else None,
                "refresh_seconds": REFRESH_SECONDS, "stale_seconds": STALE_SECONDS,
                "url": PAGE_URL}
