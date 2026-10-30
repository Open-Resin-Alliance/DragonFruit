# Plugin SDK

`rust/dragonfruit-plugin-sdk` is what a vendor links to build a sideloaded
plugin: the control-channel codec, the handshake harness and the accessors for
the shared byte ring. It is **MIT OR Apache-2.0** and contains no DragonFruit
code, which is what keeps a vendor's binary out of AGPL scope.

Why the boundary is a process and an SDK rather than an in-process ABI:
`docs/adr/0047-sideloaded-complex-plugins.md`. What a package contains and how
the host verifies it: `docs/dev/plugins-sideloaded.md`.

## What it gives you

| Item | Purpose |
| --- | --- |
| `PluginIdentity` | the four facts the host checks against the package manifest: id, version, capabilities, formats |
| `serve` | runs the handshake and the control loop; your `main` is one line |
| `HostMessage` / `PluginMessage` | the control messages, already serialized the way the host expects |
| `read_frame` / `write_frame` | the length-prefixed codec on stdio |
| `init_ring`, `publish_slot`, `slot_view`, `release_slot` | the shared byte ring, over whatever mapping you or the host provides |
| `PROTOCOL_VERSION` | the wire version; the host refuses a package built against another |

## Minimal plugin

```rust
use dragonfruit_plugin_sdk::{serve, Capability, FormatDecl, PluginIdentity};

struct EncoderPlugin;

impl PluginIdentity for EncoderPlugin {
    fn plugin_id(&self) -> &str { "example.multimaterial" }
    fn version(&self) -> &str { "0.1.0" }
    fn capabilities(&self) -> Vec<Capability> { vec![Capability::SlicerEncoder] }
    fn formats(&self) -> Vec<FormatDecl> {
        vec![FormatDecl { ext: ".exf".to_string() }]
    }
}

fn main() -> std::io::Result<()> {
    serve(std::io::stdin().lock(), std::io::stdout().lock(), &EncoderPlugin)
}
```

The host spawns that binary, sends `hello`, and expects `ready` with the identity
above. Anything the manifest did not declare ends the session with
`undeclared-capability` on the host side; a version the host does not know ends
it with `unsupported-protocol` from this side.

## The ring

Bulk layer data does not travel through JSON. The host maps a file, hands the
path over, and both sides open the same layout:

```text
init_ring(&mut mapping, RingLayout::new(DEFAULT_SLOT_COUNT, DEFAULT_SLOT_BYTES))   // host, once
publish_slot(&mut mapping, &layout, slot, SlotKind::Rle, layer, runs, 0, 0)        // publisher
let view = slot_view(&mapping, &layout, slot)?                                     // consumer
release_slot(&mut mapping, &layout, slot)                                          // consumer, done
```

`RingLayout::bytes_needed()` is a `const fn`, so a mapping size can be a compile
time constant. The mapping must start 8-byte aligned (a page-aligned `mmap` is);
`state` and `seq` are accessed atomically and nothing else is shared — no
pointers, no objects, no allocator.

## Rules that matter

- **No stubs in the host's name.** The host validates the manifest, then the
  handshake; a plugin whose `ready` disagrees with the manifest is refused
  rather than trusted for what it says.
- **Unknown messages are errors, not skips.** A frame type this build does not
  know terminates the session with a code the host can report.
- **The SDK carries no engine code.** No `FormatEncoder`, no scene types. If you
  find yourself wanting one, the protocol needs a new message, not a dependency.

## Where this is heading

Today: handshake, control frames, ring accessors. Next: the encode session
(`encode.begin` / `encode.layer` / `encode.done`), network dispatch and file-type
import, each landing with the host adapter that consumes it. This page and the
protocol table in `docs/dev/plugins-sideloaded.md` move together with those.

The crate lives in this repository so a protocol change and its SDK change are
one PR. It moves to its own `df-plugin-sdk` repository when the protocol reaches
1.0 and a second vendor needs it — it has no DragonFruit dependencies, so the
move is a directory copy plus a tag.

## Related

- `docs/dev/plugins-sideloaded.md` — package format, trust model, wire protocol
- `docs/dev/plugins-framework.md` — all three plugin tiers
- `docs/adr/0047-sideloaded-complex-plugins.md` — why a process boundary
