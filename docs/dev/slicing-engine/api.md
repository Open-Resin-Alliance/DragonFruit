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
- bottom contour compensation: `bottom_outline_compensation_mm`,
  `bottom_hole_compensation_mm`, `bottom_compensation_layers`,
  `bottom_compensation_fade_layers` (all default `0`, off)
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

### Bottom contour compensation

Moves the contours of the layers nearest the build plate to counter "elephant's
foot", the flare that long bottom exposures give every edge on the plate:

- `bottom_outline_compensation_mm` moves outer outlines, `bottom_hole_compensation_mm`
  moves holes. Negative removes material (outlines shrink, holes open), positive
  adds it. An island standing inside a hole counts as an outline. The two are
  independent.
- The first `bottom_compensation_layers` layers (`0`-based layer index below the
  count) get both distances in full. The next `bottom_compensation_fade_layers`
  layers get a share that drops in equal steps, following the transition
  exposure, which the GOO and CTB encoders ramp from the bottom exposure to
  reach the normal exposure on the last transition layer: fading layer `k` of
  `n` (`k` from 1) gets `1 - k / n` of each distance, so the last one gets none.
  Every later layer gets none. A fade of `0` is a hard stop after the full-strength layers.
- `0` turns a distance off; a job with both at `0` or no covered layers is
  sliced exactly as before.
- The distance is in millimetres and is exact on each axis for non-square
  pixels: `SliceJobV3::bottom_compensation_for_layer(layer)` turns the job into a
  `compensation::ContourCompensation` with the job's X and Y pixel pitch, or
  `None` when the layer is not compensated.
- The engine does not read print settings out of `metadata_json`, so the caller
  resolves both counts from the bottom and transition layers the format's encoder
  reads: with the material's fade on (the default), the bottom layers are full
  strength and the transition layers fade; with it off, both are full strength
  and the fade is `0` (see [Slice Job Assembly](../slice-job-assembly.md)).

The pass itself is in `rust/dragonfruit-slicing-engine/src/compensation.rs` (`compensate_mask`, `compensate_rle`);
[Pipeline](pipeline.md) says where it runs.

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
