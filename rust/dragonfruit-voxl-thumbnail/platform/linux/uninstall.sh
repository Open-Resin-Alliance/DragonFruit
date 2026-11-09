#!/usr/bin/env bash
# Uninstall the thumbnail handler on Linux.
#   sudo ./platform/linux/uninstall.sh
set -euo pipefail

echo "Removing binary..."
rm -f /usr/local/bin/dragonfruit-voxl-thumbnailer

echo "Removing MIME types..."
rm -f /usr/share/mime/packages/dragonfruit.xml

echo "Removing thumbnailer..."
rm -f /usr/share/thumbnailers/dragonfruit.thumbnailer

echo "Updating MIME database..."
update-mime-database /usr/share/mime 2>/dev/null || true

echo "Clearing thumbnail cache..."
rm -rf "$HOME/.cache/thumbnails" 2>/dev/null || true

echo "Done. Thumbnail handler removed."
