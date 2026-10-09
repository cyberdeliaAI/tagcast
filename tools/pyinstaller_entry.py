"""Separate desktop and CLI executables share the bundled Tagcast application."""

import sys
from pathlib import Path

from tagcast import app, desktop

if __name__ == "__main__":
    if sys.argv[1:2] == ["--bundle-smoke-test"]:
        from bundle_check import run
        sys.exit(run(sys.argv[2:]))
    main = app.main if Path(sys.executable).stem == "tagcast-cli" else desktop.main
    sys.exit(main(sys.argv[1:]))
