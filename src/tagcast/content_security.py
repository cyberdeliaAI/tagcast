"""Shared browser/Electron CSP rules, with hashes of the exact served HTML body."""

import base64
import hashlib
import json
import re
from pathlib import Path

RULES = json.loads((Path(__file__).parent / "static/content-security-policy.json").read_text(encoding="utf-8"))
SCRIPTS = re.compile(r"<script\b[^>]*>([\s\S]*?)</script>", re.IGNORECASE)


def content_policy(page=b""):
    """Only trusted static HTML goes here; never hash request/metadata/error input.

    HTML parsing normalises CRLF/CR to LF before checking script hashes. Preserve
    all remaining script whitespace; hashing a stripped block would not authorise it.
    """
    source = page.decode("utf-8") if isinstance(page, bytes) else page
    source = source.replace("\r\n", "\n").replace("\r", "\n")
    hashes = list(dict.fromkeys("'sha256-" + base64.b64encode(
        hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii") + "'"
        for script in SCRIPTS.findall(source) if script.strip()))
    return "; ".join(name + " " + " ".join(values + (hashes if name == "script-src" else []))
                     for name, values in RULES.items())


BASE_POLICY = content_policy()
