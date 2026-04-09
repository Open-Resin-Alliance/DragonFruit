#!/bin/sh
# Debian post-install maintainer script.
# Runs after files are placed on disk.
set -e

case "$1" in
  configure)
    # Refresh the system MIME database so file managers recognise .voxl files.
    update-mime-database /usr/share/mime 2>/dev/null || true
    ;;
esac
