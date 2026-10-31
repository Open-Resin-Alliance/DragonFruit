# Plugin SDK

A sideloaded plugin is a **process**. DragonFruit starts it, speaks a small
versioned protocol over stdio, and hands bulk layer data through a shared byte
ring. `rust/dragonfruit-plugin-sdk` gives you that protocol so your binary is a
`main` and one trait impl.

The reason the boundary is a process and an SDK rather than a `dlopen`: see
`docs/adr/0047-sideloaded-complex-plugins.md`. The package format, the trust
model and the host side are in `docs/dev/plugins-sideloaded.md`.

Throughout this section the example is **AlphaBeta**'s `AlphaPrint` plugin,
`alphabeta.alphaprint` with format `.apf`. That is an illustrative partner: no
real `.apf` exists. The reference plugins in the SDK use `.exf` (encoder) and
`.echo` (import), and those are what the tests drive.

## Status

Read this before trusting a page in this section. The protocol is being built in
slices, and each capability is either shipped or designed.

| Capability | Wire contract | SDK support | Host support |
| --- | --- | --- | --- |
| handshake (`hello` / `ready` / `shutdown` / `error`) | shipped | shipped | shipped: spawn, `ready` validation against the manifest, idle stop |
| `networkOperations` (`network` / `networkResult`) | shipped | shipped | shipped: routed after the built-in dispatch match |
| `slicerEncoder` (encode session + preview) | shipped | shipped | shipped: one process per session, ring in `DF_PLUGIN_RING`, RLE or PNG layers, adapter in the engine's encoder registry |
| ring accessors (slot publish / view / release) | shipped | shipped | shipped, for encoders |
| `fileType` (import messages) | shipped | shipped | shipped: extensions from the manifest, container parsed into geometry and supports |
| printer presets and material templates | shipped | not code: manifest arrays | shipped: registered through the profile store's plugin entry point |
| network mode | shipped | not code: the manifest's `network` block | shipped: the mode joins the Network Support list and the generic panels call the declared operations |
| job upload | shipped | not code: the `upload` operation | shipped: the host chunks a local file through `begin`/`chunk`/`end` with progress |
| material pane schema | shipped | not code: `materialSettings` | shipped: registered into the same map the compiled adapters use |
| on-device material list and edit | shipped | not code: `network.remoteMaterials` | shipped: one dialog, built from declared fields |

Pages mark their own status. A "designed" page is the contract to build against;
it is not a description of running code.

### Known gaps

Everything below is deliberate and has a reason, not an oversight. Each is
documented on its page.

| Gap | What happens instead |
| --- | --- |
| the `pipe` transport | specified, not implemented; the host refuses a package that asks for it rather than using the ring it did not ask for |
| a cancel message | the engine aborts and the host tears the process down; a plugin never gets to flush partial state |
| raw mask layers | not a layer kind; RLE already avoids the PNG round trip |
| per-layer area stats | not forwarded; a format that needs them has no way to ask today |
| cross-layer parallelism | layers arrive one at a time and the host waits for each slot; parallelise inside a layer |
| UI contributions | impossible by design: no remote JS in this tier. Presets, templates and a network mode are data and do travel; panels and custom adapters do not |
| remote material editing | not available to a declared mode: it needs an edit schema and per-field mapping, which the manifest cannot describe yet |
| hollowing and punch data in an imported scene | not carried by the container; models import without them |
| per-material geometry | lands with multi-material support |

## Mental model

```mermaid
flowchart LR
  subgraph DF[DragonFruit]
    H[host: import, verify,<br/>spawn, ring]
  end
  subgraph P[your binary]
    S[serve&#40;stdin, stdout, identity&#41;]
    C[your capability code]
  end
  H -- hello / shutdown / jobs --> S
  S -- ready / progress / errors --> H
  H <-- "shared ring: opaque byte slots" --> C
  S --> C
```

Three rules decide almost every design question in this section:

