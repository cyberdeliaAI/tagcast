"""Interface languages offered by the bundled catalogs. Only the local choice is stored."""

import json
from functools import lru_cache
from pathlib import Path

MANIFEST = Path(__file__).with_name("static") / "i18n" / "manifest.json"


@lru_cache(maxsize=1)
def interface_languages():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return tuple(language["tag"] for language in data["languages"])


def valid_interface_language(value):
    return isinstance(value, str) and (value == "auto" or value in interface_languages())
