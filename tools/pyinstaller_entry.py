"""What the PyInstaller program runs: Tagcast with --open, like the start scripts."""

import sys

from tagcast.app import main

if __name__ == "__main__":
    sys.exit(main(["--open", *sys.argv[1:]]))
