#!/usr/bin/env bash
# Build the macOS QuickLook Thumbnail Extension for VOXL files.
#
# Prerequisites:
#   - Xcode command-line tools (xcrun, swiftc)
#   - The CLI thumbnailer binary (see ../Cargo.toml)
#
# Usage:
#   cd macos-qlext && ./build.sh
#
# Output:
#   ./build/VoxlThumbnailExtension.appex
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APPEX="$BUILD_DIR/VoxlThumbnailExtension.appex"
CONTENTS="$APPEX/Contents"
MACOS_DIR="$CONTENTS/MacOS"

rm -rf "$APPEX"
mkdir -p "$MACOS_DIR"

echo "Compiling ThumbnailProvider.swift..."
swiftc \
    -sdk "$(xcrun --show-sdk-path --sdk macosx)" \
    -target arm64-apple-macos12.0 \
    -framework QuickLookThumbnailing \
    -framework AppKit \
    -framework Foundation \
    -module-name VoxlThumbnailExtension \
    -emit-library \
    -o "$MACOS_DIR/VoxlThumbnailExtension" \
    "$SCRIPT_DIR/Sources/VoxlThumbnailExtension/ThumbnailProvider.swift"

echo "Copying Info.plist..."
cp "$SCRIPT_DIR/Sources/VoxlThumbnailExtension/Info.plist" "$CONTENTS/Info.plist"

# Replace $(PRODUCT_MODULE_NAME) placeholder in Info.plist
sed -i '' 's/$(PRODUCT_MODULE_NAME)/VoxlThumbnailExtension/g' "$CONTENTS/Info.plist"

echo "Signing (ad-hoc)..."
codesign --force --sign - "$APPEX"

echo ""
echo "Built: $APPEX"
echo ""
echo "To install into the current user's QuickLook plugins:"
echo "  cp -R $APPEX ~/Library/QuickLook/"
echo "  qlmanage -r"
echo ""
echo "For Tauri app distribution, embed in:"
echo "  <app>.app/Contents/PlugIns/VoxlThumbnailExtension.appex"
