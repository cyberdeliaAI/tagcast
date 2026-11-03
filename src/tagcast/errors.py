"""Stable, machine-readable codes beside Tagcast's canonical English error text.

The English message stays the single text for logs, tests, saved history and reports.
A code is optional; the browser may translate a known code and otherwise shows the
message unchanged. No code ever changes how an error is handled.
"""

import re

_CODE = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*")


class CodedError(Exception):
    """Accepts an optional `code` and plain `params` without changing str(error)."""

    def __init__(self, *args, code=None, params=None):
        super().__init__(*args)
        if code is not None and (not isinstance(code, str) or len(code) > 64 or not _CODE.fullmatch(code)):
            raise ValueError("Invalid error code")
        self.code = code
        self.params = {str(key): value for key, value in (params or {}).items()
                       if isinstance(value, (str, int, float, bool))}


def error_payload(error, **extra):
    """The JSON body for a user-facing error: English text first, an optional code after."""
    payload = {"error": str(error), **extra}
    code = getattr(error, "code", None)
    if code:
        payload["code"] = code
        if getattr(error, "params", None):
            payload["params"] = error.params
    return payload
