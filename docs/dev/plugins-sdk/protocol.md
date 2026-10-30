# Protocol

Status: **shipped** for frames, handshake and the ring. Capability messages are
designed (see the capability pages) and arrive with their host adapters.

Version: `PROTOCOL_VERSION` in `rust/dragonfruit-plugin-sdk/src/lib.rs`. The
package manifest declares it as `entry.proto`; a mismatch is refused on both
sides rather than guessed.

## Two channels

| Channel | Carries | Shape |
| --- | --- | --- |
| stdio | control and metadata | length-prefixed frames, JSON payload |
| a file the host maps | bulk layer bytes | the shared ring, opaque slots |

Stdio is unbuffered traffic on stdin, not a socket: nothing to connect to,
nothing to authenticate, and the process dies with its parent.

## Frames

```text
frame := u32 length (LE, includes the kind byte) | u8 kind | payload[length - 1]
```

- `kind 0` is JSON. `kind 1` is bulk, used only when the manifest says
  `"transport": "pipe"`.
- The length includes the kind byte, so a frame is never empty.
- The cap is 64 MiB per frame. Bulk layer data goes through the ring; pipe mode
  is the fallback that carries one layer per bulk frame.
- A reader that sees a length it cannot trust errors before allocating.
- A clean end-of-stream between frames is **not** an error: the host is gone,
  exit quietly. A stream that ends mid-frame is a protocol error.

## Handshake

```json
→ {"type":"hello","proto":1,"transport":"shm","appVersion":"0.4.0"}
← {"type":"ready","pluginId":"alphabeta.alphaprint","version":"1.0.0",
   "capabilities":["slicerEncoder","networkOperations"],
   "formats":[{"ext":".apf"}]}
→ {"type":"shutdown"}
```

`hello` is the only thing the host sends before `ready`. After it:

- the id must equal the manifest's;
- every capability and format in `ready` must be declared by the manifest;
- the host records the negotiated `transport` and ignores a plugin that answers
  with one it did not offer.

`shutdown` between operations ends the session; the process exits 0. The host
also ends the session by closing stdin.

## Errors

```json
{"type":"error","code":"unsupported-protocol","message":"…"}
```

Sent by the plugin, then the process exits non-zero. Codes the SDK emits today:

| Code | When |
| --- | --- |
| `malformed-handshake` | first frame was not a JSON `hello` |
| `unsupported-protocol` | `hello.proto` is not a version this plugin speaks |
| `unexpected-frame` | a second `hello`, or a bulk frame before the handshake completed |
| `malformed-message` | JSON that is not a control message |

Codes the host will emit at the same boundary (designed): `undeclared-capability`
when `ready` claims more than the manifest, and `unknown-message` for a message
the host cannot route.

An unknown message is an error, never a skip: silently ignoring one is how a
plugin and a host end up disagreeing about what a session is doing.

## The ring

When `transport` is `shm`, the host creates a mapping file, passes its path in
the spawn environment, and both sides open the same layout. Constants live in
`rust/dragonfruit-plugin-sdk/src/ring.rs`.

```text
header (4096 bytes)
  0  u32 magic          0x44465247 ("DFRG")
  4  u32 version        1
  8  u32 slotCount
  12 u32 slotBytes
  16 u32 layerCapacity
  20 u32 reserved
  24 u64 seq            bumped by the publisher on every publish
slot headers (64 bytes each)
  0  u32 state          0 free | 1 filled | 2 consuming
  4  u32 kind           1 png | 2 rle | 3 raw mask
  8  u32 layerIndex
  12 u32 bytes
  16 u32 width
  20 u32 height
  24 u64 seq            the header's seq at publish time
payloads (slotBytes each, page aligned)
```

`RingLayout::new(4, 64 * 1024 * 1024)` is the default: four slots of 64 MiB,
which is one 12K raw mask plus headroom. `RingLayout::bytes_needed()` is a
`const fn`, so a plugin can size a buffer at compile time in tests.

### Ownership, and nothing else

| Transition | Who | Call |
| --- | --- | --- |
| `free` → `filled` | publisher | `publish_slot`, after the header and payload are written |
| `filled` → `consuming` | consumer, optional | `claim_slot` |
| `filled`/`consuming` → `free` | consumer | `release_slot` |

- The state store in `publish_slot` is a release store, and **that store is the
  publish**: everything written before it is visible to the consumer.
- The consumer loads `state` (acquire). `filled` or `consuming` means the view is
  readable; `free` means nothing is there yet.
- `claim_slot` is a compare-and-swap, so two consumers racing for one slot cannot
  both win. A consumer that reads in place can skip it and go straight to
  `slot_view`, which is what the encoder example does.
- There is no lock, no queue index, no shared allocator: a slot is owned by
  exactly one side at a time, and `slot_view` refuses a payload longer than the
  slot instead of trusting the header.

Only `state` and `seq` are touched atomically. The mapping must start 8-byte
aligned because the accessors cast it to atomics; a page-aligned `mmap` is what
the host uses, and every SDK entry point rejects a mapping that is not aligned
with `RingError::Misaligned` rather than invoking undefined behaviour.

## Versioning rules

- Adding a message type is a **minor** change: an older peer answers
  `unknown-message`, which is a clean failure.
- Changing a field's meaning, removing a field, or changing who owns a buffer is
  a **major** change and a new `PROTOCOL_VERSION`.
- Fields a reader does not recognise are ignored, not rejected.
- The host refuses a package built against a protocol it does not know at import
  time, so the failure is visible before anything runs.

## Debugging

The host logs the spawn command line, the negotiated transport and every
non-2xx result. On the plugin side, write diagnostics to stderr — the host
captures it into the app log — and never to stdout, which is the control
channel.
