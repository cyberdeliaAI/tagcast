"""Explicit, account-scoped local checkpoints for up to ten CSV imports."""

import hashlib
import json
import math
import re

from .library import ConflictError, LibraryError

MAX_PAUSED = 10
MAX_PAUSED_BYTES = 64 * 1024 * 1024
COPY_PREFERENCES = {
    "manual": "Choose manually",
    "flac": "Prefer FLAC",
    "oldest": "Prefer oldest year",
    "first": "Choose first match",
    "flac_oldest": "FLAC first, then oldest year",
}
KEY = re.compile(r"[a-f0-9]{32}")
INVALID_UNICODE = re.compile(r"[\ud800-\udfff]")


def valid_text(value, maximum):
    return isinstance(value, str) and len(value) <= maximum and not INVALID_UNICODE.search(value)


def valid_checkpoint(row):
    if not isinstance(row, dict):
        return False
    if not isinstance(row.get("copy_preference", "manual"), str) or row.get("copy_preference", "manual") not in COPY_PREFERENCES:
        return False
    strings = {"name": 200, "description": 2000}
    if any(not valid_text(row.get(k), limit) for k, limit in strings.items()):
        return False
    if any(not isinstance(row.get(k), str) or not KEY.fullmatch(row[k]) for k in ("id", "token")):
        return False
    stamp = row.get("saved_at")
    if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp <= 0:
        return False
    if row.get("state") not in ("paused", "submitted") or row.get("phase") not in ("mapping", "matched"):
        return False
    if row.get("playlist") is not None and (type(row["playlist"]) is not int or not 0 < row["playlist"] < 10**32):
        return False
    if row.get("delimiter") not in (",", ";", "\t", "|") or row.get("duration_unit") not in ("seconds", "milliseconds") or row.get("artist_separator") not in ("", ";"):
        return False
    columns, records, choices, mapping = (row.get(k) for k in ("columns", "records", "choices", "mapping"))
    if not isinstance(columns, list) or not 2 <= len(columns) <= 100 or any(not valid_text(c, 2000) for c in columns):
        return False
    if not isinstance(records, list) or not 1 <= len(records) <= 10000:
        return False
    for record in records:
        if not isinstance(record, dict) or type(record.get("line")) is not int or record["line"] <= 0:
            return False
        cells = record.get("cells")
        if not isinstance(cells, list) or len(cells) != len(columns) or any(not valid_text(c, 2000) for c in cells):
            return False
    fields = {"title", "artist", "album", "album_artist", "duration", "year", "track"}
    if not isinstance(mapping, dict) or set(mapping) - fields or any(v is not None and (type(v) is not int or not 0 <= v < len(columns)) for v in mapping.values()):
        return False
    if type(row.get("blanks")) is not int or row["blanks"] < 0 or type(row.get("offset")) is not int or row["offset"] < 0:
        return False
    if row.get("show") not in ("all", "unresolved", "automatic", "manual", "skipped") or not isinstance(choices, list) or len(choices) > len(records):
        return False
    if type(row.get("unresolved")) is not int or not 0 <= row["unresolved"] <= len(records):
        return False
    seen = set()
    for choice in choices:
        if not isinstance(choice, dict) or type(choice.get("position")) is not int or not 0 <= choice["position"] < len(records) or choice["position"] in seen:
            return False
        seen.add(choice["position"])
        if choice.get("status") == "skipped":
            continue
        if choice.get("status") != "manual" or type(choice.get("choice")) is not int or not 0 < choice["choice"] < 10**32 or not isinstance(choice.get("signature"), str) or not re.fullmatch(r"[a-f0-9]{64}", choice["signature"]):
            return False
    return True


class PausedImports:
    def __init__(self, studio):
        self.studio = studio

    @staticmethod
    def filename(account):
        return "playlist-imports-" + hashlib.sha256(account.encode()).hexdigest()[:32] + ".json"

    def load(self, account):
        path = self.studio.home / self.filename(account)
        try:
            if not path.exists():
                return {}
            if path.stat().st_size > MAX_PAUSED_BYTES:
                raise ValueError
            data = json.loads(path.read_text(encoding="utf-8"))
            rows = data["imports"]
            if data["version"] != 1 or data["account"] != account or not isinstance(rows, list) or len(rows) > MAX_PAUSED or any(not valid_checkpoint(r) for r in rows) or len({r["id"] for r in rows}) != len(rows):
                raise ValueError
            return {row["id"]: row for row in rows}
        except (OSError, ValueError, KeyError, TypeError):
            raise LibraryError("The saved imports could not be read. The local file has been left unchanged.") from None

    def write(self, account, rows):
        try:
            data = json.dumps({"version": 1, "account": account, "imports": list(rows.values())},
                              ensure_ascii=False, separators=(",", ":")).encode()
        except UnicodeError:
            raise LibraryError("The saved import contains invalid Unicode. Check its name and description.") from None
        if len(rows) > MAX_PAUSED or len(data) > MAX_PAUSED_BYTES:
            raise LibraryError("Keep up to 10 paused imports / 64 MB per account. Remove a saved import first.")
        try:
            self.studio._write_bytes(self.filename(account), data)
        except OSError:
            raise LibraryError("The import could not be saved locally. Your open draft is still available.") from None

    @staticmethod
    def selected(rows, body):
        row = rows.get(body.get("saved_id")) if isinstance(body.get("saved_id"), str) else None
        if not row or row["token"] != body.get("saved_token"):
            raise ConflictError("This saved import changed or was removed. Open Paused imports again.")
        return row