1. **Bytes cross the ring, JSON crosses the pipe.** Control messages are small
   and readable; layer payloads are not parsed by the other side at all.
2. **The manifest is the policy, the handshake is the claim.** The host shows
   the manifest's capabilities at import; at start it checks the plugin's
   `ready` against them and refuses a plugin that advertises more.
3. **The SDK has no DragonFruit code in it.** No engine types, no scene types,
   no host traits. That is what keeps your binary yours under licence, and it is
   also why the SDK cannot hand you a printer profile parser, an HTTP client or
   a database — bring your own crates.

## Lifecycle

| Step | Who | What happens |
| --- | --- | --- |
| import | host | signature, seal, `minAppVersion`, publisher fingerprint pin, payload extracted under the app data dir |
| enable | user | sideloading is off by default; the package-level import is gated behind an explicit acknowledgement |
| start | host | spawns `payload/bin/<platform>/<binary>`, sends `hello` with `proto` and `transport`, waits for `ready` |
| check | host | `ready.pluginId` must equal the manifest id; capabilities and formats must be a subset of the manifest's |
| work | both | one request per operation; progress and cancellation flow back over the pipe |
| stop | host | `shutdown`, then the process is expected to exit; an idle process is killed and respawned on demand |

The host keeps **one process per plugin**, warm between operations: state your
plugin builds up (HTTP pools, discovered printers, upload bookkeeping) survives
between calls, exactly as it would in a long-lived daemon.

## What a plugin cannot do

- **Ship UI.** There is no remote JS in this tier by design. A plugin cannot
  contribute settings panels, monitoring dashboards or custom editors; those are
  in-process TS contracts of the compiled-in tier. The host surface for a
  sideloaded plugin is the generic one: formats it can encode, operations it
  answers, file types it can import.
- **Touch the scene, the slicer or the filesystem layout.** It gets a job
  description, layer bytes and an output path. Nothing else is handed over.
- **Use DragonFruit's crates.** `zip`, the shared HTTP client, the mdns
  discovery helpers: bring your own. A plugin binary is a few MB larger for it.
- **Assume privileges it did not declare.** A package that declares
  `slicerEncoder` and answers a `network` request is refused.

## Content beyond code

Profiles, pane schemas and network modes are **data**, and a package can carry
them without shipping code for the webview:

- `printerPresets` / `materialTemplates` — the same JSON the simple tier uses, so
  one normaliser accepts both.
- `materialSettings` — the material pane schema compiled plugins write in
  TypeScript, per output format. The renderer validates it once and renders it with
  the same form.
- `network` — the mode, its display name, discovery hostnames and operation names.

Anything that needs its own rendering is the **UI island** in
`docs/dev/plugins-sdk/ui.md`: designed, sandboxed, not built. Until it exists, a
pane a vendor needs is integrated in mainline as a declarative shape.

## Why this is AGPL-compatible

DragonFruit is AGPL-3.0 and a closed-source plugin is a separate program, not a
derivative: it is spawned, it talks to the host through a documented protocol,
and the only memory the two share is a ring of opaque bytes with no pointers or
structs in it. The SDK and the package writer are MIT OR Apache-2.0 and contain
no host or engine code, so a vendor links the SDK and nothing else. The argument,
the precedent it follows and the measured transport costs are in
`docs/dev/plugins-sideloaded.md` under "Licence boundary".

## Pages

- `docs/dev/plugins-sdk/authoring.md` — build, seal, pack, import a working plugin
- `docs/dev/plugins-sdk/protocol.md` — frames, messages, the ring, versioning
- `docs/dev/plugins-sdk/encoders.md` — the `slicerEncoder` contract
- `docs/dev/plugins-sdk/network.md` — the `networkOperations` contract, including
  the declared mode and chunked upload
- `docs/dev/plugins-sdk/file-types.md` — the `fileType` contract
- `docs/dev/plugins-sdk/ui.md` — what a package can render today, and the planned
  UI island
- `docs/dev/plugins-sideloaded.md` — host side: package format and verification
