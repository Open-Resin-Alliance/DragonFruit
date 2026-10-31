# Sideloaded complex plugins

The runtime-installable tier for **executable** plugins: a signed, optionally
encrypted `.dfplugin` package imported from Settings → Plugins, run as a
**separate process** that speaks a versioned protocol, with bulk layer data
crossing a shared byte ring rather than the pipe.

Decision record: `docs/adr/0047-sideloaded-complex-plugins.md`.

Read this page before changing anything in this tier. "Protocol v1" and
"Threat model" are the two sections whose mistakes are silent.

## Implemented so far

| Piece | Where | State |
| --- | --- | --- |
| Package format, signature, seal, extraction | `rust/dragonfruit-plugin-package` | done, unit-tested |
| Reference packer | `rust/dragonfruit-plugin-package/examples/pack.rs` | done |
| Allowance gate, inspect, install, list, remove | `src-tauri/src/plugin_sideload.rs` | done, unit-tested |
| Import UI behind the advanced switch | `src/components/settings/PluginsSettingsTab.tsx` | done |
| Process spawn, handshake, `ready` validation, idle stop, crash recovery | `src-tauri/src/plugin_sideload_runtime.rs` | done, tested against a real plugin process |
| Shared ring, encode sessions, layer previews | runtime + engine adapter | done; the `pipe` transport is designed but refused rather than half-implemented |
| `network` capability | host runtime + SDK harness | done |
| `slicerEncoder` capability | host runtime + engine adapter + SDK harness | done, tested against a real encoder process |
| `fileType` capability | host runtime + renderer container parser | done, tested against a real importer process |
| printer presets and material templates | manifest `printerPresets` / `materialTemplates` | done: the renderer registers them through the same store entry the simple tier uses |
| declared network mode | manifest `network` | done: the renderer registers the mode and the generic panels drive it |
| job upload | manifest `network.operations.upload` + the host chunk loop | done: printing works for a declared mode |
| material pane schema | manifest `materialSettings` | done: validated once, rendered by the same form as compiled adapters |
| on-device material list and edit | manifest `network.remoteMaterials` | done: the same dialog, built from declared fields |
| package image assets | `payload/assets/` + `sideloaded_plugin_asset` | done: preset images are inlined as data URLs |
| job metadata payloads | manifest `jobMetadataPayloads` | done: the host bakes them into `metadata_json` and the encoder reads it |
| raw mask layers, area stats | format `layers: "mask"`, `requiresAreaStats` | done: mask slots at source resolution, stats in the batch job |

`cargo test` in the package crate and `cargo test --bin dragonfruit-desktop
plugin_sideload` cover the verification matrix below except the process cases.
The encoder adapter named under "Host integration" is still spec: nothing here
spawns the binary yet.

## Why this exists

Compiled-in complex plugins are source submodules: the registry generator
`#[path]`-includes their Rust into the engine and the shell, so their code is
part of the AGPL binary. A vendor that will not open-source their integration
cannot use that path at all. Sideloading is the second, opt-in tier for exactly
that case: a partner builds a process against our published SDK, seals it in a
package, and the user imports it.

Three tiers exist, and they are deliberately not interchangeable:

| Tier              | Built by           | Installed by        | Contains code? | Default |
| ----------------- | ------------------ | ------------------- | -------------- | ------- |
| Simple plugin     | anyone             | GitHub manifest     | no             | on      |
| Complex plugin    | ORA + contributors | compiled in         | yes (AGPL)     | on      |
| Sideloaded plugin | a vendor           | `.dfplugin` import  | yes (vendored) | **off** |

The sideloading toggle is the only place in the product where a user may run
code ORA did not build. Nothing else moves: the simple-plugin rules in
`docs/dev/plugins-framework.md` still forbid binaries in a manifest plugin.

## Package format

`.dfplugin` is a ZIP archive, but only three entries are read by the archive
layer; the payload is the part that is sealed.

