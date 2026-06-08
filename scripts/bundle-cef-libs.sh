#!/bin/bash
# bundle-cef-libs.sh — Copy CEF shared libraries next to the binary so Tauri's
# AppImage bundler picks them up. Called via beforeBundleCommand in
# tauri.linux.conf.json.
#
# Tauri's AppImage sets LD_LIBRARY_PATH to include the binary directory,
# so placing .so files alongside dragonfruit-desktop is sufficient.

set -euo pipefail

BINARY_NAME="dragonfruit-desktop"

declare -a CANDIDATE_DIRS=()

# Prefer explicit target when provided.
if [ -n "${CARGO_BUILD_TARGET:-}" ] && [ -d "src-tauri/target/${CARGO_BUILD_TARGET}/release" ]; then
    CANDIDATE_DIRS+=("src-tauri/target/${CARGO_BUILD_TARGET}/release")
fi

# Keep the historical default path in the candidate set.
if [ -d "src-tauri/target/release" ]; then
    CANDIDATE_DIRS+=("src-tauri/target/release")
fi

# Also scan target-triple release dirs (covers --target builds in CI).
for dir in src-tauri/target/*/release; do
    [ -d "$dir" ] || continue
    CANDIDATE_DIRS+=("$dir")
done

if [ ${#CANDIDATE_DIRS[@]} -eq 0 ]; then
    echo "[bundle-cef-libs] No release directories found — skipping"
    exit 0
fi

# Pick directory that contains the built binary if possible.
BINARY_DIR=""
for dir in "${CANDIDATE_DIRS[@]}"; do
    if [ -f "$dir/$BINARY_NAME" ]; then
        BINARY_DIR="$dir"
        break
    fi
done

# Fall back to first candidate if binary not found yet.
if [ -z "$BINARY_DIR" ]; then
    BINARY_DIR="${CANDIDATE_DIRS[0]}"
fi

CEF_OUT=$(find "$BINARY_DIR/build" -path '*/cef-dll-sys-*/out/cef_linux_x86_64' -type d 2>/dev/null | head -1)

if [ -z "$CEF_OUT" ]; then
    # Fallback: scan other candidate release/build trees.
    for dir in "${CANDIDATE_DIRS[@]}"; do
        CEF_OUT=$(find "$dir/build" -path '*/cef-dll-sys-*/out/cef_linux_x86_64' -type d 2>/dev/null | head -1)
        if [ -n "$CEF_OUT" ]; then
            break
        fi
    done
fi

if [ -z "$CEF_OUT" ]; then
    echo "[bundle-cef-libs] No CEF output directory found — skipping (wry build?)"
    exit 0
fi

echo "[bundle-cef-libs] Staging CEF libs from: $CEF_OUT"
echo "[bundle-cef-libs] Destination binary dir: $BINARY_DIR"

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
