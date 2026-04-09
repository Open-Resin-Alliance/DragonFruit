# macOS QuickLook Thumbnail Extension

## What it is

`VoxlThumbnailExtension.appex` is a macOS **QuickLook Thumbnail Extension** that lets Finder and Quick Look show a scene preview for `.voxl` files. The extension itself is a thin Swift wrapper — it shells out to the `dragonfruit-voxl-thumbnailer` CLI binary to extract the embedded PNG thumbnail.

## Why it can't be built by Tauri automatically

Unlike Windows (COM DLL + `regsvr32`) and Linux (freedesktop thumbnailer + MIME XML), macOS extensions have strict requirements:

1. **Must be signed with a real Developer ID.** Ad-hoc signing (`codesign --sign -`) works locally but macOS refuses to load the extension on any other machine.
2. **Must be embedded inside the host app bundle** at `DragonFruit.app/Contents/PlugIns/VoxlThumbnailExtension.appex`, so it cannot be built as a standalone artifact and dropped in later.
3. **Requires Xcode** (specifically `swiftc` and `xcrun`) which Tauri's `beforeBundleCommand` cannot reliably assume is available in CI without extra setup.

Because Tauri doesn't natively produce a signed `.appex`, this step lives outside the automatic bundle pipeline.

## How to build locally (development / ad-hoc signing)

```bash
cd rust/dragonfruit-voxl-thumbnail/macos-qlext
./build.sh
```

Output: `build/VoxlThumbnailExtension.appex` (ad-hoc signed).

Install into your user Quick Look for testing:

```bash
cp -R build/VoxlThumbnailExtension.appex ~/Library/QuickLook/
qlmanage -r
```

> The `dragonfruit-voxl-thumbnailer` binary must be on `$PATH` or inside the containing `DragonFruit.app` bundle for the extension to function.

## Embedding in a distribution build

After `npx tauri build`:

1. Build the `.appex` with your **Developer ID Application** certificate:

   ```bash
   cd rust/dragonfruit-voxl-thumbnail/macos-qlext
   ./build.sh   # produces build/VoxlThumbnailExtension.appex
   codesign --force \
     --sign "Developer ID Application: Open Resin Alliance (TEAMID)" \
     --entitlements Sources/VoxlThumbnailExtension/VoxlThumbnailExtension.entitlements \
     build/VoxlThumbnailExtension.appex
   ```

2. Copy the `.appex` into the Tauri-produced app bundle **before** notarisation:

   ```bash
   APPBUNDLE="src-tauri/target/release/bundle/macos/DragonFruit.app"
   mkdir -p "$APPBUNDLE/Contents/PlugIns"
   cp -R build/VoxlThumbnailExtension.appex "$APPBUNDLE/Contents/PlugIns/"
   ```

3. Re-sign the outer app bundle so it includes the new plug-in:

   ```bash
   codesign --force --deep \
     --sign "Developer ID Application: Open Resin Alliance (TEAMID)" \
     "$APPBUNDLE"
   ```

4. Proceed with notarisation as normal (`notarytool`, `stapler`).

## UTI / file association

The extension's `Info.plist` declares a `UTImportedTypeDeclarations` entry for `.voxl` (`org.openresinalliance.dragonfruit.voxl`). **Duplicate this declaration** in the main DragonFruit `Info.plist` (via `tauri.conf.json` → `bundle.macOS.infoPlist`) so that Finder recognises the type even when the app is not the frontmost process.

## Troubleshooting

| Symptom                                              | Likely cause                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Finder shows generic icon even after install         | Extension not loaded — run `qlmanage -r` and `/usr/libexec/lsd -kill` then log out/in |
| `qlmanage -t -s 256 file.voxl` exits 0 but no output | `dragonfruit-voxl-thumbnailer` not found; check `$PATH` or bundle placement           |
| Extension loads locally but not on other Macs        | Ad-hoc signing — use a real Developer ID certificate for distribution                 |
| macOS quarantines the extension                      | Notarise the full app bundle after embedding the `.appex`                             |