```
dfplugin.json        plaintext manifest (see below)
signature.ed25519    detached Ed25519 signature over the exact bytes of dfplugin.json
payload.bin          AEAD ciphertext of payload.zip
```

The manifest is **plaintext on purpose**: the import sheet must be able to show
who signed the package, what it can do and which app versions it accepts
*before* the user is asked for a key. Everything executable is inside the
payload.

`payload.zip` (after unsealing):

```
bin/<platform>/<executable>  plugin process: .exe / .so-style binary / Mach-O
lib/<platform>/…             optional, loaded only by that executable
assets/…                     optional, served like plugin assets
README.md                    optional
```

### Manifest

```json
{
  "formatVersion": 1,
  "id": "alphabeta.alphaprint",
  "name": "AlphaPrint Format",
  "version": "1.0.0",
  "vendor": { "name": "AlphaBeta", "homepage": "https://example.invalid" },
  "minAppVersion": "0.4.0",
  "capabilities": ["slicerEncoder", "networkOperations", "fileType"],
  "entry": { "kind": "process", "proto": 1, "transport": "shm" },
  "publisher": { "key": "<base64 Ed25519 public key>" },
  "payload": {
    "sha256": "<hex of payload.zip plaintext>",
    "bytes": 1234567,
    "seal": {
      "alg": "xchacha20poly1305",
      "kdf": "argon2id",
      "salt": "<base64>",
      "m": 65536,
      "t": 3,
      "p": 1
    }
  },
  "formats": [
    { "id": "apf", "extensions": [".apf"], "displayName": "AlphaPrint", "layers": "rle" }
  ],
  "fileTypes": [
    { "extension": ".apf", "displayName": "AlphaPrint project", "isSceneFile": true }
  ],
  "network": {
    "pluginId": "alphabeta",
    "mode": "alphabeta-net",
    "displayName": "AlphaBeta Network",
    "hostnames": ["alphabeta.local"]
  },
  "printerPresets": [
    { "presetId": "alphabeta.alpha-4k", "manufacturer": "AlphaBeta", "name": "Alpha 4K",
      "buildVolumeMm": { "width": 143, "depth": 89, "height": 175 },
      "display": { "resolutionX": 4096, "resolutionY": 2560, "outputFormat": ".apf" } }
  ],
  "materialTemplates": [
    { "name": "Alpha Standard Resin", "brand": "AlphaBeta", "layerHeightMm": 0.05 }
  ],
  "materialSettings": {
    "byOutput": {
      ".apf": {
        "displayName": "AlphaPrint",
        "fields": [
          { "key": "exposureSec", "label": "Exposure (s)", "kind": "number", "defaultValue": 2.5 }
        ]
      }
    }
  }
}
```

Rules the host enforces, in this order:

1. `formatVersion` and `entry.proto` are values this build knows; an unknown
   protocol version is refused, never guessed.
2. `signature.ed25519` verifies against `publisher.key` over the manifest bytes.
3. `publisher.key` matches the fingerprint stored for this `id` on an earlier
   import; a key change is a hard failure that requires removing the plugin
   first. (First import shows the fingerprint for the user to compare.)
4. `minAppVersion` is satisfied.
5. The user enabled sideloading, confirmed the capability sheet, and — when
   `seal` is present — supplied the passphrase.
6. Decrypt, then `payload.sha256` must match the plaintext byte-for-byte.
7. The handshake advertises no capability the manifest did not declare.

`formats` is required for a package with the encoder capability: the engine
looks encoders up by exact output extension, so the package has to declare
extensions before anything starts.

### Profile content

A package can carry printer presets and material templates:
`printerPresets` and `materialTemplates` in the manifest, bounded to 64 and 256
entries, each a JSON object. The host keeps them with the installed record; the
renderer hands them to the profile store through `installPluginFromManifest`, the
same entry point the simple-plugin tier uses, so there is one normaliser and one
place where a bad preset is rejected.

