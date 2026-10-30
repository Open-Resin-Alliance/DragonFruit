# Encoders

Status: **shipped**. The host spawns one process per encode session, maps the
ring, streams every rendered layer and registers the result in the engine's
encoder registry, so a sideloaded format appears in the output-format list like a
compiled-in one.

Two things are not built: layer-kind negotiation (the host always sends PNG
layers) and preview decode (`read_layer_preview_png` still answers with the
trait's default error), so a sideloaded format has no layer thumbnails yet.

An encoder turns the engine's rasterised layers into one container file. The
host keeps the rasterising; your plugin owns the format. That split is why the
ring exists: a 12K layer is ~59 MB of mask, and copying that through a pipe per
layer would cost more than the encode.

## What the host sends

```json
→ {"type":"encode.begin","id":7,"format":".apf","layers":1200,
   "job":{"resolutionX":11520,"resolutionY":5120,"layerHeightMm":0.05,
          "exposureSec":2.5,"bottomLayers":5,"printerProfile":{…}}}
→ {"type":"encode.layer","id":7,"index":0,"kind":"rle","slot":3,"bytes":182344}
→ {"type":"encode.layer","id":7,"index":1,"kind":"rle","slot":0,"bytes":190112}
← {"type":"slot.free","slot":3}
← {"type":"progress","id":7,"done":1,"total":1200}
← {"type":"encode.done","id":7,"path":"C:\\\\…\\\\job.apf","bytes":48123904}
```

- `job` is the slice job the engine already builds: resolution, layer height,
  exposures, printer profile, material settings. Treat unknown fields as absent;
  new ones are added without a protocol bump.
- `kind` is `png`, `rle` or `mask`, and `slot` names the ring slot holding it.
  In `transport: "pipe"` the same bytes arrive as a bulk frame instead.
- `encode.begin` is answered by starting work, not by an ack: the host streams
  layers as they are rasterised.
- `encode.done` carries the finished file. Write it to the path the host gave in
  `encode.begin` (it passes one) or to the `path` you return; the host checks the
  file exists and is non-empty either way.

Preview decode, used by the layer browser after the file exists:

```json
→ {"type":"preview","id":8,"path":"…\\\\job.apf","layer":42}
← {"type":"preview.result","id":8,"kind":"png","slot":1}
```

## Reading a layer

```rust
use dragonfruit_plugin_sdk::{release_slot, slot_view, RingLayout};

fn take_layer(mapping: &mut [u8], layout: &RingLayout, slot: u32) -> Option<Vec<u8>> {
    let view = slot_view(mapping, layout, slot).expect("ring")?;
    let encoded = encode_layer(view.layer_index, view.payload); // your format
    release_slot(mapping, layout, slot).expect("release");
    Some(encoded)
}
```

A consumer that wants to hold a slot while it does something else calls
`claim_slot` first (`filled` becomes `consuming`); reading in place does not need
it. Either way `release_slot` hands the slot back.

Three habits keep this fast:

1. **Do not copy `view.payload`.** It borrows the mapping; work on it in place
   and only allocate your output.
2. **Release as soon as you have consumed the bytes**, not at end of job. The
   host blocks when every slot is full.
3. **Own your parallelism.** The process is yours: a small pool reading from a
   queue beats per-layer thread spawn. The host does not call you concurrently
   for the same job unless the message says `parallel: true` (designed).

## What you are given, today

PNG layers, one per frame, in index order. The host rasterises, encodes each
layer as PNG and hands the bytes over. Raw masks and RLE runs are the engine's
faster paths and a future protocol addition; a plugin cannot ask for them yet,
and the docs will say so here when it can.

## Cancellation and failure

- **`{"type":"cancel","id":7}`** is advisory. Stop at the next layer boundary,
  leave the partial file or delete it, and answer
  `{"type":"encode.cancelled","id":7}`. The host is waiting for the answer, not
  for the process.
- **Errors are `error` frames** with a code: `encode-failed`, `unsupported-job`,
  `io`. The host reports the message; a crashed process is reported as a failed
  job, never a failed app.
- **Progress** is `done`/`total` in layers, monotonic, at most ~10 messages per
  second.

## What the host guarantees

- Layers arrive in index order, once each.
- `encodeBegin` is not re-sent for a job; a retry is a new `id`.
- The output path is inside a directory the host created and owns.
- The ring is four slots sized for the largest layer in the job, and the path is
  in `DF_PLUGIN_RING`.
- One process per session: the ring outlives nothing. Open the mapping at start,
  expect `shutdown` (or EOF) at the end, and do not keep it across sessions.

## What it does not

- **No `FormatEncoder` trait.** That trait is the in-process seam for compiled-in
  plugins; it is not part of this ABI, and the SDK will not grow one.
- **No access to the scene.** If a format needs the model, it needs it in the
  job document, and that is a protocol change with a host change behind it.
