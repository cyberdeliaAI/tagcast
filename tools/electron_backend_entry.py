"""Frozen server entry point: no Tk launcher, browser launch or renderer bridge."""

from tagcast.electron_host import main

if __name__ == "__main__":
    raise SystemExit(main())