That is how a sideloaded package appears in the printer library and the material
picker. The package's own row in Settings stays the sideloaded record, which is
the one that can be enabled or removed, and the profile-store entry it creates is
filtered out of that list.

Presets, templates and network modes are read out of the plugin registry on every
call, and the profile store's snapshot moves when that registry does: a plugin
installed in this session re-renders the printer library immediately instead of
waiting for a reload. A component that memoises one of those lookups has to
depend on the profile snapshot, not on an empty list — a pinned list is how the
Network Support dropdown ended up showing "Unknown (mode)" for a mode the
registry knew.

Removing the package removes the profile entry and the presets with it. A preset
whose `display.outputFormat` names the package's own format is the usual shape,
so picking that printer also picks the encoder.

### Network mode

The `network` block does more than name the answering plugin: it registers a
mode. `mode` is the slug a printer profile stores in `networkSupport`, so the
mode appears in the profile's **Network Support** list and the discovery,
connection and monitoring panels call the package's process. A preset that sets
`"networkSupport": "alphabeta-net"` selects it when the printer is added.

`pluginId` must be this manifest's id — a package cannot route the UI's calls to
another plugin's handler — and the mode may not take over one a compiled plugin
owns. The operation names and the payload contract are in
`docs/dev/plugins-sdk/network.md`; they are fixed so one adapter shape serves
every package. `network.remoteMaterials` adds the on-device material list and edit
dialog: the fields are the compiled plugins' own model, so one dialog renders both.

### Material pane schema

`materialSettings` carries the material pane in the shape compiled plugins define in
TypeScript — tabs, sections, cards and fields, or a differential object
(`$inherit` / `$remove` / `$update`) resolved against the other modes of the same
format. The renderer validates it in
`src/features/plugins/declaredMaterialSettings.ts` and registers it in the same maps
the compiled adapters fill, so one form renders both.

Compiled plugins own their output format: a package fills a format nobody claims and
may add modes inside it, never replace one. Field kinds the renderer does not know,
fields without a `key` or a scalar `defaultValue`, and contracts that end up with no
fields are dropped rather than guessed at. Labels are plain strings, so they are
English; the app does not translate plugin-supplied text. Limits: 8 formats, 8
modes per format, 512 fields, 128 KiB per contract.

Whatever needs its own rendering is the planned UI island, not this field — see
`docs/dev/plugins-sdk/ui.md`.

### Assets

A payload may carry images under `payload/assets/`. A printer preset references one
by its path inside that directory (`"imageAssetPath": "echo_printer.png"`), and the
renderer asks the host for it at registration:
`sideloaded_plugin_asset(pluginId, assetPath)` returns a data URL, because a webview
cannot load a path that lives in the app data dir. The inlined URL is what the
preset card renders, and it is stored with the preset like a remote image from the
simple tier.

Rules: paths are relative segments only (no absolute path, no `.`/`..`, no hidden
files), images only (`png`, `jpeg`, `webp`, `gif`, `svg`, `avif`), 2.5 MB per asset,
20 MB of inlined data per package. A read that fails leaves the preset without an
image; it never fails the install.

### Job metadata

A material field can write into the slice job's metadata (`metadataPath` on a
`materialSettings` field), and a package can ask the host to bake a scene payload
into it when such a path is `true`:

```json
"jobMetadataPayloads": [
  { "settingPath": "echo.embedScene", "payloadPath": "echo.sceneBase64", "payload": "voxl-scene" }
]
```

The host knows the payload *kinds* it can produce (`voxl-scene` today) and skips a
kind it does not implement, so a package may name something newer than the build.
The baked value arrives at the encoder as part of `job.metadata_json` — parse it,
look up `payloadPath`, and do what your format needs with the bytes. Limits: 8
declarations, dotted paths of letters, digits, `.`, `_` and `-`.

