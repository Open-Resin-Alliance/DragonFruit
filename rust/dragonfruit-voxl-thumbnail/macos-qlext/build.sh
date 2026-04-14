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
    -parse-as-library \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$MACOS_DIR/VoxlThumbnailExtension" \
    "$SCRIPT_DIR/Sources/VoxlThumbnailExtension/ThumbnailProvider.swift"

echo "Copying Info.plist..."
cp "$SCRIPT_DIR/Sources/VoxlThumbnailExtension/Info.plist" "$CONTENTS/Info.plist"

# Replace $(PRODUCT_MODULE_NAME) placeholder in Info.plist
sed -i '' 's/$(PRODUCT_MODULE_NAME)/VoxlThumbnailExtension/g' "$CONTENTS/Info.plist"

echo "Stripping extended attributes..."
# xattr -rc can miss com.apple.FinderInfo / com.apple.ResourceFork on some
# files; using find + xattr -c is more reliable.
find "$APPEX" -exec xattr -c {} \; 2>/dev/null || true

echo "Signing (ad-hoc with sandbox entitlement)..."
ENTITLEMENTS="$SCRIPT_DIR/Sources/VoxlThumbnailExtension/VoxlThumbnailExtension.entitlements"
# Use Apple Development identity if available so the extension gets a Team ID
# (required for the QL system to load it). Falls back to ad-hoc for CI.
SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Apple Development:' | head -1 | awk '{print $2}')
[ -z "$SIGN_IDENTITY" ] && SIGN_IDENTITY="-"
codesign --force --sign "$SIGN_IDENTITY" --entitlements "$ENTITLEMENTS" "$APPEX"

echo ""
echo "Built: $APPEX"
echo ""
echo "For local dev install (registers via host app + pluginkit):"
echo "  npm run macos:thumbnails      # from the repo root"
echo "  # or: platform/macos/install.sh"
echo ""
echo "For Tauri app distribution, embed in:"
echo "  <app>.app/Contents/PlugIns/VoxlThumbnailExtension.appex"
