#!/usr/bin/env bash
# Uninstall the VOXL thumbnail handler on macOS.
# Usage:  ./platform/macos/uninstall.sh
set -euo pipefail

HOST_APP="$HOME/Applications/DragonFruitQLHost.app"

echo "Removing CLI binary..."
sudo rm -f /usr/local/bin/dragonfruit-voxl-thumbnailer

echo "Removing QuickLook host app..."
if [ -d "$HOST_APP" ]; then
    pluginkit -r "$HOST_APP" 2>/dev/null || true
    rm -rf "$HOST_APP"
fi
# Also clean up any old-style install
rm -rf "$HOME/Library/QuickLook/VoxlThumbnailExtension.appex"

echo "Resetting QuickLook manager..."
qlmanage -r 2>/dev/null || true

echo "Done. VOXL thumbnail handler removed."
