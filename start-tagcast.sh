#!/bin/sh
# Start Tagcast and open it in your browser (macOS and Linux).
# Uses uv when it's installed (set TAGCAST_NO_UV=1 to skip it); otherwise Python 3.11+
# and a .venv next to this script.
cd "$(dirname "$0")" || exit 1

if [ -z "$TAGCAST_NO_UV" ] && command -v uv >/dev/null 2>&1; then
  exec uv run tagcast --open "$@"
fi

PYTHON=$(command -v python3 || command -v python)
if [ -z "$PYTHON" ] || ! "$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
  echo "Tagcast needs Python 3.11 or newer, or uv."
  echo "  Python: https://www.python.org/downloads/"
  echo "  uv:     https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
fi

if [ ! -x .venv/bin/tagcast ]; then
  echo "First start: installing Tagcast in $(pwd)/.venv …"
  "$PYTHON" -m venv .venv \
    && .venv/bin/python -m pip install --quiet --upgrade pip \
    && .venv/bin/python -m pip install --quiet -e . \
    || { echo "Installing Tagcast failed. See the messages above."; exit 1; }
fi

exec .venv/bin/tagcast --open "$@"
