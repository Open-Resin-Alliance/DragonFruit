# RTSP session recovery

**Status:** plan, not landed. Branch `agents/rtsp-session-recovery`, worktree
`DragonFruit.worktrees/agents-rtsp-session-recovery`.

## Why this exists

The printing monitor's RTSP playback degrades after a few connects: the printer keeps
serving, then stops delivering video, then refuses new RTSP clients entirely until it is
rebooted. The current relay mitigations (the lease store, deterministic RTP port pinning,
`Session:` header reuse) do not recover from that state, because they address a different
layer than the one that gets exhausted.

## Evidence (measured on a Saturn 4 Ultra, firmware V1.5.2)

| # | Finding |
|---|---|
| 1 | The vendor RTSP server (`ireader/media-server`) is wrapped so that **each accepted TCP connection consumes one slot from a fixed pool of ten**. A slot is released only when that worker's client socket read returns — i.e. only when the client closes. |
| 2 | There is **no receive timeout** on the client socket and **no idle-session reaper**. |
| 3 | Holding ten connections open, then probing an eleventh: the TCP connect **succeeds** and then **hangs with no RTSP reply at all** — the accept loop discards the worker-create failure and never closes the accepted fd. |
| 4 | **Each refused connection therefore leaks one file descriptor** in the printer. A retry loop against a wedged printer makes things strictly worse. |
| 5 | Closing the ten held sockets restores full service **in under 0.5 s**, with no manual intervention. |
| 6 | A connection that completes a real session and sends `TEARDOWN` but keeps its socket open **still holds its worker** — `TEARDOWN` alone is not enough; the socket must close. |
| 7 | A separate, tighter limit sits above the worker pool: the printer advertises **two** concurrent video streams, and its SDCP live-stream command is advisory only (it returns the URL when a slot is free, and a bare `Ack` otherwise) — it never tears a session down. |
| 8 | `TEARDOWN` is matched against a **global session-id table**, not against the arriving connection, so a `TEARDOWN` naming a stale session tears down that session's media slot from any connection — but it still does not free the stale worker. |
| 9 | A connection with unacknowledged data queued dies on TCP retransmit exhaustion (minutes); a silent, idle connection is only reclaimed by TCP keepalive (default ~2 h). That difference is why the symptom feels permanent but occasionally "fixes itself". |

Findings 1-9 come from static analysis of the printer's `chitu` binary plus live
read-only probing; the full write-up, the probe tools and the reproduction script live
outside this repo in the S4U reverse-engineering workspace (`docs/chitu-hardware-RE.md`
section 17 there, with a `rtsp_leak_test.py` companion).

### Update: the media-slot counter is the one that sticks (measured later the same day)

While validating the P1 oracle, the printer was found reporting `NumberOfVideoStreamConnected: 2`
against `MaximumVideoStreamAllowed: 2` with **no client connected at all**.

| Observation | Measurement |
|---|---|
| Counter read 0 of 2 before any RTSP testing | SDCP attribute reply on the first probe |
| Now 2 of 2, stable | three separate reads, about an hour apart |
| `DESCRIBE` does not move it | read, `DESCRIBE`, read gives 2, 2, 2 |
| It does not decay | unchanged after 2 s idle |
| RTSP itself stays healthy at 2 of 2 | `OPTIONS` returns `200 OK` in 0.03 s |
| The app refuses to hand out a stream URL at 2 of 2 | SDCP command 0x182 returns a bare acknowledgement, and it does not do that at 0 of 2 |
| `DESCRIBE` carries no `Session:` header | the id only appears after `SETUP`, which is why the lease record learns it from ffmpeg's stderr |

So the binding constraint in normal use is **not** the ten-worker table. It is a two-slot media
counter which, once stuck, refuses live view while RTSP still answers perfectly. I could not
isolate what moves it from 0 to 2: `OPTIONS` and `DESCRIBE` do not, and isolating it needs
`SETUP`/`PLAY` followed by an abrupt close, which is deliberately **not** run against a printer
somebody is using, because it would deepen the leak rather than measure it. That experiment belongs
on a throwaway unit.

Consequences:

- P1's oracle is validated, and now reads these two counters. Command 0x182 turned out to be gated
  on more than the counters, so it is not usable as an exhaustion signal.
