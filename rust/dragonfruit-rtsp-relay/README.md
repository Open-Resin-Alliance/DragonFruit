# dragonfruit-rtsp-relay

Native RTSP relay crate used by DragonFruit desktop runtime (Tauri).

It provides a local WebSocket endpoint that:

1. Pulls RTSP/RTSPS streams via ffmpeg
2. Converts output to JSMpeg-compatible MPEG-TS bytes
3. Broadcasts stream chunks to all connected subscribers
4. Persists per-URL reclaim lease/session metadata for reconnect stability

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

- deterministic `base_port` (even RTP base)
- optional `session_id`
- last-known client/server RTP ports
- last claim status/timestamps

Lease records are persisted to JSON and reused across process restarts.

### Deterministic UDP port reuse

On UDP attempts (when reclaim enabled), ffmpeg receives:

- `-min_port <base_port>`
- `-max_port <base_port + 1>`

This stabilizes RTP/RTCP client ports per stream URL.

### Session hint reuse

If enabled and a session ID exists, ffmpeg is invoked with:

- `-headers "Session: <id>\r\n"`

stderr parsing updates lease status:

- `session not found` / `454` => session cleared
- `Session:` token observed => session recorded

### Transport fallback

Transport order comes from `DRAGONFRUIT_RTSP_TRANSPORT`.

Default behavior (`auto`) tries UDP first, then TCP fallback when UDP produces no media output.

---

## Environment variables

- `DRAGONFRUIT_RTSP_RECLAIM` (default: `true`)
- `DRAGONFRUIT_RTSP_SESSION_HEADER_REUSE` (default: `true`)
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

- Keep `docs/RTSP_RECLAIM_API_CONTRACT.md` and this README aligned with behavior changes.
- Prefer additive claim status values (for frontend observability) over silent behavior changes.
- Preserve backwards-compatible status fields unless frontend has migrated.
