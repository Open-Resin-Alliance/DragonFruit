# Network operations

Status: **shipped**. The host spawns the plugin, validates `ready` against the
manifest, routes `plugin_network_request` to it after the built-in dispatch
match, and stops the process after two idle minutes. Concurrent requests and
cancellation are the parts still designed.

A network capability is request/response JSON over the control channel — the same
contract the compiled-in tier already uses between the webview and the shell, so
a plugin written against it is a port, not a rewrite.

## Messages

```json
→ {"type":"network","id":11,
   "request":{"operation":"printer/status","serial":"AB-12-34"}}
← {"type":"network.result","id":11,"status":200,
   "body":{"state":"printing","progress":0.42,"layer":312,"total":740}}
```

- `request` is the payload the frontend sent, verbatim: `operation` plus whatever
  fields that operation needs. The plugin owns the operation vocabulary; the host
  only routes on the plugin id.
- `status` is an HTTP-like code. `2xx` is success, `4xx` is a caller mistake,
  `5xx` is the printer or the network. The host passes it through, so existing
  UI error handling keeps working.
- `body` is arbitrary JSON. The host does not inspect it.
- **Protocol-level failures are not `5xx`.** A malformed message, a capability
  that was not declared, or a plugin that died mid-request are reported as
  protocol errors; `5xx` means "my integration talked to the printer and it said
  no".

## Operations

The plugin defines them. Keep a namespace so the host logs and the UI can group
them, and keep the shape stable once shipped:

| Operation | Typical use |
| --- | --- |
| `connect` | resolve host, log in, cache the session |
| `discover` | find printers on the LAN, return candidates |
| `printer/status` | poll state, used by the monitoring surface |
| `printer/start`, `printer/pause`, `printer/stop` | job control |
| `job/upload-progress` | progress for an upload started earlier |
| `materials` | read or edit material settings on the printer |

An unknown operation answers `404` with a body naming it; that is how the host's
dispatch layer behaves for compiled-in plugins too.

## The process is warm

The host keeps one process per plugin and does not restart it between
operations. That is a feature:

- keep the HTTP client, connection pool and TLS session;
- cache discovery results with your own TTL;
- keep in-flight upload state keyed by an id you return to the caller, so
  progress can be polled with a second operation.

It is also a rule: **do not leak.** A plugin that holds a socket open forever
blocks the host's idle kill; bound your timeouts and clear state when a request
completes.

## Concurrency

Requests for one plugin are serialized by default, in arrival order. That is
what ships today. A plugin that can serve two operations at once will say so in
`ready`:

```json
{"type":"ready", …, "concurrent":true}
```

The host then allows overlapping requests, and your handler must be thread-safe.
Start serialized: printer protocols are the bottleneck, not your dispatch.

## Example: AlphaPrint

```rust
async fn handle(operation: &str, payload: &serde_json::Value) -> (u16, serde_json::Value) {
    match operation.trim_matches('/') {
        "connect" => alphaprint_connect(payload).await,
        "discover" => alphaprint_discover(payload).await,
        "printer/status" => alphaprint_status(payload).await,
        "printer/start" => alphaprint_start(payload).await,
        "job/upload-progress" => alphaprint_upload_progress(payload).await,
        other => (404, serde_json::json!({ "error": format!("unknown operation: {other}") })),
    }
}
```

That `match` is the whole host-facing surface. Everything behind it — HTTP,
websockets, discovery, retries — is your code in your process, with your crates.

## Declared network modes

A network capability that only answers an operation vocabulary is invisible: the
printer profile's **Network Support** list is built from registered adapters.
Declaring the mode in the manifest registers yours, so the list, the discovery
panel, the connection test and the monitor all call your process through
`plugin_network_request`.

```json
"network": {
  "pluginId": "alphabeta.alphaprint",
  "mode": "alphaprint-net",
  "displayName": "AlphaPrint Network",
  "hostnames": ["alphaprint.local"]
}
```

- `mode` is the slug a printer profile stores in `networkSupport`. Lowercase
  `a-z`, `0-9` and `-`, at most 48 characters. It appears on a printer preset as
  `"networkSupport": "alphaprint-net"`, so adding that printer selects the mode.