- P2's reclaim is the right shape for this leak, but it can only reclaim a session whose id we
  recorded while it was alive. The two slots stuck at the time of writing were not ours, so they
  cannot be reclaimed from here and a reboot is the only cure.
- A new question now outranks P3 and P4: **what increments that counter without decrementing it?**
  Until it is answered, "the printer refuses after a few connects" is a two-slot leak, not a
  ten-worker wall, and no relay-side change can rescue a client that never comes back to clean up.

## Why the current reclaim model cannot recover

1. **Deterministic RTP port pinning is aimed at the wrong layer.** The exhaustion is in TCP
   worker slots, not UDP client ports. Stabilising client ports changes nothing.
2. **`Session:` header reuse targets the media/session layer.** The printer's session table
   is a separate, smaller resource; reusing an id cannot free a pinned worker.
3. **`DRAGONFRUIT_RTSP_LEASE_TTL_MS` is a client-side notion only.** The printer never
   expires a session, so a lease record that has logically expired still describes a slot
   that is physically held.
4. **Speculative reconnects are actively harmful** (finding 4): every attempt against a
   wedged printer leaks a descriptor inside it.

## Design — three layers

### Layer 1: never pin a slot (no new dependencies)

- One stream per printer, one subscriber session per relay instance.
- Always `TEARDOWN` **and** close, including on error paths, watchdog ticks and app shutdown.
- Set `SO_LINGER` to zero on abandon so the printer sees an immediate RST rather than an
  orderly close, and disable keepalive inheritance on these sockets where the platform allows.
- **No speculative retry loop** while the printer reports no free stream slot.
- Bounded connect and first-reply deadlines; treat "socket open, no RTSP reply" as
  exhaustion, not as a network error.

### Layer 2: detect exhaustion properly (no new dependencies)

Two independent oracles, both cheap:

- **Transport oracle:** TCP connect succeeds but no RTSP reply arrives within the deadline
  (finding 3) — the printer's own signature for a full worker pool.
- **Session oracle:** the printer's SDCP live-stream request returns a bare acknowledgement
  instead of a stream URL when its stream slots are exhausted (finding 7). This is
  authoritative and cheap, and it distinguishes "printer busy with other clients" from
  "printer unreachable".

Surface both in the existing RTSP debug overlay, and classify the failure so the UI says
"printer has no free stream slot" rather than a generic playback error.

### Layer 3: recover a wedged printer (the interesting part)

Two recovery primitives, with different requirements:

**3a. Session-slot reclaim, no spoofing (cheap, partial).** Because `TEARDOWN` matches a
global session id (finding 8), a relay that remembers session ids it has seen can send a
`TEARDOWN` for a stale id from its own connection and free that media slot immediately.
This recovers the two-stream limit — the limit users actually hit first — without touching
the network layer. It does **not** free workspace slots, so the ten-worker ceiling still
needs Layer 3b or a reboot.

**3b. Worker-slot reclaim by forged TCP RST.** To make a pinned worker's `recv` fail, the
printer must see a reset for that connection. For a peer that is already gone there is no
other lever: keepalive is the only in-protocol remedy and it is measured in hours. So we
inject a RST that appears to come from the vanished peer.

Requirements, in full, because they are the whole argument:

- **Raw L2/L3 capture and transmission.** No packet-capture dependency exists in the tree
  today (checked: no capture or packet-building crate in any `Cargo.toml`). On Windows this
  means Npcap, which is a *driver the user installs*, not a crate; on macOS, capture needs
  privileges; on Linux it needs `CAP_NET_RAW`. A desktop slicer shipping a packet-injection
  feature is a product decision, not just a code change.
- **A sequence number inside the receiver's window.** A reset with a sequence number outside
  the window is silently dropped by a conforming stack. There are only two ways to get it:
  observe the flow (capture), or have recorded it while the flow was ours.
  - *For our own abandoned sessions* the number is knowable **without capture**: record
    `(local_port, send-sequence)` when the relay opens the RTSP socket, persist it in the
    existing lease record, and forge the reset from that local port later. This turns the
    lease store from a wrong idea into the right container for the right data.
  - *For a foreign peer's stale session* (a phone, another tool) the number is only
    obtainable by capture. There is no shortcut.
- **Correctness risk.** A reset aimed at a flow that has since been re-established from the
  same local port would kill a healthy session. Guard with the recorded sequence, and refuse
  to inject when the recorded tuple has been reused.

## Phases and verification

