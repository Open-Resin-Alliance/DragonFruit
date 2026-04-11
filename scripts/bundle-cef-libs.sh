#!/bin/bash
# bundle-cef-libs.sh — Copy CEF shared libraries next to the binary so Tauri's
# AppImage bundler picks them up. Called via beforeBundleCommand in
# tauri.linux.conf.json.
#
# Tauri's AppImage sets LD_LIBRARY_PATH to include the binary directory,
# so placing .so files alongside dragonfruit-desktop is sufficient.

set -euo pipefail

BINARY_DIR="src-tauri/target/release"

CEF_OUT=$(find "$BINARY_DIR/build" -path '*/cef-dll-sys-*/out/cef_linux_x86_64' -type d 2>/dev/null | head -1)

if [ -z "$CEF_OUT" ]; then
    echo "[bundle-cef-libs] No CEF output directory found — skipping (wry build?)"
    exit 0
fi

echo "[bundle-cef-libs] Found CEF libs at: $CEF_OUT"

# .so files are required for CEF runtime
cp -av "$CEF_OUT"/*.so "$BINARY_DIR/"

# Resource files (ICU data, V8 snapshots, Chromium paks, locales)
cp -av "$CEF_OUT"/*.bin "$BINARY_DIR/" 2>/dev/null || true
cp -av "$CEF_OUT"/*.dat "$BINARY_DIR/" 2>/dev/null || true
cp -av "$CEF_OUT"/*.pak "$BINARY_DIR/" 2>/dev/null || true
if [ -d "$CEF_OUT/locales" ]; then
    cp -av "$CEF_OUT/locales" "$BINARY_DIR/"
fi

echo "[bundle-cef-libs] Done — CEF libs staged for AppImage bundling"
