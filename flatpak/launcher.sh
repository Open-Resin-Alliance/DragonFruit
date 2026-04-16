#!/bin/sh
# /app/bin/dragonfruit — Flatpak launcher wrapper for DragonFruit.
#
# CEF inside Flatpak notes:
#   --no-sandbox            CEF SUID-sandbox needs setuid root on chrome-sandbox;
#                           Flatpak cannot grant it. bwrap already sandboxes, so
#                           stacking is infeasible and unnecessary.
#   --disable-dev-shm-usage Flatpak's per-app /dev/shm can be tight; falls back
#                           to /tmp which is backed by the app's writable layer.
#   --ozone-platform-hint=auto  Picks Wayland when $WAYLAND_DISPLAY is set,
#                               falls back to X11 via --socket=fallback-x11.
#
# CEF runtime data lives under /app/lib/dragonfruit/cef/. The bundled libcef.so
# and friends are resolved via LD_LIBRARY_PATH, not rpath, to avoid relinking.

set -e

DF_LIB=/app/lib/dragonfruit
export LD_LIBRARY_PATH="$DF_LIB/cef:${LD_LIBRARY_PATH:-}"

# Suppress the "chrome-sandbox not SUID" warning spam even though --no-sandbox
# means it isn't consulted. Harmless; improves log signal.
export CHROME_DEVEL_SANDBOX="$DF_LIB/cef/chrome-sandbox"

exec "$DF_LIB/dragonfruit-desktop" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --ozone-platform-hint=auto \
    --enable-features=UseOzonePlatform,WaylandWindowDecorations \
    "$@"
