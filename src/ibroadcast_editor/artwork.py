"""Get images for covers and artist pictures: from a URL or an uploaded file.

Images are checked before anything is sent to iBroadcast: only JPEG, PNG, WebP
and GIF, at most MAX_IMAGE bytes. URLs come from metadata sources, so they must
use http(s) and may not point at this computer or the local network.
"""

import base64
import binascii
import ipaddress
import socket
from urllib.parse import urlparse

import requests

MAX_IMAGE = 15 * 1024 * 1024
TIMEOUT = 30
USER_AGENT = "LibraryStudio (+https://github.com/cyberdeliaAI/ibroadcast-library-studio)"


class ArtworkError(ValueError):
    pass


def sniff(data):
    """The image type from the file's first bytes, or None."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def checked(data, name="artwork"):
    """Return (data, filename, mime) for a valid image, or raise ArtworkError."""
    if not data:
        raise ArtworkError("The image is empty.")
    if len(data) > MAX_IMAGE:
        raise ArtworkError(f"Images can be at most {MAX_IMAGE // (1024 * 1024)} MB.")
    mime = sniff(data)
    if not mime:
        raise ArtworkError("This is not a JPEG, PNG, WebP or GIF image.")
    stem = "".join(c for c in str(name).rsplit(".", 1)[0] if c.isalnum() or c in "-_ ")[:60]
    return data, f"{stem.strip() or 'artwork'}.{EXTENSIONS[mime]}", mime


def from_data_url(value, name="artwork"):
    """Decode a browser data URL (data:image/...;base64,...) or plain base64."""
    if not isinstance(value, str) or not value:
        raise ArtworkError("No image was attached.")
    payload = value.split(",", 1)[1] if value.startswith("data:") else value
    if len(payload) > MAX_IMAGE * 4 // 3 + 4:
        raise ArtworkError(f"Images can be at most {MAX_IMAGE // (1024 * 1024)} MB.")
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise ArtworkError("The attached image could not be read.") from None
    return checked(data, name)


def _public_host(host):
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise ArtworkError(f"Could not find the image server “{host}”.") from None
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if not address.is_global:
            return False
    return True


def from_url(url, allow_private=False):
    """Download an image. Redirects are followed by hand so every hop is checked."""
    session = requests.Session()
    for _ in range(5):
        parsed = urlparse(str(url or ""))
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ArtworkError("Use an http or https image address.")
        if not allow_private and not _public_host(parsed.hostname):
            raise ArtworkError("Images on this computer or the local network can't be used.")
        try:
            response = session.get(url, stream=True, timeout=TIMEOUT, allow_redirects=False,
                                   headers={"User-Agent": USER_AGENT, "Accept": "image/*"})
        except requests.RequestException as error:
            raise ArtworkError(f"Could not download the image ({error.__class__.__name__}).") from None
        with response:
            if response.is_redirect:
                url = requests.compat.urljoin(url, response.headers.get("Location", ""))
                continue
            if not response.ok:
                raise ArtworkError(f"The image server returned HTTP {response.status_code}.")
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > MAX_IMAGE:
                    raise ArtworkError(f"Images can be at most {MAX_IMAGE // (1024 * 1024)} MB.")
        name = parsed.path.rsplit("/", 1)[-1] or "artwork"
        return checked(bytes(data), name)
    raise ArtworkError("The image address redirects too often.")
