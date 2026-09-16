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

One extractor, two containers, dispatched on the first four bytes of the file: `VOXL` selects the scene reader, `LUMN` selects the print reader. Anything else is refused.

### VOXL V2 (scenes)

VOXL V2 files embed a scene thumbnail as a base64-encoded PNG inside the **EXTD** (extensions) chunk under the key `ora.preview.dataBase64`. The reader:

1. Reads the 16-byte VOXL header + the 20-byte-per-entry chunk directory (only ~100 bytes)
2. Seeks directly to the EXTD chunk (skips all mesh data)
3. Decompresses if zlib-compressed
4. Parses JSON → extracts `ora.preview.dataBase64`
5. Base64-decodes to raw PNG
6. Optionally resizes to the requested thumbnail dimensions

### LUMEN v1 (prints)

LUMEN puts its chunk directory at the **end** of the file, after the payloads, so the reader seeks there first instead of walking the file from the front. Previews are `PREV` chunks whose payload is a PNG stored uncompressed; the preview role sits in the low four bits of the descriptor flags — `0` unspecified, `1` large (400×300), `2` small (200×125), `3` icon (≤64×64) — and bit 4 marks a sealed (encrypted) payload. The reader:

1. Checks the 32-byte header: only LUMEN **v1** is read, and a future version is refused rather than misread
2. Seeks to the chunk directory and reads it, then seeks to the chosen payload — layer data is never touched
3. Skips sealed previews, which cannot be read without the file's key
4. Ranks what is left — Large first, then an unspecified preview, then Small, then Icon — and takes the file order as the tie-break
5. Returns the payload, skipping it and looking further if it is not a PNG
6. Optionally resizes to the requested thumbnail dimensions

The chunk directory is followed by an 8-byte `LEND` trailer. The reader checks that magic but does not recompute the CRC-32C, because that would mean reading the whole file.

DragonFruit's own `.lumen` output carries one `PREV` with the Large role, fitted from the 1600×960 export capture into the role's 400×300 box (the encoder lives in `plugins/lumen/slicing/rust/lumen_preview.rs`), so the shell shows the same scene picture a `.voxl` file shows.

---

## Building

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
- `/usr/share/mime/packages/dragonfruit-voxl.xml` — MIME type for `.voxl`
- `/usr/share/mime/packages/dragonfruit-lumen.xml` — MIME type for `.lumen`
- `/usr/share/thumbnailers/dragonfruit-voxl.thumbnailer` — thumbnailer entry for `.voxl`
- `/usr/share/thumbnailers/dragonfruit-lumen.thumbnailer` — thumbnailer entry for `.lumen`

`src-tauri/tauri.linux.conf.json` ships the same set in the `.deb`, with the binary at `/usr/bin/`.

Uninstall:

```bash
sudo platform/linux/uninstall.sh
```

### Windows

**Option A — PowerShell (recommended for development)**

Per-user (no admin required):

```powershell
cd windows-com
cargo build --release
cd ..\platform\windows
.\register.ps1 -PerUser
```

System-wide (requires admin):

```powershell
.\register.ps1
```

**Option B — regsvr32 (uses DLL self-registration)**

```cmd
regsvr32 target\release\dragonfruit_voxl_thumbnail_com.dll
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
regsvr32 /u target\release\dragonfruit_voxl_thumbnail_com.dll
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

And add the UTI declaration to the app's `Info.plist` (see `macos-qlext/Sources/VoxlThumbnailExtension/Info.plist` for the `UTImportedTypeDeclarations` block).

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