### Seal

`payload.bin` is `XChaCha20-Poly1305` over `payload.zip`, keyed by
`Argon2id(passphrase, salt, m, t, p)`. The authenticated tag is what makes a
modified ciphertext a load failure rather than a corrupt plugin.

What the seal buys: a leaked `.dfplugin` is inert without the passphrase, so a
customer cannot re-share the vendor's closed-source binary by copying one file.
What it does not buy: anything at runtime. The app must decrypt the payload to
run it, and the user's machine holds both, so a determined user can dump the
executable. Treat the seal as distribution control, not DRM.

### Key handling

- The passphrase is typed once at import. The **derived key**, not the
  passphrase, is stored in the plugin's directory with owner-only permissions.
  A passphrase reused elsewhere is therefore not exposed by a config leak.
- The sealed package is kept so a later re-import can be verified against the
  same fingerprint.
- Removing the plugin deletes the key with it. Re-importing needs the
  passphrase again.
- Three names, deliberately distinct: `vendor.name` is the publisher a person
  recognises, `publisher.key` is the signing key in the manifest, and what the UI
  shows is that key's SHA-256 fingerprint. The fingerprint is the identity pinned
  on first import; the publisher name is never verified by the signature.

## Protocol v1

Two channels between host and plugin process. Control is text-shaped and easy
to log; bulk is zero-copy and never parsed by the other side.

### Control channel: length-prefixed frames on stdio

```
frame  := u32 length (LE) | u8 kind | payload[length-1]
kind 0 := JSON (UTF-8)
kind 1 := bulk bytes (reserved for the pipe transport, not implemented yet)
```

Handshake, in order:

```json
host   → {"type":"hello","proto":1,"transport":"shm","appVersion":"0.4.0"}
plugin → {"type":"ready","pluginId":"alphabeta.alphaprint","version":"1.0.0",
          "capabilities":["slicerEncoder"],"formats":[{"ext":".apf"}]}
```

A capability or format the manifest did not declare ends the session with
`undeclared-capability`. The full message reference lives in
`docs/dev/plugins-sdk/protocol.md`; the shapes on the wire today are:

| Direction | Messages |
| --- | --- |
| host → plugin | hello, shutdown, network, encodeBegin, encodeLayer, encodeEnd, import, preview |
| plugin → host | ready, networkResult, slotFree, progress, encodeDone, importDone, previewPng, error |

An encode session:

```json
host   → {"type":"encodeBegin","id":7,"format":".apf","layers":1200,"job":{ …SliceJobV3… }}
host   → {"type":"encodeLayer","id":7,"index":0,"slot":3,"kind":"rle","bytes":182344}
plugin → {"type":"slotFree","slot":3}
plugin → {"type":"progress","id":7,"done":1,"total":1200}
host   → {"type":"encodeEnd","id":7,"output":"/…/job.apf"}
plugin → {"type":"encodeDone","id":7,"path":"/…/job.apf","bytes":48123904}
```

`encodeLayer` names a slot the host has already filled; the plugin reads it in
place and answers with a slot-free message when done. The session ends at the
host's encode-end message, which is
where the output path arrives.

One request, one answer, for the other capabilities:

```json
host   → {"type":"network","id":11,"request":{ …plugin_network_request payload… }}
plugin → {"type":"networkResult","id":11,"status":200,"body":{ … }}

host   → {"type":"import","id":12,"input":"/…/job.apf","output":"/…/scene.dfimport"}
plugin → {"type":"importDone","id":12,"path":"/…/scene.dfimport"}

host   → {"type":"preview","id":13,"path":"/…/job.apf","layer":42}
plugin → {"type":"previewPng","id":13,"bytes":182344}
```

The preview answer is followed by a bulk frame holding the PNG.

### Bulk channel: a file-backed ring of byte slots

