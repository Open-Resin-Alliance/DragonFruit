# dragonfruit-voxl-thumbnail

Cross-platform OS thumbnail provider for **VOXL V2** scene files.

Extracts the embedded `ora.preview` scene thumbnail from a VOXL V2 binary file and surfaces it in the OS file browser (Windows Explorer, macOS Finder, GNOME/KDE file managers).

## Architecture

```
dragonfruit-voxl-thumbnail/
├── src/lib.rs              Core Rust library (VOXL V2 → PNG extraction)
├── src/main.rs             CLI thumbnailer binary (all platforms)
├── windows-com/            Windows IThumbnailProvider COM DLL
├── macos-qlext/            macOS QuickLook Thumbnail Extension (Swift)
└── platform/
    ├── linux/              Freedesktop thumbnailer + MIME type
    ├── macos/              macOS install/uninstall scripts
    └── windows/            Windows registry registration scripts
```

## How It Works

VOXL V2 files embed a scene thumbnail as a base64-encoded PNG inside the **EXTD** (extensions) chunk under the key `ora.preview.dataBase64`. The core library:

1. Reads the 16-byte VOXL header + chunk directory (only ~100 bytes)
2. Seeks directly to the EXTD chunk (skips all mesh data)
3. Decompresses if zlib-compressed
4. Parses JSON → extracts `ora.preview.dataBase64`
5. Base64-decodes to raw PNG
6. Optionally resizes to the requested thumbnail dimensions

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

- `/usr/local/bin/dragonfruit-voxl-thumbnailer` — CLI binary
- `/usr/share/mime/packages/dragonfruit-voxl.xml` — MIME type for `.voxl`
- `/usr/share/thumbnailers/dragonfruit-voxl.thumbnailer` — thumbnailer entry

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
dragonfruit-voxl-thumbnailer <input.voxl> <output.png> [size]
dragonfruit-voxl-thumbnailer --size 512 input.voxl output.png
```

| Argument | Description                            |
| -------- | -------------------------------------- |
| `input`  | Path to VOXL V2 file                   |
| `output` | Output PNG path                        |
| `size`   | Max dimension in pixels (default: 256) |

The CLI also supports the freedesktop thumbnailer calling convention (`%i %o %s`).

---

## Tauri Integration

For bundled distribution, the Tauri installer can:

1. **Windows** — Run `regsvr32` on the embedded COM DLL during install, and `regsvr32 /u` during uninstall via `tauri.conf.json` NSIS hooks.
2. **macOS** — Embed the `.appex` in `Contents/PlugIns/` and declare the UTI in the app's `Info.plist`.
3. **Linux** — Ship the `.thumbnailer` and `.xml` files in the `.deb`/`.AppImage` and run `update-mime-database` in post-install.
