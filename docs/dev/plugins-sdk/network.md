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
- **No UI.** A plugin cannot add a settings panel or a monitoring dashboard in
  this tier. Keep operations self-describing and the host's generic surface (a
  status line, a progress bar, errors) will carry them.
