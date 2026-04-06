# API Reference (V3.1)

## Public re-exports

From `src/lib.rs`:

- `slice_with_progress_v3`
- `slice_with_progress_v3_to_path`
- `SlicerV3Error`
- `SlicingPerfV3`
- `SliceJobV3`
- `SliceArtifactV3`
- `ProgressCallbackV3`

## Entrypoints

### In-memory output

`slice_with_progress_v3(job, on_progress, cancel_flag)`

Use when the caller needs final container bytes returned directly.

### Path output

`slice_with_progress_v3_to_path(job, output_path, on_progress, cancel_flag)`

Use when writing directly to disk/temp path to avoid extra large byte copies across boundaries.

## Core job contract: `SliceJobV3`

Important fields:

- geometry: `triangles_xyz`
- layering: `layer_height_mm`, `total_layers`
- raster dims: `source_width_px`, `source_height_px`
- logical output dims: `width_px`, `height_px`
- packing mode: `x_packing_mode` (`none`, `rgb8_div3`, `gray3_div2`)
- build volume: `build_width_mm`, `build_depth_mm`
- output selection: `output_format`
- AA controls: `anti_aliasing_level`, `minimum_aa_alpha_percent`, `aa_on_supports`
- transforms: `mirror_x`, `mirror_y`
- encode hints: `png_compression_strategy`, `container_compression_level`
- metadata passthrough: `metadata_json`

### Physical-width rasterization rule

`effective_render_width_px()` returns `source_width_px`, so rasterization happens at physical sub-pixel width even when output PNG width is logically reduced by packing.

## Result types

### `SliceArtifactV3`

- `bytes: Vec<u8>`
- `perf: SlicingPerfV3`

### `SlicingPerfV3`

Timing counters (ns):

- `total_ns`
- `index_build_ns`
- `render_wall_ns`
- `render_ns`
- `png_encode_ns`
- `archive_encode_ns`
- `layers`

Helpers: `total_s()`, `layers_per_second()`.

## Progress model

`ProgressCallbackV3` receives `SliceProgressUpdateV3 { done, total, phase }`, where phase is one of:

- `Slicing`
- `Encoding`
- `Finalizing`

V3.1 reports progress on worker arrival, then the Tauri bridge throttles UI emits (~8ms) while always emitting first/final/phase-change updates.

## Error model (`SlicerV3Error`)

Primary variants:

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

## Format support lookup

Supported extensions are runtime-resolved from encoder registry:

- `encoders::registry::supported_output_formats()`

If no encoder matches `output_format`, engine returns `UnsupportedOutput` with a supported list.

## Validation rules

`validate_job` checks:

- all pixel dimensions > 0
- finite and positive layer/build settings
- `total_layers > 0`
- `triangles_xyz.len() % 9 == 0`
