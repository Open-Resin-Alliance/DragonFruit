# DragonFruit Slicer V3 Documentation

This directory contains the full technical documentation for `dragonfruit-slicer-v3`.

## What this crate is

`dragonfruit-slicer-v3` is the active native slicing backend used by DragonFruit Desktop (Tauri). It turns triangle geometry into per-layer rasters and delegates final container output to registered format encoders.

At a high level, each job runs:

1. Input validation (`engine`)
2. Triangle parsing (`geometry`)
3. Per-layer triangle indexing (`index`)
4. Bounded parallel rasterization (`pipeline` + `raster`)
5. Format-specific container encoding (`encoders`)

## Documentation map

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
  - System design, module boundaries, and data flow.
- [`API.md`](./API.md)
  - Public API reference and call patterns.
- [`PIPELINE.md`](./PIPELINE.md)
  - Detailed stage-by-stage execution model.
- [`ENCODERS.md`](./ENCODERS.md)
  - Encoder trait contract, registry behavior, and plugin-owned formats.
- [`INTEGRATION_TAURI.md`](./INTEGRATION_TAURI.md)
  - How DragonFruit Desktop integrates this crate.
- [`BENCHMARKING.md`](./BENCHMARKING.md)
  - Benchmark module and CLI usage.
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
  - Common failures, diagnostics, and fixes.
- [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
  - How to safely extend or modify V3.

## Source module map

- `src/lib.rs` — crate exports and module wiring
- `src/types.rs` — typed input/output contracts
- `src/engine.rs` — orchestration and error boundary
- `src/geometry.rs` — packed triangle parsing
- `src/index.rs` — layer-to-triangle indexing
- `src/raster.rs` — scanline rasterization + optional component stats
- `src/pipeline.rs` — bounded parallel layer rendering, cancellation, progress
- `src/encode.rs` — PNG layer encoding utility
- `src/encoders/` — format encoder trait + generated registry
- `src/benchmark.rs` — synthetic benchmark runner
- `src/bin/benchmark.rs` — benchmark CLI

## Versioning and ownership

This docs set is intended to evolve with the crate on the `plugins_v2` architecture path. When changing pipeline semantics, error types, or encoder behavior, update these docs in the same PR.
