# API Reference

## Public re-exports

From `rust/dragonfruit-slicing-engine/src/lib.rs`:

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
- tanks: `tank_count` (default `1`) and `triangle_tank_index` (default empty)

### Multi-tank jobs

A job with `tank_count > 1` draws one film per tank. `triangle_tank_index` is
aligned with `triangles_xyz` and names the tank each model triangle prints from
(`0` = Tank 1). An empty vector means every triangle is in Tank 1, which is what
a single-material job sends, so the field is additive for existing callers.

Support geometry — triangles at or after `model_triangle_count`, when that count
is non-zero — always prints from Tank 1 (index `0`) whatever the assignment
says. `tanks::partition_triangles_by_tank` applies that rule and returns one
`TankTriangles` entry per tank, in tank order, keeping triangle order within a
tank. `SliceJobV3::tank_for_triangle(index)` is the per-triangle check.

The intended pipeline is one framebuffer/RLE stream per tank per layer; the
partition is the first step there, and encoders gain the per-tank streams next.

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
- `raw_geometry_ns`
- `raw_scanline_ns`
- `png_encode_ns`
- `archive_encode_ns`
- `layers`

Helpers: `total_s()`, `layers_per_second()`.

The RAW phase counters are summed worker elapsed time, not pipeline wall time
or sampled process CPU time. `raw_geometry_ns` covers candidate traversal,
packet preparation, triangle/plane intersections and segment collection.
`raw_scanline_ns` covers scanline-index construction, active edges, winding,
spans, RLE/binary-mask emission and required raster statistics. Neither includes
format encoding, postprocessing or sink/channel waits. Shared mesh parsing and
projection occur before these phases and are not geometry-phase time.

Only eligible single-plane binary cores are timed, including binary cores
prepared internally for SSAA/blur jobs; ineligible paths report zero rather
than an estimate. Both scalar and SIMD backends are measured. Timers are coarse
per layer/block, never per triangle, pixel, scanline or SIMD packet.

The Tauri response exposes `rawGeometryNs` and `rawScanlineNs` under
`nativePerf.perf`; copied app metrics also include `rawGeometryWorkerMs` and
`rawScanlineWorkerMs`. The metrics dialog shows the two raw counters. CLI perf
JSON uses the native snake_case names. See [Benchmarking](benchmarking.md) for
interpretation.

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
