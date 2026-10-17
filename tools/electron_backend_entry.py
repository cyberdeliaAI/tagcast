"""Frozen Electron host and browser CLI share the same Python runtime."""

import sys
from pathlib import Path

from tagcast import app, electron_host

if __name__ == "__main__":
    main = app.main if Path(sys.executable).stem == "tagcast-cli" else electron_host.main
    raise SystemExit(main(sys.argv[1:]))
