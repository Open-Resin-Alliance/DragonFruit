# RTSP Reclaim API Contract (DragonFruit Native Rust Relay)

## Goal

Provide deterministic RTSP reconnect behavior in desktop/runtime mode so repeated monitor reconnects (including app restarts) do not continually consume new UDP client ports on firmware with strict session limits.

## Scope

This contract applies to DragonFruit’s native relay crate:

- `rust/dragonfruit-rtsp-relay`

It supersedes the earlier fork-proposal contract for the Node-based relay.

---

## Public status API (Tauri command)

### Command

`ensure_rtsp_relay(rtspUrl?: string)`

Returns relay availability and (optionally) reclaim/debug metadata for the requested stream URL.

### Response shape

```ts
type RelayStatusResponse = {
  ok: boolean;
  message: string;
  wsBaseUrl?: string; // ex: ws://127.0.0.1:<port>/api/rtsp-relay/stream
  rtspDebugTransport?: {
    clientPort?: number;
    serverPort?: number;
    transportHeader?: string;
    updatedAtEpochMs?: number;
  };
  rtspReclaimDebug?: {
    activeSessionId?: string;
    clientRtpPort?: number;
    serverRtpPort?: number;
    lastClaimStatus?: string;
    lastClaimAtMs?: number;
    updatedAtMs?: number;
  };
  error?: string;
};
```

### WebSocket stream endpoint

`ws://127.0.0.1:<relayPort>/api/rtsp-relay/stream?url=<encoded-rtsp-url>`

Notes:

- Only `rtsp://` and `rtsps://` URLs are accepted.
- If client sends `Sec-WebSocket-Protocol`, relay echoes the first offered protocol token.
- Stream payload begins with a JSMpeg 8-byte header (`jsmp`).

---

## Lease persistence contract

Leases are keyed by normalized RTSP URL and persisted as JSON.

### Store location

Priority order:

1. `DRAGONFRUIT_RTSP_LEASE_STORE_PATH`
2. `${tempDir}/dragonfruit-rtsp-relay-leases.json`

### Disk shape

```ts
type LeaseStoreDisk = {
  leases: Record<string, LeaseRecord>;
};

type LeaseRecord = {
  basePort: number;             // deterministic even RTP base
  updatedAtMs: number;
  sessionId: string | null;
  clientPort: number | null;    // current/last RTP client port
  serverPort: number | null;    // best-known server RTP port
  transportHeader: string | null;
  lastClaimStatus: string | null;
  lastClaimAtMs: number | null;
};
```

---

## Deterministic UDP reclaim behavior

For each URL, relay computes a stable even `basePort` within a bounded range using FNV-1a hashing. When reclaim is enabled and transport attempt is UDP:

- ffmpeg receives:
  - `-rtsp_transport udp`
  - `-min_port <basePort>`
  - `-max_port <basePort + 1>`

This gives a stable RTP/RTCP port pair across reconnects for a given URL.

---

## Session reuse behavior

If reclaim and session-header reuse are enabled, and a lease has `sessionId`, relay injects:

- `-headers "Session: <sessionId>\r\n"`

Relay stderr parsing updates reclaim state:

- line contains `session not found` / `454` ⇒ clear `sessionId`, set `lastClaimStatus = "session-not-found"`
- line contains `Session: ...` ⇒ record `sessionId`, set `lastClaimStatus = "session-recorded"`

On successful media output, relay marks:

- `clientPort = basePort`
- `lastClaimStatus = "playing"`

---

## Transport fallback behavior

Configured transport order is controlled by `DRAGONFRUIT_RTSP_TRANSPORT`:

- `udp` → `['udp']`
- `tcp` → `['tcp']`
- `udp,tcp` / `auto` / empty → `['udp', 'tcp']`
- `tcp,udp` → `['tcp', 'udp']`

If UDP produces no media output and reclaim is enabled, relay records:

- `lastClaimStatus = "udp-no-output-fallback-tcp"`

then retries over TCP.

---

## Lease expiry semantics

Lease TTL is controlled by `DRAGONFRUIT_RTSP_LEASE_TTL_MS` (default `60000`).

When record age exceeds TTL during update flow:

- `sessionId` is cleared
- `lastClaimStatus = "lease-expired"`
- `lastClaimAtMs = updatedAtMs`

---

## Environment controls

- `DRAGONFRUIT_RTSP_RECLAIM` (default: `true`)
- `DRAGONFRUIT_RTSP_SESSION_HEADER_REUSE` (default: `true`)
- `DRAGONFRUIT_RTSP_LEASE_TTL_MS` (default: `60000`)
- `DRAGONFRUIT_RTSP_LEASE_STORE_PATH` (optional path override)
- `DRAGONFRUIT_RTSP_TRANSPORT` (`auto`, `udp`, `tcp`, `udp,tcp`, `tcp,udp`)
- `DRAGONFRUIT_FFMPEG_PATH` / `FFMPEG_PATH` / `FFMPEG` (binary override)
- `DRAGONFRUIT_FFMPEG_AUTODOWNLOAD` (default: `true`)

Boolean env parsing treats `0|false|off|no` as false; all other present values are true.

---

## Non-goals

- Forcing remote TEARDOWN compliance on all printer firmware.
- Guaranteeing perfect stale-session cleanup after hard power loss/crash.
- Full RTSP/RTP session reconstruction beyond deterministic client ports + best-effort session hint reuse.

---

## Acceptance criteria

- Reconnect attempts for the same URL should reuse deterministic UDP client ports.
- Reclaim debug fields should show status transitions and persisted session hints.
- App/browser restarts should retain lease data (via disk store) and avoid unbounded stream-client growth in normal operation.