- `displayName` is what the list shows; it defaults to the manifest name.
- `hostnames` are `*.local` candidates the discovery panel tries before it scans
  the subnet (`at most 8`).
- `pluginId` must be the package's own id. The host refuses a package that names
  another plugin's handler.
- The block requires the `networkOperations` capability.
- A compiled plugin owns its mode: a package that declares `nanodlp` or `sdcp`
  is ignored for that mode. Two packages claiming one free mode: the first
  installed one answers.

### Operation names

Unlisted operations use these names; a backend with its own vocabulary overrides
any of them:

```json
"network": {
  "pluginId": "alphabeta.alphaprint",
  "mode": "alphaprint-net",
  "operations": { "connect": "net/connect", "status": "net/printer" }
}
```

| Key | Default | Called by |
| --- | --- | --- |
| `connect` | `connect` | connection test, cached-printer verification |
| `discover` | `discover` | discovery panel (local hostnames, then subnet batches) |
| `status` | `status` | monitor polling, reachability probes |
| `start` | `start` | print start |
| `pause`, `resume`, `cancel` | same names | job control |
| `deletePlate` | `deletePlate` | plate management |
| `emergencyStop` | `emergencyStop` | job control |
| `platesList` | `platesList` | plate list |
| `webcamInfo` | `webcamInfo` | webcam panel (answer `available:false` when there is none) |
| `printerData` | not declared | variant detection, only when the preset sets `modelVariantDetectPath` |
| `materials`, `materialsEdit` | same names | on-device material list and edit, when the mode describes the fields |

### On-device materials

A mode that lists the printer's own materials declares `network.remoteMaterials`.
The panel then shows the list, fills the connection card from the selected
material, and opens the edit dialog built from the declared fields.

```json
"network": {
  "pluginId": "alphabeta.alphaprint",
  "mode": "alphaprint-net",
  "remoteMaterials": {
    "primaryFields": [
      { "key": "exposureSec", "label": "Exposure (s)", "defaultValue": 2.5, "kind": "number",
        "description": "Per-layer exposure on the device." },
      { "key": "liftMm", "label": "Lift (mm)", "defaultValue": 6, "kind": "number",
        "aliases": ["liftDistanceMm"] }
    ],
    "basicSections": [{ "id": "print", "title": "Print", "keys": ["exposureSec", "liftMm"] }],
    "advancedSections": [{ "id": "advanced", "title": "Advanced", "keywords": ["lift"] }]
  }
}
```

| Operation | Request | Reply |
| --- | --- | --- |
| `materials` | `{ host }` | `{ materials: [{ id, name, locked?, meta? }] }` |
| `materialsEdit` | `{ host, profileId, fields }` | `{ ok: true }` or `{ error }` |

- `meta` carries the field values by key. The dialog reads `meta[key]`, falls back
  to each field's `aliases`, then to `defaultValue`; saving sends the same keys back
  as `fields`, so a backend that wants another wire shape maps it behind
  `materialsEdit`.
- The connection card's process values come from fixed `meta` keys:
  `layerHeightMm`, `normalExposureSec`, `bottomExposureSec`, `bottomLayerCount`.
- `basicSections[].keys` groups fields; `advancedSections[].keywords` decides which
  advanced section a field belongs to (case-insensitive substring).
- Field kinds: `number`, `integer`, `text`, `boolean`, `select` (with `options`).
  Limits: 128 fields, 32 sections per kind. A field without a `key` or with a
  duplicate key is dropped; a schema with no usable field turns listing off.

### Monitoring policy

A packed mode leaves the monitor's defaults alone. If the printer answers slowly,
`network.monitoring` tunes the panel instead — all fields optional, clamped to
sane bounds:

```json
"network": {
  "pluginId": "alphabeta.alphaprint",
  "mode": "alphaprint-net",
  "monitoring": {
    "busyResponseGraceMs": 45000,
    "inconclusiveReachabilityMaxPolls": 3,
    "supportsWebcamStreamSlotReset": true
  }
}
```