The host creates one mapping file per plugin session
(`plugins-sideloaded/<id>/session-<pid>.ring`) and passes its path in the spawn
environment. Both processes map it read-write. Layout, all little-endian:

```
header (4096 bytes)
  0   u32 magic        0x44465247 ("DFRG")
  4   u32 version      1
  8   u32 slotCount
  12  u32 slotBytes
  16  u32 layerCapacity
  20  u32 reserved
  24  u64 seq          bumped by the host on every publish
slot headers (64 bytes each, after the page)
  0   u32 state        0 free | 1 filled | 2 consuming
  4   u32 kind         1 png | 2 rle | 3 raw mask
  8   u32 layerIndex
  12  u32 bytes
  16  u32 width
  20  u32 height
  24  u64 seq          matches header.seq when filled
payloads (slotBytes each, page-aligned, after the slot headers)
```

Rules:

- Ownership moves host→plugin only by publishing a slot (`state=1`, `seq`
  bumped, then one byte on the control pipe to wake the plugin). It moves
  plugin→host by writing `state=0`. No other transition is legal.
- The ring carries **bytes only**. No pointers, no structs with references, no
  shared allocator. A slot is never read by both sides at once, so there is no
  lock beyond the state word.
- Defaults: 4 slots × 64 MB. Only written pages become resident, so an idle
  session costs one mapping, not 256 MB.
- The host removes the mapping file on session end; a stale file is unlinked
  on next start.

Why the ring at all — engine numbers for a 3000-layer job:

| Payload | Per layer | Job total | Pipe at ~2 GB/s | Ring |
| --- | --- | --- | --- | --- |
| raw mask 11520×5120 | ~59 MB | ~170 GB | ~85 s, and malloc churn | written in place by the rasterizer |
| PNG layer | ~1–2 MB | ~3–6 GB | ~2–3 s | ~0 |
| RLE runs | tens–hundreds of KB | ~0.5 GB | <1 s | ~0 |

A pipe-only mode is a supported configuration (`transport: "pipe"` in the
manifest), not a degraded branch to maintain: the same frames carry the bytes. It
exists so a partner who wants the conservative reading can ask for it, and a
package that asks for it today is refused rather than quietly given a ring.

### Compatibility rules

- Major bump for any frame shape or slot-layout change; minor for appending
  fields that older readers can ignore. The host refuses a `proto` it does not
  know.
- An unknown frame type is an error, not a skip.
- The plugin must treat every JSON field it does not recognise as absent.

## Host integration

- **Encoders.** An adapter implements `FormatEncoder` over the protocol and is
  appended to the runtime registry in
  `rust/dragonfruit-slicing-engine/src/encoders/registry.rs`. Compiled-in
  encoders win an extension collision; a sideloaded encoder never displaces
  `.ctb`, `.goo`, `.aff` and friends. `create_rle_stream_encoder` and
  `create_raw_mask_stream_encoder` map onto the pipeline path (the ring is what
  makes that worthwhile); `encode_container_to_path_with_progress` maps onto
  `encode.begin`/`encode.layer`/`encode.done`; `read_layer_preview_png` maps
  onto the same request/response shape. Capabilities the plugin does not
  implement stay at the trait's defaults.
- **Network.** Sideloaded ids are consulted after the generated match in
  `src-tauri/src/plugin_registry.rs`, so a package cannot shadow a built-in
  plugin id.
- **File types.** The import registry gains sideloaded entries with the same
  gating as compiled-in ones; the path API route and the desktop bridge both
  need the extra source.
- **Process lifecycle.** One process per plugin, spawned on first use, kept warm
  for network operations, killed after an idle timeout and on cancel. A crash
  fails the in-flight job only; the host respawns on next use.
- **Storage.** Each plugin owns a directory under the app data dir
  (`plugins-sideloaded/<id>/`): sealed package, manifest, derived key, extracted
  payload, ring files, and a state file with the publisher fingerprint, import
  date and enabled flag. App updates replace the install directory only, so this
  survives updates. Uninstalling means killing the process, deleting the
  directory and unregistering from the engine.
