# API Reference

## Public exports

`src/lib.rs` re-exports:

- `slice_with_progress_v3`
- `SlicerV3Error`
- `SlicingPerfV3`
- `SliceJobV3`
- `SliceArtifactV3`
- `ProgressCallbackV3`

## Core types

### `SliceJobV3`

Input contract for a slice operation.

Key fields:

- Geometry: `triangles_xyz`
- Layering: `layer_height_mm`, `total_layers`
- Pixel dimensions: `source_width_px`, `source_height_px`, `width_px`, `height_px`
- Build volume: `build_width_mm`, `build_depth_mm`
- Output format: `output_format`
- Raster options: `anti_aliasing_level`, `mirror_x`, `mirror_y`
- Compression hints: `png_compression_strategy`, `container_compression_level`
- App metadata passthrough: `metadata_json`

### `SliceArtifactV3`

Successful result for in-memory encoding path.

- `bytes: Vec<u8>` — final container bytes
- `perf: SlicingPerfV3` — stage timing counters

### `SlicingPerfV3`

Performance counters in nanoseconds:

- `total_ns`
- `index_build_ns`
- `render_wall_ns`
- `render_ns`
- `png_encode_ns`
- `archive_encode_ns`
- `layers`

Convenience methods:

- `total_s()`
- `layers_per_second()`

## Main entrypoints

### `slice_with_progress_v3`

```rust
pub fn slice_with_progress_v3(
    job: &SliceJobV3,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SliceArtifactV3, SlicerV3Error>
```

Use when you need final bytes returned in-memory.

### `slice_with_progress_v3_to_path`

```rust
pub fn slice_with_progress_v3_to_path(
    job: &SliceJobV3,
    output_path: &Path,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SlicingPerfV3, SlicerV3Error>
```

Use when you want direct file output and reduced boundary copy overhead.

## Internal-but-important entrypoints

These are public within crate API surface and used by orchestration/integration layers:

- `slice_and_rasterize_v3`
- `dispatch_encode_by_format`
- `dispatch_encode_by_format_to_path`

## Error semantics (`SlicerV3Error`)

- `Cancelled`
- `UnsupportedOutput(String)`
- `InvalidDimensions { .. }`
- `InvalidLayerSettings { .. }`
- `InvalidBuildVolume { .. }`
- `InvalidTriangleBuffer(usize)`
- `Png(String)`
- `Zip(String)`
- `Json(String)`
- `MissingRenderedLayerPayload(String)`

## Supported output formats

Resolved dynamically from encoder registry:

- `encoders::registry::supported_output_formats()`

If requested `output_format` is absent, engine returns `UnsupportedOutput` with the current supported set.

## Job validation rules

`validate_job` enforces:

- pixel dimensions are non-zero
- `layer_height_mm > 0` and finite
- `total_layers > 0`
- build volume dimensions are finite and > 0
- triangle buffer length is a multiple of 9
