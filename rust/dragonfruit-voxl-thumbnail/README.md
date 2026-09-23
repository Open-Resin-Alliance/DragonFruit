# dragonfruit-voxl-thumbnail

Cross-platform OS thumbnail provider for **VOXL V2** scene files and **LUMEN v1** print files.

Extracts the embedded `ora.preview` scene thumbnail from a VOXL V2 binary file — or the `PREV` preview from a LUMEN v1 print file — and surfaces it in the OS file browser (Windows Explorer, macOS Finder, GNOME/KDE file managers).

## Architecture

```
dragonfruit-voxl-thumbnail/
├── src/lib.rs              Core Rust library (VOXL V2 / LUMEN v1 → PNG extraction)
├── src/main.rs             CLI thumbnailer binary (all platforms)
├── windows-com/            Windows IThumbnailProvider COM DLL
├── macos-qlext/            macOS QuickLook Thumbnail Extension (Swift)
└── platform/
    ├── linux/              Freedesktop thumbnailers + MIME types (both containers)
    ├── macos/              macOS install/uninstall scripts
    └── windows/            Windows registry registration scripts
```

## How It Works

The provider has no per-format code. Every container DragonFruit writes **declares**
where its preview lives - `plugins/<id>/outputFileTypes.json` for a plugin, and
`src/config/core-output-file-types.json` for the core `.voxl` scene - and
`scripts/generate-plugin-registry.mjs` validates those declarations and compiles them
into one table:

```
generated_output_file_types.json   read by this crate's interpreter (src/locator.rs)
generated/dragonfruit-mime.xml     the freedesktop MIME types
generated/dragonfruit.thumbnailer  the freedesktop thumbnailer entry
generated/VoxlThumbnailExtension-Info.plist  the QuickLook appex's plist
generated/macos-exported-utis.plist          the UTIs the dev host app exports
```

The declaration describes the mechanics rather than the format: the magic, an optional
version gate, where the chunk table is and how its entries are laid out, which chunk
types hold a preview, and how to get a PNG out of the payload - stored in the chunk, or
base64 inside its JSON, optionally zlib-compressed, optionally ranked by a role in the
entry flags with sealed ones skipped.

**VOXL V2** keeps its preview in the `EXTD` chunk as a base64 PNG under
`ora.preview.dataBase64`, zlib-compressed or not; **LUMEN v1** keeps PNG previews in
`PREV` chunks whose role (large, small, icon) sits in the low bits of the descriptor
flags, behind a `LEND` trailer. Both are *declarations* in the table above, and adding a
third container means writing one JSON file.

The reader-based implementation only ever reads headers, chunk tables, and the one
chunk that carries the image.

---

## Building

The providers read a table compiled from the container declarations
(`generated_output_file_types.json`, listed above), and it is gitignored: a fresh
checkout does not have it and `cargo build` fails on the `include_str!` in
`src/locator.rs`. Generate it first — `npm run build:thumbnail-providers` and
`npm run macos:thumbnails` do it for you, and a raw `cargo build` needs it once:

```bash
npm run generate:plugin-registry
```

### Core library + CLI (all platforms)

```bash
cd rust/dragonfruit-voxl-thumbnail
cargo build --release
```

Produces `target/release/dragonfruit-voxl-thumbnailer` (or `.exe` on Windows).

### Windows COM DLL

```bash
cd rust/dragonfruit-voxl-thumbnail/windows-com
cargo build --release
```

Produces `target/release/dragonfruit_voxl_thumbnail_com.dll`.

### macOS QuickLook Extension

Requires Xcode command-line tools.

```bash
cd rust/dragonfruit-voxl-thumbnail/macos-qlext
chmod +x build.sh
./build.sh
```

Produces `build/VoxlThumbnailExtension.appex`.

---

## Installation

### Linux (GNOME / KDE / XFCE)

```bash
cargo build --release -p dragonfruit-voxl-thumbnail
sudo platform/linux/install.sh
```

This installs:

