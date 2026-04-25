# DragonFruit Flatpak

Flatpak packaging for DragonFruit. Adds a sandboxed, auto-updating Linux
install path alongside the existing `.deb`, `.rpm`, and `.AppImage` bundles.

## Design summary

- **Runtime**: `org.freedesktop.Platform//24.08`
- **Bundled CEF**: matches the `.deb`/`.rpm`/`.AppImage` Linux build path
  (Tauri `feat/cef` fork — fixes issue #83 Wayland+Nvidia crash). CEF runs
  with `--no-sandbox` because Flatpak's own bwrap sandbox already provides
  namespace isolation.
- **No thumbnailer**: the file-manager thumbnailer is intentionally not
  included — host file managers cannot execute binaries inside a Flatpak
  sandbox. See `THUMBNAILER.md` for the investigation. Users wanting file
  manager thumbnails should install the `.deb`/`.rpm`.

## Files in this directory

| File | Purpose |
|------|---------|
| `org.openresinalliance.dragonfruit.yml` | flatpak-builder manifest (fast path — consumes pre-built binary) |
| `org.openresinalliance.dragonfruit.metainfo.xml` | AppStream metadata |
| `org.openresinalliance.dragonfruit.desktop` | Desktop entry |
| `dragonfruit-voxl-mime.xml` | MIME type registration for `.voxl` files |
| `launcher.sh` | `/app/bin/dragonfruit` wrapper — sets CEF flags and `LD_LIBRARY_PATH` |
| `FLATHUB.md` | Flathub submission checklist (blocked on GPL-3.0 LICENCE publication) |
| `THUMBNAILER.md` | Thumbnailer-in-Flatpak investigation notes |

## Building the bundle

### Host prerequisites

Install flatpak + flatpak-builder + runtimes:

```bash
# Fedora
sudo dnf install -y flatpak flatpak-builder appstream desktop-file-utils
# Ubuntu
sudo apt-get install -y flatpak flatpak-builder appstreamcli desktop-file-utils

flatpak remote-add --if-not-exists --user flathub \
    https://flathub.org/repo/flathub.flatpakrepo

flatpak install --user -y flathub \
    org.freedesktop.Platform//24.08 \
    org.freedesktop.Sdk//24.08
```

### Build steps

From the DragonFruit repo root, run the standard Tauri build:

```bash
npm run tauri:build
```

When `flatpak-builder`, `appstreamcli`, and `desktop-file-validate` are on
PATH, `tauri-build.mjs` automatically:

1. Stages CEF shared libraries (`scripts/bundle-cef-libs.sh`)
2. Validates `.desktop` and `metainfo.xml`
3. Stages the binary + CEF blobs + icons into `flatpak/staging/`
4. Runs `flatpak-builder` against the manifest
5. Exports the bundle to `src-tauri/target/release/bundle/flatpak/`
6. Cleans up `flatpak/staging/`

If any of the three tools are missing, the Flatpak step is silently skipped
and the Tauri build completes normally with deb/rpm/AppImage bundles only.

Output: `src-tauri/target/release/bundle/flatpak/dragonfruit-<version>-x86_64.flatpak`

### Install and run

```bash
flatpak install --user -y src-tauri/target/release/bundle/flatpak/dragonfruit-*.flatpak
flatpak run org.openresinalliance.dragonfruit
```

## Building inside the `cef-linux-build` Docker container

The swamp-managed `cef-linux-build` Fedora 43 container has the repo mounted
at `/build` and already contains the compiled Tauri artifacts from previous
builds. Full sequence:

```bash
# Ensure container is running
swamp model method run cef-linux-build apply

# Enter container
docker exec -it df-cef-build bash

# Inside container:
dnf install -y flatpak flatpak-builder appstream desktop-file-utils
flatpak remote-add --if-not-exists --user flathub \
    https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub \
    org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08

cd /build
npm run tauri:build
```

## Runtime permissions

The Flatpak is granted:

| Permission | Why |
|------------|-----|
| `--share=ipc` | CEF zygote ↔ renderer shared memory |
| `--share=network` | Printer discovery + uploads (HTTP) |
| `--socket=wayland` `--socket=fallback-x11` | Display |
| `--socket=pulseaudio` | (benign; no audio currently used) |
| `--device=dri` | GPU acceleration for Three.js preview |
| `--filesystem=xdg-documents` `--filesystem=xdg-download` | Initial read/write for common save locations |
| `--talk-name=org.freedesktop.portal.*` | File picker + notifications + open-uri via `rfd` crate |

**Not granted** (deliberate): `--filesystem=host`, `--share=home`, USB/serial
devices. File I/O outside `~/Documents` and `~/Downloads` goes via the
xdg-desktop-portal file chooser; the `rfd` crate detects Flatpak automatically.

## Known limitations

- **No file-manager thumbnails**: dropping the `dragonfruit-voxl-thumbnailer`
  binary; see `THUMBNAILER.md`.
- **No USB/serial printer support**: DragonFruit talks to printers over
  HTTP/LAN only, so this is not a regression — but worth knowing if that
  changes upstream.
- **Single-architecture**: x86_64 only in v0.1.3 (mirrors current CI).
  aarch64 is future work.

## Related docs

- `FLATHUB.md` — submission checklist and blockers
- `THUMBNAILER.md` — thumbnailer investigation
- Root `scripts/tauri-build.mjs` — Linux build path with auto Flatpak post-build
- Root `scripts/bundle-cef-libs.sh` — CEF library staging
