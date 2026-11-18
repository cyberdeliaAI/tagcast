"""Create version-pinned native update feeds from already verified release packages."""

import base64
import hashlib
import json
import re
from pathlib import Path


def update_metadata(downloads, version):
    """JSON is also YAML; keep feeds deterministic and filenames strictly local."""
    if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}', version):
        raise ValueError('Update feeds require a stable release version.')
    groups = {
        "latest-mac.yml": [f"tagcast-{version}-macos-arm64.zip", f"tagcast-{version}-macos-x64.zip"],
        "latest.yml": [f"tagcast-{version}-windows-x64-setup.exe"],
        "latest-linux.yml": [f"tagcast-{version}-linux-amd64.deb"],
    }
    result = {}
    for name, packages in groups.items():
        files = []
        for package in packages:
            path = Path(downloads) / package
            if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 2 * 1024**3:
                raise ValueError("Update packages must be bounded regular files.")
            with path.open("rb") as source:
                digest = base64.b64encode(hashlib.file_digest(source, "sha512").digest()).decode("ascii")
            files.append({"url": package, "sha512": digest, "size": path.stat().st_size})
        result[name] = json.dumps({"version": version, "files": files,
                                  "path": files[0]["url"], "sha512": files[0]["sha512"]},
                                 indent=2) + "\n"
    return result