- `/usr/local/bin/dragonfruit-voxl-thumbnailer` — CLI binary (both containers)
- `/usr/share/mime/packages/dragonfruit.xml` — MIME types for every declared file type
- `/usr/share/thumbnailers/dragonfruit.thumbnailer` — thumbnailer entry covering them

`src-tauri/tauri.linux.conf.json` ships the same set in the `.deb`, with the binary at `/usr/bin/`.

Uninstall:

```bash
sudo platform/linux/uninstall.sh
```

### Windows

**Option A — PowerShell (recommended for development)**

Per-user (no admin required):

```powershell
npm run build:thumbnail-providers
cd rust\dragonfruit-voxl-thumbnail\platform\windows
.\register.ps1 -PerUser
```

`register.ps1` registers the packaged copy under `src-tauri\windows-resources`, not the
`windows-com\target\release` output: cargo deletes and relinks its own output on every
build, and the shell keeps whatever is registered mapped inside a DllHost surrogate, so a
registration pointing at the build output makes the next build fail with "Access is
denied". To register a raw `cargo build` output without packaging it, pass `-DllPath`:

```powershell
.\register.ps1 -DllPath ..\..\windows-com\target\release\dragonfruit_voxl_thumbnail_com.dll
```

Because the shell holds the packaged DLL loaded while it is registered,
`npm run build:thumbnail-providers` skips the copy when the bytes are unchanged and
evicts the DllHost surrogate holding it (re-created on demand) when they changed.

System-wide (requires admin):

```powershell
.\register.ps1
```

**Option B — regsvr32 (uses DLL self-registration)**

```cmd
regsvr32 src-tauri\windows-resources\dragonfruit_voxl_thumbnail_com.dll
```

After registration, clear the thumbnail cache and restart Explorer:

```cmd
ie4uinit.exe -show
del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db"
taskkill /f /im explorer.exe & start explorer.exe
```

Unregister:

```powershell
.\platform\windows\unregister.ps1
```

or

```cmd
regsvr32 /u src-tauri\windows-resources\dragonfruit_voxl_thumbnail_com.dll
```

### macOS

```bash
cargo build --release -p dragonfruit-voxl-thumbnail
cd macos-qlext && ./build.sh && cd ..
platform/macos/install.sh
```

For Tauri app distribution, embed the `.appex` in the app bundle:

```
DragonFruit.app/Contents/PlugIns/VoxlThumbnailExtension.appex
```

The extension's `Info.plist` and its file-type table are generated from the declarations
(`rust/dragonfruit-voxl-thumbnail/generated/`), so the app's own `Info.plist` needs the
same UTI declarations only when it ships separately from the extension - see
`macos-qlext/README.md`.

Uninstall:

```bash
platform/macos/uninstall.sh
```

---

## CLI Usage

```
dragonfruit-voxl-thumbnailer <input> <output.png> [size]
dragonfruit-voxl-thumbnailer --size 512 <input> <output.png>
```

| Argument | Description                                      |
| -------- | ------------------------------------------------ |
| `input`  | Path to a VOXL V2 scene or a LUMEN v1 print file |
| `output` | Output PNG path                                  |
| `size`   | Max dimension in pixels (default: 256)           |

The CLI also supports the freedesktop thumbnailer calling convention (`%i %o %s`).

To verify an install, run it directly on either container: it writes the same PNG the shell would show, and exits non-zero with the reason on stderr when a file carries no readable preview.

---

## Tauri Integration

For bundled distribution, the Tauri installer can:

1. **Windows** — Run `regsvr32` on the embedded COM DLL during install, and `regsvr32 /u` during uninstall via `tauri.conf.json` NSIS hooks.
2. **macOS** — Embed the `.appex` in `Contents/PlugIns/` and declare the UTI in the app's `Info.plist`.
3. **Linux** — Ship the `.thumbnailer` and `.xml` files for both containers in the `.deb`/`.AppImage` and run `update-mime-database` in post-install.