| Phase | Work | Verify |
|---|---|---|
| **P0a — landed on this branch** | Removed the two wrong-layer mechanisms (deterministic `-min_port`/`-max_port` pinning, replayed `Session:` header) and gave the pump bounded exponential backoff (750 ms doubling to 30 s, reset when media flows) so a refusing printer is no longer hit with a fresh connection every 750 ms | `cargo check` clean (`dragonfruit-rtsp-relay` 0.1.1); behaviour change is the ffmpeg argument list, and the backoff is visible in `pump_ffmpeg` |
| **P0b — landed** | An ffmpeg attempt that produces no media at all is killed after 12 s, so a printer that accepts a connection and then stays silent cannot leave the pump blocked in its stdout read. Rust-side only: the RTSP demuxer's socket-timeout option name varies by build, and an unrecognised option makes ffmpeg exit instantly, which would be worse than the hang | `cargo check` clean. The deadline path itself is not exercised live |
| **P1 — landed** | Exhaustion oracle: read `NumberOfVideoStreamConnected` and `MaximumVideoStreamAllowed` from the SDCP attribute reply, treat any unreadable answer as unknown, write the outcome to `last_claim_status`, and drop retries straight to the maximum interval | **Verified live** against 192.168.2.101: the opt-in test reports the printer's real state, and an independent probe agrees with it |
| **P2 — landed** | Stale-session reclaim: `TEARDOWN` naming a session id recorded in the lease store, which the printer matches globally rather than against the arriving connection | **Not verified live.** No stale session id was available to reclaim, and manufacturing one on a printer in use would deepen the leak. The logic follows the printer's global session-id match, which is read from its code |
| ~~P3 / P4~~ | Deferred, see below | A packet driver on Windows buys these two phases and nothing in P0-P2 |

P0-P2 need no new dependencies, no elevated permissions and no driver: they should land first
and probably remove most of the pain. **P3 and P4 both need the ability to transmit a spoofed
packet, which on Windows means a packet driver (Npcap or WinDivert) and on macOS or Linux means
elevated capture/injection privileges** — the driver decision is the same for both phases. They
differ in reach: P3 only recovers flows this application opened, because the sequence number
comes from the socket itself (TCP_INFO) or from the persisted record, whereas P4 recovers a
session pinned by a device we do not control, which additionally requires capturing the flow to
learn its sequence number.

## Decisions (settled with the maintainer)

| Decision | Choice | Consequence |
|---|---|---|
| **Scope** | **P0-P2 only.** No packet driver, no spoofing. | P3 and P4 are deferred, not deleted. A worker slot pinned by a device we do not control still ends in a printer restart, and the UI has to say that plainly rather than retrying into it. |
| **Lease store** | **Keep it, fix its contents.** | Drop deterministic `base_port` port pinning and `Session:` header reuse — both address layers that are not the bottleneck. Repurpose the record for what P1/P2 actually need: the last observed session id, the last claim status, and timestamps. The session id is precisely the input P2's stale-id `TEARDOWN` requires, so the store stops being dead weight and becomes the reclaim index. |
| **Culprit** | **Mixed / not sure.** | P1's detection ships first so the debug overlay reports who is holding the slots, instead of guessing whether P3 or P4 would ever justify a driver. |

The one remaining open question is cosmetic: whether the "no free stream slot" state belongs in
the existing RTSP debug overlay or in a first-class recover affordance in the monitor.

## Deferred: P3 and P4 (kept as analysis, not abandoned)

Both need the ability to transmit a spoofed packet, so on Windows each would require a packet
driver (Npcap or WinDivert) and on macOS or Linux elevated privileges — the same product cost for
either. They differ only in reach: P3 recovers flows this application opened, because the sequence
number is available from the socket (`TCP_INFO`) or from a record written while the flow was
alive; P4 additionally recovers a session pinned by a device we do not control, which requires
capturing the flow to learn its sequence number.

If P1's overlay later shows that third-party clients are the recurring occupier, P3 is cheap to
add on top of this work (the persisted record and the session index already exist) and P4 is the
only phase that would need capture as well as transmission.

## Related

- `docs/dev/rtsp-relay.md` — the current relay contract and environment variables; update it
  when any of this lands
- `rust/dragonfruit-rtsp-relay/src/lib.rs` — the crate this work is centred on
- `docs/dev/backlog.md` — temporary rules and known gotchas
