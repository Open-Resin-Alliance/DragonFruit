# dragonfruit-slicing-engine

Native Rust slicing backend for DragonFruit Desktop (Tauri), currently at **V3.1.0**.

This crate is the production slicing engine that converts triangle geometry into printer-ready layer containers (currently `.nanodlp` via plugin encoder registry).

## What changed in V3.1

V3.1 is a significant architecture and throughput upgrade:

- **Crate rename** from `dragonfruit-slicer-v3` to `dragonfruit-slicing-engine`
- **Parallel rasterize + encode pipeline** (`render_layers_rle_encoded`)
- **O(num_runs) fixed-Huffman PNG encoding** from RLE runs (no full pixel buffer materialization)
- **Encode-time sub-pixel packing** for `rgb8_div3` and `gray3_div2`
- **Progress-on-arrival semantics** for smoother real-time UI progress
- **Cooperative cancellation** maintained across all paths

## End-to-end flow

1. Validate `SliceJobV3`
2. Parse packed geometry into typed triangles
3. Build per-layer triangle index
4. Rasterize each layer to RLE (`rasterize_layer_rle`)
5. Encode layers in parallel when encoder supports `RleStreamEncoder::parallel_encode_fn`
6. Finalize container bytes/path through format encoder

## Core API

- `slice_with_progress_v3(...) -> Result<SliceArtifactV3, SlicerV3Error>`
- `slice_with_progress_v3_to_path(...) -> Result<SlicingPerfV3, SlicerV3Error>`

Primary public contracts live in:

- `src/lib.rs`
- `src/engine.rs`
- `src/types.rs`

## Documentation map

- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/PIPELINE.md`
- `docs/ENCODERS.md`
- `docs/INTEGRATION_TAURI.md`
- `docs/BENCHMARKING.md`
- `docs/TROUBLESHOOTING.md`
- `docs/DEVELOPMENT_GUIDE.md`

## Integration notes

- `src-tauri` depends on crate `dragonfruit-slicing-engine` (lib: `dragonfruit_slicing_engine`).
- Slicing runs inside a dedicated Rayon pool.
- Progress is throttled in Tauri bridge code for UI smoothness.
- Cancellation is atomic and cooperative.

## Environment controls

- `DF_V3_MAX_CONCURRENT=<N>` — caps in-flight parallel layer work.

## Acknowledgment

With genuine appreciation: **many thanks to the mslicer project and contributors** for inspiration on slicing/rasterization algorithms and practical methods that helped shape DragonFruit’s V3.1 design direction.

DragonFruit’s implementation is fully integrated and maintained in this repository.
