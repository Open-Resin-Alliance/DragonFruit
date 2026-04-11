#!/bin/sh
# Flatpak launcher — ensures the dynamic linker finds CEF shared libraries.
export LD_LIBRARY_PATH="/app/lib/cef${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec /app/bin/dragonfruit-desktop "$@"