- **UI.** Settings → Plugins gains: the advanced "Allow sideloaded complex
  plugins" switch (default off); "Import plugin file…"; a review sheet showing
  publisher fingerprint, capabilities, formats, version and app range; a
  passphrase field when the package is sealed; and sideloaded rows in the
  installed list with enable/disable and remove. The review sheet uses the
  shared dialog modal like every other confirm in that tab
  (`src/components/settings/PluginsSettingsTab.tsx`).
- **Reload.** A successful import or removal ends in a reload prompt with no
  dismiss: the webview and the engine load encoders, network modes and file
  types at startup, and an install that only half-lands is worse than losing an
  unsaved scene. The prompt reloads on its own after 15 seconds, and closing it
  by any means reloads too, so there is one outcome rather than a choice.
  `refreshSideloadedContributions()` still runs first, so the registry is
  consistent even if the reload is interrupted.

## Platform constraints

- **macOS** is unproblematic for a spawned process: no library validation, no
  entitlements, hardened runtime stays strict. The executable lives in app data,
  written by the app, so no quarantine flag is attached.
- **Windows** builds are unsigned today, so a partner executable will attract
  SmartScreen and some AV heuristics on first run. Provenance comes from the
  package signature, not the OS.
- **Flatpak** needs nothing new: the plugin lives in the app's writable data
  dir, which the sandbox already sees, and spawning from there is ordinary `exec`.
- All paths go through the app data resolver, never a hardcoded location; a
  plugin directory outside it is not runnable in a packaged build.

## SDK

`rust/dragonfruit-plugin-sdk` (**MIT OR Apache-2.0**) is what a vendor builds
against; the guide is the [Plugin SDK](plugins-sdk/index.md) subsection. It contains:

- the frame codec and the ring-slot accessors,
- the capability traits (`Encoder`, `Network`, `FileType`) the vendor implements,
- `run_plugin(...)`, which owns the handshake, the control loop and slot
  handback, so a vendor's binary is a `main` plus one impl.

It contains no engine code, no `FormatEncoder`, no scene types. That is the
point: linking the SDK must not drag AGPL code into the vendor's binary.

## Licence boundary

DragonFruit is AGPL-3.0 and stays that way. A closed-source plugin is usable
because it is a **separate program**, and every mechanism in this tier exists to
keep it that way. The FSF's answer on plug-ins is the test:

> If the main program uses fork and exec to invoke plug-ins, and they establish
> intimate communication by sharing complex data structures, or shipping complex
> data structures back and forth, that can make them one single combined program.
> A main program that uses simple fork and exec to invoke plug-ins and does not
> establish intimate communication between them results in the plug-ins being a
> separate program. […] Using shared memory to communicate with complex data
> structures is pretty much equivalent to dynamic linking.

Read against what this tier does:

| Mechanism | Why it is there |
| --- | --- |
| spawn, never `dlopen` | a dynamically linked vendor library that calls into the host and shares its buffers is the combined-work case |
| messages are JSON over stdio | a documented protocol between two programs, not shared objects |
| the ring carries opaque bytes, with a published layout and no pointers, structs or allocator | the FSF sentence names *complex data structures*, and a byte buffer with one owner per slot is not one |
| the SDK and the package writer are MIT OR Apache-2.0 and hold no host or engine code | a vendor links the SDK, never DragonFruit, so their binary and their packaging tool carry no AGPL code; the dependency runs host to crate, never the reverse |
| the package is signed and pinned per publisher | provenance, not licensing: it says who built the file, and the AGPL argument does not depend on it |
| the payload is encrypted | distribution control, also not licensing: the app has to decrypt and run the code either way |

