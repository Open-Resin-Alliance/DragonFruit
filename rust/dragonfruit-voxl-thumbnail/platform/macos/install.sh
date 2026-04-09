#!/usr/bin/env bash
# Install the VOXL thumbnail handler on macOS.
#
# This installs:
#   1. The CLI thumbnailer binary to /usr/local/bin/
#   2. The QuickLook extension to ~/Library/QuickLook/
#
# Usage:
#   cargo build --release -p dragonfruit-voxl-thumbnail
#   cd macos-qlext && ./build.sh
#   ./platform/macos/install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BIN_SRC="$CRATE_ROOT/target/release/dragonfruit-voxl-thumbnailer"
APPEX_SRC="$CRATE_ROOT/macos-qlext/build/VoxlThumbnailExtension.appex"

# 1. Install CLI binary
if [ -f "$BIN_SRC" ]; then
    echo "Installing thumbnailer binary → /usr/local/bin/"
    sudo install -m 755 "$BIN_SRC" /usr/local/bin/dragonfruit-voxl-thumbnailer
else
    echo "warning: CLI binary not found at $BIN_SRC (skipping)"
    echo "  Build with: cargo build --release -p dragonfruit-voxl-thumbnail"
fi

# 2. Install QuickLook extension
if [ -d "$APPEX_SRC" ]; then
    QL_DIR="$HOME/Library/QuickLook"
    mkdir -p "$QL_DIR"
    echo "Installing QuickLook extension → $QL_DIR/"
    cp -R "$APPEX_SRC" "$QL_DIR/"
    echo "Resetting QuickLook manager..."
    qlmanage -r 2>/dev/null || true
else
    echo "warning: QuickLook extension not found at $APPEX_SRC (skipping)"
    echo "  Build with: cd macos-qlext && ./build.sh"
fi

echo ""
echo "Done. Thumbnails will appear for .voxl files in Finder."
