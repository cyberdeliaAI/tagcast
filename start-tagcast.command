#!/bin/sh
# macOS: double-click this file in Finder to start Tagcast. Close the window to stop it.
cd "$(dirname "$0")" && ./start-tagcast.sh "$@"
status=$?
if [ $status -ne 0 ]; then
  printf "\nPress Enter to close this window."
  read -r _
fi
exit $status
