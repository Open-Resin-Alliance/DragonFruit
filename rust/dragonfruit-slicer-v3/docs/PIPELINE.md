# Pipeline Details

## Stage 1: Validation (`engine::validate_job`)

The engine rejects malformed jobs before any heavy work starts.

Primary checks:

- dimensions > 0
- finite + positive build dimensions
- finite + positive layer height
- non-zero layer count
- triangle buffer length `% 9 == 0`

## Stage 2: Geometry parse (`geometry::parse_triangles`)

Converts packed float buffer into typed triangles with precomputed:

- `z_min`, `z_max`
- in-plane direction hints (`dir_x`, `dir_y`) for stable scanline segment orientation

## Stage 3: Layer index (`index::build_layer_index`)

Computes candidate triangle lists per layer via z-overlap range calculation.

This avoids scanning all triangles on every layer.

## Stage 4: Bounded parallel render (`pipeline::render_layers_bounded`)

### Worker scheduling

- Layers processed via Rayon parallel iterator.
- Results sent through bounded `sync_channel`.
- Concurrency cap: `DF_V3_MAX_CONCURRENT` (clamped to hardware parallelism).

### Output ordering

Workers complete out-of-order; pipeline maintains deterministic ordered output using a pending/reorder buffer keyed by layer index.

### Progress semantics

Progress callback increments on completion arrival, not delayed in-order drain, avoiding large UI jumps.

### Cancellation

Cooperative cancellation uses `AtomicBool` checks in workers and drain loop.

## Stage 5: Rasterization (`raster::rasterize_layer_with_stats`)

Key behaviors:

- Intersects triangle edges against layer plane.
- Builds active edge scanline index.
- Uses winding accumulation to fill unioned spans robustly.
- Optional anti-aliasing via cheap per-span coverage quantization.
- Optional connected-component area stats (8-connected) for metadata consumers.

## Stage 6: PNG encoding (`encode::encode_grayscale_png`)

If PNG payloads are requested by encoder capabilities:

- grayscale 8-bit PNG generated per layer
- compression/filter based on strategy hint (`fastest`, `balanced`, `smallest`, `optimal`)

Pipeline also caches uniform black/white PNG payloads to avoid redundant re-encoding.

## Stage 7: Container encoding (`engine::dispatch_encode_by_format`)

Delegates final packaging to selected `FormatEncoder` implementation.

The encoder decides whether it needs:

- PNG layers
- raw masks
- area stats

## Perf counters

`SlicingPerfV3` captures stage timing and can be surfaced to desktop diagnostics and profiling UIs.
