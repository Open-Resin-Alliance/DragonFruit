#!/bin/sh
# Debian post-remove maintainer script.
# Runs after files are removed from disk.
set -e

case "$1" in
  remove|purge)
    # Refresh MIME database so the .voxl association is cleaned up.
    update-mime-database /usr/share/mime 2>/dev/null || true
    ;;
esac
