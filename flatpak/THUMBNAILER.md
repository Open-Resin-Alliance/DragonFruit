# Thumbnailer support in the Flatpak build — decision record

## Question

DragonFruit ships `dragonfruit-voxl-thumbnailer` (a small Rust binary at
`rust/dragonfruit-voxl-thumbnail/`) that host file managers (Nautilus, Dolphin,
Nemo, Thunar) invoke to render thumbnails of `.voxl` files. On `.deb`/`.rpm`
installs the binary goes to `/usr/bin/` and a `.thumbnailer` file at
`/usr/share/thumbnailers/` registers it. Should the Flatpak ship this too?

## TL;DR — **No**

Dropped from the Flatpak build in v0.1.3. Users who want file-manager
thumbnails install the `.deb`/`.rpm` bundle instead. Rationale below.

## Why host file managers cannot call into a Flatpak

File managers invoke thumbnailers by spawning the binary named in
`Exec=` of the `.thumbnailer` file. The file manager runs **outside** the
Flatpak sandbox, so:

1. It cannot see `/app/bin/dragonfruit-voxl-thumbnailer` — that path exists
   only inside the app's mount namespace.
2. Flatpak *does* export approved binaries to
   `/var/lib/flatpak/exports/bin/<app-id>.<name>` via `finish-args`, but:
   - The export is a wrapper that calls `flatpak run --command=<name> <app-id>`.
   - Each `flatpak run` spins up a fresh sandbox instance: namespace setup,
     CEF zygote init, D-Bus session. Easily 1–3 s overhead per call.
   - File managers thumbnail in parallel batches; this would thrash the
     system and produce terrible UX.
3. Even with the export, registering the `.thumbnailer` on the host requires
   writing to `/usr/share/thumbnailers/` — host paths the sandbox cannot reach.

There is no Flatpak portal for thumbnailer registration. This is a known,
long-standing limitation (flatpak/flatpak#2238, xdg-desktop-portal#1025).

## Options considered

| # | Approach | Verdict |
|---|----------|---------|
| 1 | Drop thumbnailer, document limitation | ✅ **Chosen**. Smallest bundle, clearest UX. |
| 2 | Ship binary + `.thumbnailer` in `/app/share/thumbnailers/` | ❌ Host file managers only look at `/usr/share/thumbnailers/` and `~/.local/share/thumbnailers/` — not `/var/lib/flatpak/exports/share/thumbnailers/`. |
| 3 | Exported `flatpak run` wrapper in `/var/lib/flatpak/exports/bin/` + `.thumbnailer` pointing at it | ❌ Works in principle but 1–3 s per-thumbnail overhead from sandbox startup makes it unusable at file-manager scale. Also: wrapper is `org.openresinalliance.dragonfruit.dragonfruit-voxl-thumbnailer`, which most file managers silently reject because it contains dots and they treat it as a MIME type. |
| 4 | Ship as a separate tiny Flatpak just for the thumbnailer | ❌ Same sandbox-startup problem as option 3, plus discoverability is terrible. |

## Recommendation

Document in `flatpak/README.md` (done):

> The Flatpak does not install a file-manager thumbnailer for `.voxl` files.
> This is a Flatpak sandbox limitation — host file managers cannot cross the
> sandbox boundary to call a thumbnailer binary. If you want thumbnails in
> Nautilus/Dolphin/Nemo, install the `.deb` or `.rpm` instead.

Re-evaluate when either:
- xdg-desktop-portal gains a thumbnailer portal (likely years away), or
- DragonFruit offers thumbnails via alternative means (e.g., GVfs-visible
  sidecar `.thumb` files written on export).

## Test artifacts

None — dropped before testing. The analysis above is based on documentation
and prior Flatpak community experience (e.g. OBS Studio, Inkscape, GIMP all
face the same constraint and all ship without host thumbnailer integration
in their Flatpaks).

## Related files

- `rust/dragonfruit-voxl-thumbnail/` — source (kept; used for `.deb`/`.rpm`)
- `src-tauri/tauri.linux.conf.json` — `.deb` bundle config that ships the
  thumbnailer on non-Flatpak Linux installs
