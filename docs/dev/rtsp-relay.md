# RTSP Relay Contract

DragonFruit’s native relay includes deterministic session reclaim behavior for repeated reconnect scenarios.

## Goals

- Avoid unbounded UDP client-port churn across reconnect cycles.
- Persist per-stream lease/session hints between restarts.
- Provide deterministic debug status for integration and diagnostics.

## Core behaviors

- Deterministic RTP client-port selection per normalized RTSP URL.
- Session-header reuse when reclaim is enabled and lease/session hints exist.
- Transport fallback behavior controlled via environment configuration.
- Lease TTL semantics for stale session invalidation.

## Integration points

- Tauri command exposes relay status/debug fields.
- WebSocket endpoint streams JSMpeg-compatible payloads.
- Environment controls define reclaim/fallback/storage policy.

For exact field-level API definitions, mirror updates from the canonical relay contract documentation.
