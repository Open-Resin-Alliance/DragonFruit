#!/usr/bin/env bash
# Install the thumbnail handler on Linux (GNOME / KDE / XFCE) for every file type
# the app declares.
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

# The MIME declaration and the thumbnailer entry cover every file type the app
# writes, and are generated from those declarations (`npm run generate:plugin-registry`)
# rather than maintained per format.
GENERATED_DIR="$SCRIPT_DIR/../../generated"

echo "Installing MIME types → $MIME_DIR/dragonfruit.xml"
install -Dm644 "$GENERATED_DIR/dragonfruit-mime.xml" "$MIME_DIR/dragonfruit.xml"

echo "Installing thumbnailer → $THUMBNAILER_DIR/dragonfruit.thumbnailer"
install -Dm644 "$GENERATED_DIR/dragonfruit.thumbnailer" "$THUMBNAILER_DIR/dragonfruit.thumbnailer"

echo "Updating MIME database..."
update-mime-database /usr/share/mime 2>/dev/null || true

echo "Clearing thumbnail cache..."
rm -rf "$HOME/.cache/thumbnails" 2>/dev/null || true

echo "Done. Thumbnails for every declared file type will appear after the next directory listing."
