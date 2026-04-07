# DragonFruit Slicing Engine — V3.1 Docs

This folder is the canonical technical documentation for `dragonfruit-slicing-engine`.

## Quick context

`dragonfruit-slicing-engine` is DragonFruit Desktop’s native Rust slicer backend. It turns packed triangle data into per-layer outputs and delegates final container assembly to plugin-driven encoders.

V3.1 focuses on throughput, deterministic behavior, and memory efficiency:

- parallel rasterize+encode pipeline
- O(num_runs) PNG encoding from RLE
- encode-time sub-pixel packing (`rgb8_div3`, `gray3_div2`)
- smooth progress semantics for UI integration

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

- `src/lib.rs` — exports
- `src/types.rs` — contracts / job model
- `src/engine.rs` — orchestration / validation / errors
- `src/geometry.rs` — triangle parsing
- `src/index.rs` — layer triangle lookup index
- `src/raster.rs` — scanline rasterization (AA + non-AA)
- `src/rle.rs` — run-length building utilities
- `src/pipeline.rs` — bounded parallel work + progress + cancellation
- `src/encode.rs` — RLE-to-PNG encoders
- `src/encoders/` — format registry + encoder traits

## Documentation policy

Any change to pipeline semantics, public types, encoder contracts, or packing behavior should update docs in the same PR.

## Acknowledgment

Many thanks to **mslicer** for the inspiration behind several algorithmic ideas and practical slicing methods that informed DragonFruit V3.1.