| Field | Meaning | Bound |
| --- | --- | --- |
| `busyResponseGraceMs` | how long online state survives a slow poll | ≤ 120000 |
| `inconclusiveReachabilityMaxPolls` | inconclusive probes before offline | ≤ 100 |
| `webcamMaxConsecutiveTimeouts` | timeouts before a cooldown | ≤ 100 |
| `webcamTimeoutCooldownMs` | cooldown length after timeouts | ≤ 600000 |
| `webcamFailureCooldownMs` | cooldown after an immediate failure | ≤ 600000 |
| `supportsWebcamStreamSlotReset` | offer the manual stream reset | boolean |

### Uploading a job

A compiled plugin uploads through a handler it registers in the webview. A package
has no handler, so it declares `upload` and the host drives a chunk loop:

| Phase | Request | Reply |
| --- | --- | --- |
| `begin` | `{ phase:"begin", host, path, sourcePath, totalBytes, profileId }` | `{ uploadId }` |
| `chunk` | `{ phase:"chunk", uploadId, offset, length }` | `{ received }` |
| `end` | `{ phase:"end", uploadId }` | `{ ok:true, plateId? }` or `{ error }` |

`sourcePath` is a path on the same machine — the plugin process reads the file
itself, which is why a chunk carries no bytes. Each `chunk` must consume exactly
`length` bytes starting at `offset`; `received` is what the panel shows as
progress, so report the running total. Requests are serialized, so the upload is
sequential by construction; the panel computes speed and remaining time from the
byte counts and the clock.

The file is the sliced container the user just produced, not the scene.

### Payload contract

The request is the panel's payload — the fields below are the ones it always
sends — and the reply uses fixed keys. Unknown keys are ignored, missing ones
read as "no value", and a reply that is not an object is treated as empty rather
than trusted.

```json
→ {"operation":"connect","host":"192.168.1.50"}
← {"connected":true,"ipAddress":"192.168.1.50","hostName":"printer",
   "printerName":"AlphaPrint 4K","printerModel":"AP-4K","statusText":"Idle"}
```

| Operation | Reply |
| --- | --- |
| `connect` | `{ connected, ipAddress?, hostName?, printerName?, printerModel?, statusText? }` |
| `discover` | `{ devices: [{ ipAddress, hostName?, printerName?, printerModel?, statusText? }], done?, nextBatchStart?, totalEndpoints?, scannedEndpoints? }` |
| `status` | `{ connected, stateText?, isPrinting?, isPaused?, finished?, progressPct?, currentLayer?, totalLayers?, plateId?, jobName?, etaSec? }` |
| `start`, `pause`, `resume`, `cancel`, `deletePlate`, `emergencyStop`, `materialsEdit` | `{ ok: true }` or `{ error: "…" }` |
| `materials` | `{ materials: [] }` (reserved) |
| `webcamInfo` | `{ available, streamUrl?, snapshotUrl?, message? }` |
| `printerData` | `{ bitdepth: 8 }` |

`discover` is called twice: once with `scanScope: "local-hostnames"` and a
`localHostnames` candidate list, then with `scanScope: "subnet"` and
`batchStart`/`batchSize`. Answer `done: true` when your scan is finished; the
panel stops when `done` is set or `nextBatchStart` does not advance, so a backend
that ignores the batching cannot spin it forever.

Numeric fields accept numbers or numeric strings. Everything else must have the
declared type to be used; a wrong type is dropped, not coerced silently into the
monitor.

## What the host provides

- The single dispatch point: one request in, one result out, ordered per plugin.
- Timeouts on the host side, reported as protocol failures so the UI can tell
  "no answer" from "printer said no".
- Cancellation for long operations (designed): `{"type":"cancel","id":11}`, and
  the plugin answers with a `network.result` carrying `499`.

## What it does not provide

- **No printer discovery helpers, no HTTP client, no TLS.** Bring your own; a
  plugin binary pays for its own `reqwest` or `ureq`.
- **No shared session with the host.** The host is not logged into the printer;
  you are.
- **No custom UI.** A plugin cannot add a settings panel or a monitoring
  dashboard in this tier. What it can do is declare a network mode (below) and
  answer the fixed payload contract, so the generic panels — Network Support
  list, discovery, connection test, job control, status line — drive it.
