# dragonfruit-slicer-v3

Native Slicer V3 for DragonFruit Desktop.

This crate is the **active production slicer backend** used by the Tauri desktop app.

## What this crate does

For each slicing job, V3 runs a deterministic pipeline:

1. Parse packed triangle buffers into typed geometry.
2. Build a per-layer triangle index.
3. Rasterize layers in parallel with bounded in-flight work.
4. Encode grayscale PNG layers.
5. Package output into `.nanodlp` archive format.
6. Emit progress callbacks and honor cancellation.

## Public API

- `slice_with_progress_v3(job, on_progress, cancel_flag)`
- `SliceJobV3`, `SliceArtifactV3`, `ProgressCallbackV3`

Primary exports are in:

- `src/lib.rs`
- `src/engine.rs`
- `src/types.rs`

## Full documentation

This crate now has a dedicated docs set under:

- `docs/README.md`

Quick links:

- `docs/ARCHITECTURE.md`
- `docs/API.md`
- `docs/PIPELINE.md`
- `docs/ENCODERS.md`
- `docs/INTEGRATION_TAURI.md`
- `docs/BENCHMARKING.md`
- `docs/TROUBLESHOOTING.md`
- `docs/DEVELOPMENT_GUIDE.md`

## Integration in DragonFruit

- `src-tauri` depends on this crate directly.
- Desktop commands `slice_solid_native` and `slice_solid_native_to_temp_path` execute this pipeline.
- `cancel_slicing` is cooperative via an atomic cancel flag.

## Performance behavior

- Layer rendering uses bounded concurrency.
- Worker count defaults to available CPU parallelism.
- You can cap concurrency with:

`DF_V3_MAX_CONCURRENT=<N>`

## Current output target

- Supported: `.nanodlp`
- Unsupported formats return a typed `UnsupportedOutput` error.

## Design principles

- Predictable and testable pipeline stages.
- Explicit error types and validation at the engine boundary.
- Stable rasterization behavior for intersecting/overlapping solids.
- Memory-aware parallelism (bounded channel + ordered drain).

## Inspiration & acknowledgment

Huge shoutout to **mslicer** for algorithmic inspiration around robust slicing/rasterization ideas.

Implementation in this crate is DragonFruit’s V3-native code path and is maintained as part of this repository.
