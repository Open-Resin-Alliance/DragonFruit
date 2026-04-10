#!/usr/bin/env bash
# Install the VOXL thumbnail handler on Linux (GNOME / KDE / XFCE).
#
# Run from the repo root after building:
#   cargo build --release -p dragonfruit-voxl-thumbnail
#   sudo ./platform/linux/install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN_SRC="$CRATE_ROOT/target/release/dragonfruit-voxl-thumbnailer"

if [ ! -f "$BIN_SRC" ]; then
  echo "error: $BIN_SRC not found — build with: cargo build --release" >&2
  exit 1
fi

INSTALL_BIN="/usr/local/bin/dragonfruit-voxl-thumbnailer"
MIME_DIR="/usr/share/mime/packages"
THUMBNAILER_DIR="/usr/share/thumbnailers"

echo "Installing binary → $INSTALL_BIN"
install -Dm755 "$BIN_SRC" "$INSTALL_BIN"

echo "Installing MIME type → $MIME_DIR/dragonfruit-voxl.xml"
install -Dm644 "$SCRIPT_DIR/dragonfruit-voxl.xml" "$MIME_DIR/dragonfruit-voxl.xml"

echo "Installing thumbnailer → $THUMBNAILER_DIR/dragonfruit-voxl.thumbnailer"
install -Dm644 "$SCRIPT_DIR/dragonfruit-voxl.thumbnailer" "$THUMBNAILER_DIR/dragonfruit-voxl.thumbnailer"

echo "Updating MIME database..."
update-mime-database /usr/share/mime 2>/dev/null || true

echo "Clearing thumbnail cache..."
rm -rf "$HOME/.cache/thumbnails" 2>/dev/null || true

echo "Done. VOXL thumbnails will appear after the next directory listing."
