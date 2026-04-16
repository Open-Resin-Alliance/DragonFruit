#!/bin/bash
# flatpak/build.sh — Build a .flatpak bundle from pre-built artifacts.
#
# Prerequisites (run manually on the Linux host before this script):
#   node scripts/tauri-build.mjs           # Linux path => --features tauri-cef
#   bash scripts/bundle-cef-libs.sh        # stages .so/.pak/.dat/.bin/locales
#
# Then from the repo root:
#   bash flatpak/build.sh
#
# Output:
#   flatpak/repo/                                          local ostree repo
#   flatpak/build-dir/                                     staged /app tree
#   dist/dragonfruit-<version>-<arch>.flatpak              single-file bundle

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

APP_ID="org.openresinalliance.dragonfruit"
MANIFEST="flatpak/org.openresinalliance.dragonfruit.yml"
# Version — read from package.json without needing node (flatpak build hosts
# may not have the frontend toolchain installed).
VERSION="$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' package.json | head -1)"
ARCH="$(uname -m)"
OUT="dist/dragonfruit-${VERSION}-${ARCH}.flatpak"

# Pre-flight: validate metadata before kicking off the real build. These are
# the validations Flathub runs; catching locally saves a full build cycle.
echo "[1/6] Validating metainfo.xml"
# --no-net: URL reachability is not a local-build concern; Flathub runs its own
# checks with network access. Avoids flaky CI from transient GitHub 5xx.
appstreamcli validate --no-net flatpak/org.openresinalliance.dragonfruit.metainfo.xml

echo "[2/6] Validating .desktop"
desktop-file-validate flatpak/org.openresinalliance.dragonfruit.desktop

# Pre-flight: locate the Linux CEF binary. Expectation is that
# `node scripts/tauri-build.mjs` produces a CEF-linked binary (tauri-build.mjs
# appends --features tauri-cef on Linux). Candidates, in order of preference:
#
#   1. src-tauri/target/release/dragonfruit-desktop                        (native build, current)
#   2. src-tauri/target/x86_64-unknown-linux-gnu/release/dragonfruit-desktop
#   3. src-tauri/target/release/bundle/appimage/DragonFruit.AppDir/usr/bin/dragonfruit-desktop
#                                                                         (from prior AppImage)
#
# Requirement: the binary must be Linux x86_64 ELF *and* NEEDED libcef.so.
# On a shared volume with a macOS host, target/release/ may be overwritten
# by macOS Mach-O builds, and earlier builds may have been wry/WebKitGTK
# before the CEF switch. Fail fast with a clear message if the first
# CEF-linked candidate can't be found.
REL=src-tauri/target/release
TRIPLE_REL=src-tauri/target/x86_64-unknown-linux-gnu/release
APPIMG_REL=src-tauri/target/release/bundle/appimage/DragonFruit.AppDir/usr/bin

find_cef_binary() {
    for candidate in "$REL/dragonfruit-desktop" \
                     "$TRIPLE_REL/dragonfruit-desktop" \
                     "$APPIMG_REL/dragonfruit-desktop"; do
        [ -f "$candidate" ] || continue
        if command -v file >/dev/null 2>&1; then
            file "$candidate" | grep -q 'ELF 64-bit LSB.*x86-64' || continue
        fi
        if command -v readelf >/dev/null 2>&1; then
            readelf -d "$candidate" 2>/dev/null | grep -q 'NEEDED.*libcef' || continue
        fi
        echo "$candidate"
        return 0
    done
    return 1
}

BIN="$(find_cef_binary)" || {
    echo "ERROR: No Linux x86_64 CEF-linked dragonfruit-desktop binary found." >&2
    echo "       Looked in: $REL, $TRIPLE_REL, $APPIMG_REL" >&2
    echo "       Run 'node scripts/tauri-build.mjs' on Linux to produce one." >&2
    exit 1
}

for f in libcef.so locales; do
    if [ ! -e "$REL/$f" ]; then
        echo "ERROR: $REL/$f missing — run 'bash scripts/bundle-cef-libs.sh' first." >&2
        exit 1
    fi
done
echo "       Using binary: $BIN"

# Stage only the files flatpak-builder needs. If we point a `type: dir` source
# at the repo root (or src-tauri/), flatpak-builder copies gigabytes of cargo
# build artefacts, node_modules, and submodules into its build context — even
# though we only install a handful of specific files. Staging ~250 MB of
# relevant files instead keeps the build to tens of seconds.
echo "[3/6] Staging build inputs"
STAGING=flatpak/staging
rm -rf "$STAGING"
mkdir -p "$STAGING/bin" "$STAGING/cef" "$STAGING/icons"

cp "$BIN"                                  "$STAGING/bin/dragonfruit-desktop"
cp "$REL"/*.so                             "$STAGING/cef/"
for f in "$REL"/*.pak "$REL"/*.dat "$REL"/*.bin "$REL"/vk_swiftshader_icd.json; do
    [ -f "$f" ] && cp "$f" "$STAGING/cef/"
done
# chrome-sandbox — harmless if present; CEF is run with --no-sandbox at runtime
[ -f "$REL/chrome-sandbox" ] && cp "$REL/chrome-sandbox" "$STAGING/cef/"
cp -r "$REL/locales"                       "$STAGING/cef/"

cp flatpak/launcher.sh                                    "$STAGING/"
cp flatpak/org.openresinalliance.dragonfruit.desktop      "$STAGING/"
cp flatpak/org.openresinalliance.dragonfruit.metainfo.xml "$STAGING/"
cp flatpak/dragonfruit-voxl-mime.xml                      "$STAGING/"

cp src-tauri/icons/32x32.png       "$STAGING/icons/32x32.png"
cp src-tauri/icons/64x64.png       "$STAGING/icons/64x64.png"
cp src-tauri/icons/128x128.png     "$STAGING/icons/128x128.png"
cp src-tauri/icons/128x128@2x.png  "$STAGING/icons/256x256.png"
cp src-tauri/icons/icon.png        "$STAGING/icons/512x512.png"

echo "       Staging size: $(du -sh "$STAGING" | cut -f1)"

echo "[4/6] Running flatpak-builder"
rm -rf flatpak/build-dir
# --disable-rofiles-fuse: FUSE is unavailable inside most Docker containers
# without CAP_SYS_ADMIN + /dev/fuse. Flatpak-builder falls back to copying,
# which is slightly slower but works anywhere. Harmless on bare-metal too.
FLATPAK_BUILDER_FLAGS="${FLATPAK_BUILDER_FLAGS:---disable-rofiles-fuse}"
flatpak-builder --user --force-clean $FLATPAK_BUILDER_FLAGS \
    --repo=flatpak/repo \
    flatpak/build-dir \
    "$MANIFEST"

echo "[5/6] Exporting single-file bundle to $OUT"
mkdir -p dist
flatpak build-bundle flatpak/repo "$OUT" "$APP_ID"

echo "[6/6] Bundle produced:"
ls -lh "$OUT"
echo ""
echo "Install with:"
echo "    flatpak install --user -y $OUT"
echo "Run with:"
echo "    flatpak run $APP_ID"
