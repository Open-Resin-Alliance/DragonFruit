# DragonFruit Slicing Engine — v3.2 Docs

This folder is the canonical technical documentation for `dragonfruit-slicing-engine`.

## Quick context

`dragonfruit-slicing-engine` is DragonFruit Desktop’s native Rust slicer backend. It turns packed triangle data into per-layer outputs and delegates final container assembly to plugin-driven encoders.

v3.2 adds volumetric anti-aliasing, grayscale dithering, and a parallel post-processing pipeline:

- 3DAA with perturbation-based Z supersampling, XY/Z blur, cross-layer blending, and topology-gated thresholds
- RLE-native low-memory 3DAA path for 12K-class printers
- Binned Floyd–Steinberg dithering for non-8-bit display systems
- Dedicated encode thread overlapping PNG/format work with raster + EDT
- Parallel post-processing workers with ROI-local workspace bounds
- Gaussian blur kernels (X, Y, Z) with adjustable sigma

## Read these first

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design and module boundaries
- [`PIPELINE.md`](./PIPELINE.md) — execution path details
- [`API.md`](./API.md) — public API and error semantics

## Full document index

- [`ENCODERS.md`](./ENCODERS.md)
- [`INTEGRATION_TAURI.md`](./INTEGRATION_TAURI.md)
- [`BENCHMARKING.md`](./BENCHMARKING.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)

## Module map

- `src/lib.rs` — exports, `ENGINE_VERSION`
- `src/types.rs` — contracts / job model
- `src/engine.rs` — orchestration / validation / 3DAA pump / errors
- `src/geometry.rs` — triangle parsing and XY projection
- `src/index.rs` — layer triangle lookup index
- `src/raster.rs` — scanline rasterisation (AA + non-AA)
- `src/rle.rs` — run-length encoding primitives
- `src/pipeline.rs` — bounded parallel work + progress + cancellation
- `src/binary_mask.rs` — bounded binary/gray masks with row-span views
- `src/zaa.rs` — Z-axis anti-aliasing kernels and perturbation patterns
- `src/dither.rs` — Floyd–Steinberg binned dithering
- `src/encode.rs` — RLE-to-PNG encoding, sub-pixel packing
- `src/encoders/` — format registry + encoder traits + plugin-generated encoders
- `src/metrics.rs` — performance counters

## Documentation policy

Any change to pipeline semantics, public types, encoder contracts, AA behaviour, or packing logic should update the relevant docs in the same PR.

## Acknowledgment

Many thanks to **mslicer** for the inspiration behind several algorithmic ideas and practical slicing methods that informed DragonFruit's design.
