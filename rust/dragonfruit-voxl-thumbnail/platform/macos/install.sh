#!/usr/bin/env bash
# Install the VOXL thumbnail handler on macOS.
#
# This installs:
#   1. The CLI thumbnailer binary to /usr/local/bin/
#   2. The QuickLook extension into a minimal host app at
#      ~/Applications/DragonFruitQLHost.app and registers it with pluginkit.
#
# Modern macOS (.appex) Quick Look extensions must live inside an app bundle
# registered with pluginkit — ~/Library/QuickLook/ is for the old .qlgenerator
# format only.
#
# ── CODE SIGNING NOTE ────────────────────────────────────────────────────────
# macOS 13+ requires extensions loaded by system daemons (quicklookd, Finder)
# to pass Gatekeeper assessment, which means Developer ID signing + notariza-
# tion.  For local dev testing with only an Apple Development cert you must
# temporarily disable Gatekeeper assessment before the extension will be used:
#
#   sudo spctl --master-disable   # disable Gatekeeper assessment
#   npm run macos:thumbnails      # install / reinstall
#   # test thumbnails in Finder
#   sudo spctl --master-enable    # re-enable when done
#
# In the production DragonFruit.app (signed with Developer ID via the Tauri
# build pipeline) the extension is embedded inside the app bundle and does
# not need this workaround.
# ─────────────────────────────────────────────────────────────────────────────
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
HOST_APP="$HOME/Applications/DragonFruitQLHost.app"

# 1. Install CLI binary
if [ -f "$BIN_SRC" ]; then
    echo "Installing thumbnailer binary → /usr/local/bin/"
    sudo install -m 755 "$BIN_SRC" /usr/local/bin/dragonfruit-voxl-thumbnailer
else
    echo "warning: CLI binary not found at $BIN_SRC (skipping)"
    echo "  Build with: cargo build --release -p dragonfruit-voxl-thumbnail"
fi

# 2. Install QuickLook extension into a minimal host app
if [ -d "$APPEX_SRC" ]; then
    echo "Creating host app → $HOST_APP"
    mkdir -p "$HOME/Applications"
    rm -rf "$HOST_APP"
    mkdir -p "$HOST_APP/Contents/MacOS" "$HOST_APP/Contents/PlugIns"

    # Minimal stub binary (the host app itself does nothing; it only exists to
    # give pluginkit a bundle to register the extension from)
    echo 'int main(){return 0;}' | \
        xcrun clang -x c - -target arm64-apple-macos12.0 \
        -o "$HOST_APP/Contents/MacOS/DragonFruitQLHost"

    # Host app Info.plist — exports the same UTIs the generated extension declares,
    # so files get a stable identifier instead of the dynamic dyn.* one. This is what
    # QLSupportedContentTypes in the extension matches against. The block is written
    # by the registry generator from the output file types themselves.
    cat > "$HOST_APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>org.openresinalliance.dragonfruit.ql-host</string>
    <key>CFBundleName</key>
    <string>DragonFruitQLHost</string>
    <key>CFBundleExecutable</key>
    <string>DragonFruitQLHost</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <!-- GENERATED-UTIS -->
</dict>
</plist>
PLIST

    # The exported UTI block comes from the declarations the extension is built from
    # (`rust/dragonfruit-voxl-thumbnail/generated/`), so a new file type reaches the
    # host app without this script being edited.
    awk -v block="$(cat "$CRATE_ROOT/generated/macos-exported-utis.plist")" \
        '{ if ($0 == "    <!-- GENERATED-UTIS -->") print block; else print }' \
        "$HOST_APP/Contents/Info.plist" > "$HOST_APP/Contents/Info.plist.spliced"
    mv "$HOST_APP/Contents/Info.plist.spliced" "$HOST_APP/Contents/Info.plist"

    # Embed the extension
    cp -R "$APPEX_SRC" "$HOST_APP/Contents/PlugIns/"

    # Strip xattrs, sign appex with sandbox entitlement, then sign host app.
    # NOTE: do NOT use --deep on the host app — it would re-sign the appex
    #       without entitlements, stripping the sandbox flag that the QL
    #       system requires to create a per-request sandbox token.
    xattr -rc "$HOST_APP"
    # Use Apple Development identity if available (required for Team ID;
    # ad-hoc signing is rejected by the QL extension host).  Falls back to
    # ad-hoc for CI environments that lack a signing cert.
    SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Apple Development:' | head -1 | awk '{print $2}')
    [ -z "$SIGN_IDENTITY" ] && SIGN_IDENTITY="-"
    ENTITLEMENTS="$CRATE_ROOT/macos-qlext/Sources/VoxlThumbnailExtension/VoxlThumbnailExtension.entitlements"
    codesign --force --sign "$SIGN_IDENTITY" --entitlements "$ENTITLEMENTS" \
        "$HOST_APP/Contents/PlugIns/VoxlThumbnailExtension.appex"
    codesign --force --sign "$SIGN_IDENTITY" "$HOST_APP"

    # Register with pluginkit immediately (macOS will also auto-discover from
    # ~/Applications on the next background scan)
    echo "Registering with pluginkit..."
    pluginkit -a "$HOST_APP" 2>/dev/null || true

    echo "Registering UTI and resetting QuickLook..."
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -f -R "$HOST_APP" 2>/dev/null || true
    qlmanage -r 2>/dev/null || true
    # Kick Launch Services so Finder picks up the UTI
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -f "$HOST_APP" 2>/dev/null || true
else
    echo "warning: QuickLook extension not found at $APPEX_SRC (skipping)"
    echo "  Build with: cd macos-qlext && ./build.sh"
fi

echo ""
echo "Done. Thumbnails will appear for .voxl and .lumen files in Finder."
echo "(You may need to log out and back in, or reboot, for Finder to pick up"
echo " the extension the first time.)"