The same shape as an AGPL project that already hosts third-party plugins: Grafana
(AGPL-3.0) runs backend plugins as subprocesses over gRPC and publishes an
Apache-2.0 SDK. The projects that allow in-process plugins are either weak
copyleft (Odoo) or require the plugin to carry the same licence (Blender,
Nextcloud).

### Transport cost, so the choice is not made on vibes

Measured on this machine, one 3000-layer job, RLE payloads around 100 KiB per
layer:

| Path | Cost per layer |
| --- | --- |
| host: engine runs to wire bytes | ~6 µs (was ~72 µs before the run codec was rewritten) |
| ring: copy into the shared mapping | ~2 µs |
| pipe: write and read, a bulk frame per layer | ~18 µs |
| plugin: walk the runs | ~29 µs |

So the ring buys about 16 µs per layer over a pipe, roughly 50 ms on a
3000-layer job whose encode takes tens of seconds. It exists for payloads where
that is not true: a raw mask is ~59 MB per layer, and a pipe would be untenable
there. Since raw masks are not implemented, the default transport can and should
be decided on the licence argument rather than on throughput; `pipe` is designed
and a package that asks for it today is refused rather than silently given a
ring. If a partner or a reviewer reads the ring as too close to dynamic linking,
`pipe` is the answer and it costs the numbers above.

### What would actually break the boundary

- Handing the plugin a host struct, a callback into host code, or a buffer the
  host keeps mutating while the plugin reads it.
- Linking DragonFruit crates into the SDK, however convenient.
- Letting a plugin load host symbols or call into the engine instead of the
  protocol.

None of those are needed for any capability the tier ships, and each one would
turn a defensible arrangement into an argument.

## Threat model and non-goals

- The plugin is **native code with the user's privileges**. It is a separate
  process, so it is a separate crash domain and cannot corrupt host memory
  except through the ring it shares — but it can still read the user's files,
  open sockets and spawn processes. There is no OS sandbox in this tier, and the
  import sheet must say so in those words.
- Signatures prove *who built the package* and that it is unchanged since; they
  do not prove it is safe. First import is trust-on-first-use, pinned per id.
- The seal protects distribution only (see "Seal").
- The ring is shared writable memory. A malicious plugin can scribble in any
  slot; the host must validate `bytes`/`width`/`height` against the slot size
  before reading, and never trust `state` transitions it did not observe.
- Explicitly out of scope for v1: OS sandboxing, per-capability enforcement,
  plugin auto-update feeds, and running a package on a platform it did not
  ship a binary for.

## Building a package (vendor path)

1. Implement the capability traits with `dragonfruit-plugin-sdk`; build one
   executable per target platform.
2. Write `dfplugin.json`; list every capability you implement, every output
   extension you encode, and the transports you accept.
3. Zip the payload, hash it, seal it with the passphrase the customer will type,
   put the hash and seal parameters in the manifest.
4. Sign the manifest bytes with the publisher key and ship
   `dfplugin.json` + `signature.ed25519` + `payload.bin` as one `.dfplugin`.

Verification checklist for a change in this tier:

- `npm run check:docs` (this page cites real paths and symbols)
- `cargo check --manifest-path src-tauri/Cargo.toml` and the engine crate
- import a package built with the SDK example, confirm: bad signature refused,
  wrong passphrase refused, tampered payload refused, key change refused,
  unknown protocol refused, undeclared capability refused
- slice a job whose output format is provided only by the sideloaded encoder in
  both transports, and confirm the compiled-in formats still resolve
- kill the plugin mid-job: the job fails, the app survives, the next job
  respawns

## Related

- `docs/dev/plugins-framework.md` — the three tiers and the rules for each
- `docs/dev/plugins-complex-contributing.md` — the compiled-in path
- `docs/adr/0031-plugin-format-architecture.md` — submodule + codegen model
- `docs/adr/0047-sideloaded-complex-plugins.md` — why this tier exists
- `rust/dragonfruit-slicing-engine/src/encoders/mod.rs` — the traits the protocol mirrors
