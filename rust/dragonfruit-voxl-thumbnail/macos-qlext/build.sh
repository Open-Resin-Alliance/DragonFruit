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
# Build in /tmp to avoid iCloud Drive re-adding extended attributes
# (com.apple.fileprovider.fpfs#P etc.) which codesign rejects.
BUILD_DIR="/tmp/dragonfruit-qlext-build"
APPEX="$BUILD_DIR/VoxlThumbnailExtension.appex"
CONTENTS="$APPEX/Contents"
MACOS_DIR="$CONTENTS/MacOS"
# Final resting place inside the repo (for install.sh / tauri-build.mjs)
REPO_BUILD_DIR="$SCRIPT_DIR/build"

rm -rf "$APPEX"
mkdir -p "$MACOS_DIR"

# Compile the Swift extension once per arch, then lipo-merge into a single fat
# Mach-O. This must be universal: the .appex is embedded verbatim into the
# universal .app, so an arm64-only binary here silently breaks QuickLook
# thumbnails for Intel users of the universal DMG (the QL host can't load a
# thin-arm64 extension on an x86_64 machine).
SDK_PATH="$(xcrun --show-sdk-path --sdk macosx)"
SWIFT_SRC="$SCRIPT_DIR/Sources/VoxlThumbnailExtension/ThumbnailProvider.swift"

# shellcheck disable=SC2086  # framework flags are fixed, no word-splitting risk
compile_appex_arch() {
    local arch_target="$1"
    local out="$2"
    swiftc \
        -sdk "$SDK_PATH" \
        -target "$arch_target" \
        -framework QuickLookThumbnailing \
        -framework CoreGraphics \
        -framework ImageIO \
        -framework AppKit \
        -framework Foundation \
        -module-name VoxlThumbnailExtension \
        -parse-as-library \
        -Xlinker -e -Xlinker _NSExtensionMain \
        -o "$out" \
        "$SWIFT_SRC"
}

echo "Compiling ThumbnailProvider.swift for arm64..."
compile_appex_arch "arm64-apple-macos12.0" "$MACOS_DIR/VoxlThumbnailExtension.arm64"
echo "Compiling ThumbnailProvider.swift for x86_64..."
compile_appex_arch "x86_64-apple-macos12.0" "$MACOS_DIR/VoxlThumbnailExtension.x86_64"

echo "Merging into a universal (fat) Mach-O with lipo..."
lipo -create \
    "$MACOS_DIR/VoxlThumbnailExtension.arm64" \
    "$MACOS_DIR/VoxlThumbnailExtension.x86_64" \
    -output "$MACOS_DIR/VoxlThumbnailExtension"
rm -f "$MACOS_DIR/VoxlThumbnailExtension.arm64" "$MACOS_DIR/VoxlThumbnailExtension.x86_64"

echo "Copying Info.plist..."
cp "$SCRIPT_DIR/Sources/VoxlThumbnailExtension/Info.plist" "$CONTENTS/Info.plist"

# Replace $(PRODUCT_MODULE_NAME) placeholder in Info.plist
sed -i '' 's/$(PRODUCT_MODULE_NAME)/VoxlThumbnailExtension/g' "$CONTENTS/Info.plist"

echo "Stripping extended attributes..."
find "$APPEX" -exec xattr -c {} \; 2>/dev/null || true

echo "Signing (ad-hoc with sandbox entitlement)..."
ENTITLEMENTS="$SCRIPT_DIR/Sources/VoxlThumbnailExtension/VoxlThumbnailExtension.entitlements"
# Use Apple Development identity if available so the extension gets a Team ID
# (required for the QL system to load it). Falls back to ad-hoc for CI.
SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Apple Development:' | head -1 | awk '{print $2}' || true)
[ -z "$SIGN_IDENTITY" ] && SIGN_IDENTITY="-"
codesign --force --sign "$SIGN_IDENTITY" --entitlements "$ENTITLEMENTS" "$APPEX"

echo ""
echo "Built: $APPEX"

# Copy signed appex back into the repo's build/ dir so install.sh and
# tauri-build.mjs can find it at the expected path.
mkdir -p "$REPO_BUILD_DIR"
rm -rf "$REPO_BUILD_DIR/VoxlThumbnailExtension.appex"
cp -R "$APPEX" "$REPO_BUILD_DIR/"

echo ""
echo "For local dev install (registers via host app + pluginkit):"
echo "  npm run macos:thumbnails      # from the repo root"
echo "  # or: platform/macos/install.sh"
echo ""
echo "For Tauri app distribution, embed in:"
echo "  <app>.app/Contents/PlugIns/VoxlThumbnailExtension.appex"
