"""Check the actual frozen launcher and HTTP assets with temporary settings."""

import json
import logging
import os
import re
import sys
import tempfile
import traceback
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def page_scripts(page, static):
    """Require every page script exactly once and include no unused bundled scripts."""
    scripts = re.findall(r'<script\s+src="([^"]+\.js)"', page)
    bundled = {path.name for path in static.glob("*.js")}
    if not scripts or len(scripts) != len(set(scripts)) or set(scripts) != bundled:
        raise RuntimeError("The bundled page scripts are incomplete or inconsistent")
    return scripts


def run(args):
    if len(args) != 1:
        return 2
    report = Path(args[0]).resolve()
    result = {}
    launcher = root = None
    previous = os.environ.get("TAGCAST_HOME")
    try:
        if not getattr(sys, "frozen", False):
            raise RuntimeError("Run this check from a frozen executable")
        import tkinter as tk

        import certifi

        from tagcast import __version__, app, desktop

        if not Path(certifi.where()).is_file():
            raise RuntimeError("Bundled HTTPS certificates are missing")
        with tempfile.TemporaryDirectory(prefix="tagcast bundle settings ") as directory:
            try:
                os.environ["TAGCAST_HOME"] = directory
                root = tk.Tk()
                root.withdraw()
                launcher = desktop.Desktop(root, port=0, open_browser=False)
                root.update()
                if not launcher.ready or not launcher.server or not hasattr(launcher, "icon"):
                    raise RuntimeError("The desktop launcher or its icon did not start")

                def get(path, headers=None):
                    with urlopen(Request(launcher.url + path, headers=headers or {}), timeout=5) as response:
                        return response.read(), response.headers.get_content_type()

                status = json.loads(get("/api/status")[0])
                if status["connected"]:
                    raise RuntimeError("The check must not connect to an account")
                page = get("/")[0].decode()
                display = re.sub(r"b(\d+)$", r" beta \1", __version__)
                if f'<span class="pill">{display}</span>' not in page:
                    raise RuntimeError("The bundled page version does not match the executable")
                scripts = page_scripts(page, app.STATIC)
                for name in [*scripts, "style.css", "dark.css", "tagcast-mark.svg", "tagcast-icon.png"]:
                    data, mime = get("/" + name)
                    if not data or (name.endswith(".js") and mime != "text/javascript"):
                        raise RuntimeError(f"The bundled static file is not served correctly: {name}")
                for path, headers, expected in [("/api/tracks?q=test", {}, 401),
                                                 ("/api/status", {"Sec-Fetch-Site": "cross-site"}, 403),
                                                 ("/api/status", {"Host": "example.test"}, 403)]:
                    try:
                        get(path, headers)
                    except HTTPError as error:
                        if error.code != expected:
                            raise
                    else:
                        raise RuntimeError(f"Expected HTTP {expected}: {path}")
                result = {"ok": True, "version": __version__, "platform": sys.platform,
                          "tk": root.tk.call("info", "patchlevel"), "scripts": scripts,
                          "http_assets": True, "security_guards": True}
                launcher.close()
                launcher = root = None
            finally:
                if launcher is not None:
                    launcher.close()
                    launcher = root = None
                elif root is not None:
                    root.destroy()
                    root = None
                # Windows cannot remove an open log file with its temporary settings.
                logging.shutdown()
    except Exception:
        result = {"ok": False, "error": traceback.format_exc()}
    finally:
        if launcher is not None:
            launcher.close()
        elif root is not None:
            root.destroy()
        if previous is None:
            os.environ.pop("TAGCAST_HOME", None)
        else:
            os.environ["TAGCAST_HOME"] = previous
    report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return 0 if result.get("ok") else 1
