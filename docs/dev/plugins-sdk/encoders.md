# Encoders

Status: **shipped**, in both shapes.

- **RLE** is the cheap path and the one to ask for: the engine rasterises straight
  to runs and hands them over, so no image is encoded or decoded, and a full-width
  solid layer is a handful of bytes. Ask for it with `"layers": "rle"` on the
  format in the manifest.
- **PNG** is the default, for formats that need pixels.

Layer previews work too: a plugin decodes one from its own container on request,
so a sideloaded format gets thumbnails in the layer browser like a compiled-in
one.

An encoder turns the engine's rasterised layers into one container file. The host
keeps the rasterising; your plugin owns the format. That split is why the ring
exists: a 12K layer is ~59 MB of mask, and copying that through a pipe per layer
would cost more than the encode.

## What the host sends

```json
→ {"type":"encodeBegin","id":7,"format":".apf","layers":1200,
   "job":{"widthPx":11520,"heightPx":5120,"layerHeightMm":0.05,"totalLayers":1200}}
→ {"type":"encodeLayer","id":7,"index":0,"kind":"rle","slot":3,"bytes":182344}
→ {"type":"encodeLayer","id":7,"index":1,"kind":"rle","slot":0,"bytes":190112}
← {"type":"slotFree","slot":3}
← {"type":"progress","id":7,"done":1,"total":1200}
→ {"type":"encodeEnd","id":7,"output":"job.apf"}
← {"type":"encodeDone","id":7,"path":"job.apf","bytes":48123904}
```

The session ends with the host's `encodeEnd`, because that is where the
destination path arrives: a streaming encoder does not know it when the first
layer shows up.

- `job` is the slice job the engine already builds: resolution, layer height,
  exposures, printer profile. Treat unknown fields as absent; new ones are added
  without a protocol bump.
- `kind` is `png` or `rle`, and `slot` names the ring slot holding it. Runs are
  `u32 length | u8 value`, little-endian; the SDK's `decode_runs` reads them, so a
  run-length format consumes the stream directly.
- `encodeBegin` is answered by starting work, not by an ack: the host streams
  layers as they are rasterised.
- `encodeDone` carries the file. The host checks it exists, then hands it on.

## Slice with the sample format

`echo_encoder` is a complete format for trying the path: it records what it was
given instead of rasterising a real container.

```bash
cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example echo_encoder
cargo run -p dragonfruit-plugin-package --example pack -- \
  --out echo-encoder-sample.dfplugin \
  --binary rust/dragonfruit-plugin-sdk/target/debug/examples/echo_encoder \
  --id example.encoder --name "Echo Container Encoder" --version 0.1.0 --vendor DragonFruit \
  --format .exf --format-name "Echo container" --layers rle
```

Then:

1. Import the package (no passphrase: it is unsealed). Its format appears in
   **Settings → Printers → Output format** as "Echo container".
2. Select it on the active printer profile, load a model and slice.
3. The output is a text-ish container: `ECHOENC1.exf`, then per layer the index,
   the payload length, the kind (`rle`), the run count, the run bytes, and a final
   `layers=N`. Open it in a hex viewer: if `layers=` matches the slice and every
   record says `rle`, the run stream reached the plugin intact.

Registering a format after a slice has already run needs an app restart: the
engine's encoder registry is frozen by the first slice, which is deliberate. A
package installed before that first slice registers immediately.

## Reading a layer

```rust
use dragonfruit_plugin_sdk::{decode_runs, release_slot, slot_view, RingLayout};
use dragonfruit_plugin_sdk::SlotKind;

fn take_layer(mapping: &mut [u8], layout: &RingLayout, slot: u32) -> Option<Vec<u8>> {
    let view = slot_view(mapping, layout, slot).expect("ring")?;
    let out = match view.kind {
        SlotKind::Rle => {
            let runs = decode_runs(view.payload).expect("runs");
            encode_runs_to_container(runs) // your format
        }
        SlotKind::Png => recompress(view.payload), // your format
        SlotKind::RawMask => unreachable!("this plugin does not ask for masks"),
    };
    release_slot(mapping, layout, slot).expect("release");
    Some(out)
}
```

A consumer that wants to hold a slot while it does something else calls
`claim_slot` first (`filled` becomes `consuming`); reading in place does not need
it. Either way `release_slot` hands the slot back.

Three habits keep this fast:

1. **Do not copy the payload.** It borrows the mapping; work on it in place and
   only allocate your output.
2. **Release as soon as you have consumed the bytes.** The host blocks when all
   four slots are full.
3. **Own your parallelism, within a layer.** The host hands layers over one at a
   time and waits for each slot to come back, so the engine's per-layer parallel
   encode hook is not used for sideloaded formats. Parallelise inside a layer
   (rows, blocks, tiles); overlapping whole layers would need a protocol change.

## Preview decode

```json
→ {"type":"preview","id":8,"path":"job.apf","layer":42}
← {"type":"previewPng","id":8,"bytes":182344}
← (bulk frame) the PNG bytes
```

Implement `PluginCapabilities::preview`. The default answers "no previews", and
the host shows the layer without a thumbnail rather than failing the slice.

## Cancellation and failure

- **Cancellation is not a message yet.** The engine aborts the session and the
  host tears the process down, which is why a cancelled slice leaves no file: the
  plugin never gets a chance to finish one and should not assume it will. The
  advisory cancel message is designed for when a format needs to flush or
  keep partial state.
- **Errors are `error` frames** with a code: `encode-failed`, `unsupported-job`,
  `io`. The host reports the message; a crashed process is reported as a failed
  job, never a failed app.
- **Progress** is `done`/`total` in layers, monotonic.

## What the host guarantees

- Layers arrive in index order, once each.
- `encodeBegin` is not re-sent for a job; a retry is a new `id`.
- The ring is four slots sized for the job (runs or the largest PNG), and the path
  is in `DF_PLUGIN_RING`. A preview opens the process without a ring, so treat the
  mapping as optional.
- One process per session: the ring outlives nothing. Open the mapping at start,
  expect `shutdown` or EOF at the end.

## What it does not

- **No `FormatEncoder` trait.** That trait is the in-process seam for compiled-in
  plugins; it is not part of this ABI, and the SDK will not grow one.
- **No raw masks.** They are the engine's third layer kind and a future addition;
  RLE already avoids the PNG round trip.
- **No area stats.** The engine can compute per-layer connected-component stats
  and hands them to compiled-in encoders; they are not forwarded over the
  protocol, so a format that needs them would ask for `mask` layers instead.
- **No access to the scene.** If a format needs the model, it needs it in the job
  document, and that is a protocol change with a host change behind it.
