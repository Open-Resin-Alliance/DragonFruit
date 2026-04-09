#!/usr/bin/env bash
# Uninstall the VOXL thumbnail handler on macOS.
# Usage:  ./platform/macos/uninstall.sh
set -euo pipefail

echo "Removing CLI binary..."
sudo rm -f /usr/local/bin/dragonfruit-voxl-thumbnailer

echo "Removing QuickLook extension..."
rm -rf "$HOME/Library/QuickLook/VoxlThumbnailExtension.appex"

echo "Resetting QuickLook manager..."
qlmanage -r 2>/dev/null || true

echo "Done. VOXL thumbnail handler removed."
