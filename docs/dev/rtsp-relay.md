# RTSP Relay

The native RTSP relay (`rust/dragonfruit-rtsp-relay/`) used by the DragonFruit desktop runtime (Tauri).

It provides a local WebSocket endpoint that:

1. Pulls RTSP/RTSPS streams via ffmpeg
2. Converts output to JSMpeg-compatible MPEG-TS bytes
3. Broadcasts stream chunks to all connected subscribers
4. Persists per-URL reclaim lease/session metadata for reconnect stability

## Goals

- Avoid unbounded UDP client-port churn across reconnect cycles.
- Persist per-stream lease/session hints between restarts.
- Provide deterministic debug status for integration and diagnostics.

---

## Why this crate exists

Packaged desktop runtime cannot rely on a Node/Next API process to host relay behavior. This crate moves relay lifecycle and reclaim logic into native Rust, while exposing a stable command/status contract to the frontend.

---

## Runtime surfaces

### Tauri-facing status entry

- `ensure_rtsp_relay_status(rtsp_url: Option<&str>) -> RelayStatusResponse`

When `rtsp_url` is provided and valid:

- stream state is initialized lazily
- lease data is loaded/created
- transport + reclaim debug payloads are returned

### WebSocket stream endpoint

- Path: `/api/rtsp-relay/stream`
- Query: `url=<encoded rtsp://...>`
- Payload: starts with JSMpeg `jsmp` header, then MPEG-TS chunks

---

## Reclaim model

For each normalized RTSP URL, the crate stores a lease record that includes:

- optional `session_id`, recorded from ffmpeg's own output
- last-known client/server RTP ports and the last claim status/timestamps

Lease records are persisted to JSON and reused across process restarts. The record is the
reclaim index: the reconnection audit in `docs/internal/rtsp-session-recovery.md` needs the
last observed session id, and this is where it lives.

stderr parsing updates lease status:

- `session not found` / `454` => session cleared
- `Session:` token observed => session recorded

Deterministic UDP port pinning and `Session:` header reuse were removed in 0.1.1. The printer
this relay serves (Chitu-based MSLA boards) exhausts TCP worker slots, not RTP client ports,
so neither mechanism could influence whether a reconnect succeeded. See the audit for the
measurements.

### Retry backoff

The relay pump retries with exponential backoff — 750 ms, doubling to a 30 s ceiling, reset as
soon as media flows. It must not open a fresh RTSP connection on every retry: a printer that is
refusing connections leaks one descriptor per rejected attempt, so a tight retry loop makes the
printer's own exhaustion worse.

### Stream-slot exhaustion

A printer that has run out of free video-stream slots accepts an RTSP connection and then sends
nothing. Retrying cannot help, and each attempt is not free — a Chitu-based printer leaks a
descriptor per rejected connection — so the relay asks before it retries:

- **Oracle.** Those boards report `NumberOfVideoStreamConnected` and `MaximumVideoStreamAllowed` in
  the attribute reply to SDCP command `0x01` on port 3030, and the relay compares the two. Command
  `0x182` looks like the natural oracle but is gated on more than those counters: measured against
  a printer with zero of two slots connected, it still refuses a stream, so it cannot distinguish
  exhaustion from whatever else makes a printer decline. Anything the probe cannot read, another
  vendor's printer, a host that is down, a protocol surprise, is treated as *unknown*, and the
  relay behaves exactly as it did before this probe existed. Best effort by design: the crate stays
  printer-agnostic.
- **Reclaim.** The lease record's `session_id` names a media slot the printer still believes is in
  use. The printer matches the named session against a global table rather than against the
  connection the request arrived on, so the relay can send a `TEARDOWN` naming it from its own
  connection and free that slot immediately, recovering the stream limit without a printer
  restart. It cannot free a *worker* slot: a printer whose ten connections are all pinned still
  needs a restart.
- **Status.** Both outcomes are written to the lease record's `last_claim_status`
  (`printer-stream-slots-exhausted`, `reclaimed-stale-session`, `reclaim-stale-session-failed`,
  `no-media-first-output-timeout`), which the monitor's RTSP debug overlay already renders.

Retries drop straight to the maximum interval once exhaustion is detected, and return to the short
interval as soon as media flows again.

### First-output deadline

An ffmpeg attempt that has produced no media at all is killed after 12 seconds. The RTSP demuxer
has no default socket timeout, so without this a printer that accepts a connection and then stays
silent leaves the pump blocked in its stdout read forever.

### Transport fallback

Transport order comes from `DRAGONFRUIT_RTSP_TRANSPORT`.

Default behavior (`auto`) tries UDP first, then TCP fallback when UDP produces no media output.

---

## Environment variables

- `DRAGONFRUIT_RTSP_RECLAIM` (default: `true`)
- `DRAGONFRUIT_RTSP_LEASE_TTL_MS` (default: `60000`)
- `DRAGONFRUIT_RTSP_LEASE_STORE_PATH` (optional path override)
- `DRAGONFRUIT_RTSP_TRANSPORT` (`auto`, `udp`, `tcp`, `udp,tcp`, `tcp,udp`)
- `DRAGONFRUIT_FFMPEG_PATH` / `FFMPEG_PATH` / `FFMPEG` (binary override)
- `DRAGONFRUIT_FFMPEG_AUTODOWNLOAD` (default: `true`)

Boolean flags parse `0|false|off|no` as false; other provided values as true.

---

## ffmpeg resolution

Resolution order:

1. explicit env override (`DRAGONFRUIT_FFMPEG_PATH`, `FFMPEG_PATH`, `FFMPEG`)
2. `ffmpeg-sidecar` managed binary path
3. optional `ffmpeg-sidecar` auto-download
4. fallback to `ffmpeg` on `PATH`

---

## Notes for maintainers

- Keep this page aligned with behavior changes.
- Prefer additive claim status values (for frontend observability) over silent behavior changes.
- Preserve backwards-compatible status fields unless frontend has migrated.
