# Architecture

## Purpose

`dragonfruit-slicer-v3` provides a deterministic, native slicing pipeline for DragonFruit Desktop. The crate is intentionally split into small modules with explicit responsibilities, so performance and correctness can be tuned without collapsing boundaries.

## Design goals

- **Deterministic behavior** for identical geometry/job inputs.
- **Clear stage boundaries** (parse/index/raster/encode).
- **Bounded memory pressure** during parallel rendering.
- **Cancelable jobs** with low coordination overhead.
- **Pluggable container formats** via encoder registry.

## High-level flow

```text
SliceJobV3
  -> validate_job (engine)
  -> parse_triangles (geometry)
  -> build_layer_index (index)
  -> render_layers_bounded (pipeline + raster + encode)
  -> dispatch_encode_by_format (encoders)
  -> SliceArtifactV3
```

## Module responsibilities

### `types`

Defines all major contracts:

- `SliceJobV3`
- `RenderedLayersV3`
- `LayerAreaStatsV3`
- `SliceArtifactV3`
- `ProgressCallbackV3`

This module is the primary ABI-like contract between app/runtime and slicer logic.

### `engine`

Owns orchestration and input validation.

- Exposes `slice_with_progress_v3` and path-based variant.
- Selects encoder and derives required payload capabilities.
- Aggregates stage timings into `SlicingPerfV3`.
- Defines crate-level error enum: `SlicerV3Error`.

### `geometry`

Parses flat packed triangle buffers (`[x,y,z,...]`) into typed `Triangle`s and precomputes fields needed by rasterization (e.g., directional terms).

### `index`

Builds per-layer triangle candidate buckets using z-range overlap math.

### `raster`

Converts layer plane intersections into grayscale masks using winding-based scanline filling to robustly union overlapping/intersecting solids.

Optional behavior:

- connected-component area stats (`LayerAreaStatsV3`)
- simple anti-aliasing coverage quantization

### `pipeline`

Runs layer rendering in bounded parallel mode:

- configurable max concurrency (`DF_V3_MAX_CONCURRENT`)
- ordered output assembly despite out-of-order worker completion
- progress callbacks
- cooperative cancellation checks
- optional PNG and/or raw mask emission

### `encode`

Contains PNG utility encoding for grayscale layers and compression strategy mapping.

### `encoders`

Defines `FormatEncoder` trait and runtime registry.

- `encoders/registry.rs` lazily initializes registered encoders (`OnceLock`).
- `encoders/generated_plugin_encoders.rs` is generated from allowlisted plugin definitions.

### `benchmark` and `bin/benchmark`

Synthetic scene generation + throughput measurements for local profiling.

## Concurrency model

- Work distribution: Rayon parallel iterators.
- Backpressure: bounded `sync_channel`.
- Ordering: reorder buffer drained by layer index.
- Progress: updated on completion arrival (not delayed drain), reducing UI burstiness.

## Error model

The orchestration boundary uses typed errors (`SlicerV3Error`) for:

- invalid jobs
- unsupported output format
- cancellation
- encoding/IO/JSON failures
- payload capability mismatches

Errors from third-party libs are translated into this unified enum.

## Extension model

New output formats are added through `FormatEncoder` implementations and generated registry wiring, not through hardcoded engine branches.

See [`ENCODERS.md`](./ENCODERS.md) and [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md).
