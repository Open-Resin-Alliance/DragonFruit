# Development Guide

## Contribution philosophy

When modifying V3, preserve three core properties:

1. **Correctness first** (no raster/topology regressions)
2. **Determinism** (stable output for stable input)
3. **Bounded resource usage** (no unbounded fan-out or buffer growth)

## Safe change workflow

1. Start from one module boundary (e.g., `raster` only).
2. Add/update tests for behavior change.
3. Run crate checks and benchmark sanity.
4. Validate integration behavior from desktop commands.
5. Update docs in this directory.

## Module-specific guidance

### `raster`

- Keep winding union semantics intact.
- Be careful with floating-point edge conditions (`x_eps`, scanline inclusivity).
- Validate against overlapping/disconnected island tests.

### `pipeline`

- Preserve bounded channel + reorder buffer strategy.
- Avoid introducing unbounded queues or duplicate full-layer copies.
- Keep progress and cancellation semantics explicit.

### `encoders`

- Add capabilities conservatively.
- Do not hardcode format dispatch in engine.
- Prefer generated registry wiring.

### `engine`

- Keep validation strict and early.
- Keep error translation clear and typed.

## Pipeline path guidance: PNG vs raw layer data

V3 supports two primary payload paths from `render_layers_bounded`:

1. **PNG-layer path** (`RenderedLayersV3.png_layers`)
2. **Raw-mask path** (`RenderedLayersV3.raw_mask_layers`)

The selected path is capability-driven by the active encoder:

- `requires_png_layers()`
- `requires_raw_mask_layers()`
- `requires_area_stats()`

### PNG-layer path (most current formats)

Use this path when the container format stores/consumes PNG slices.

Notes:

- `encode_grayscale_png` cost is material for total runtime.
- Uniform black/white PNG cache behavior in `pipeline` should be preserved.
- Any compression-strategy changes (`fastest`, `balanced`, `smallest`, `optimal`) should be benchmarked.

### Raw-mask path

Use this path when encoder logic wants direct raster bytes and handles packing itself.

Notes:

- Avoid accidental PNG work when only raw masks are needed.
- Be explicit about grayscale/threshold semantics in encoder code.
- Validate output parity with PNG-based behavior if format expectations overlap.

### Dual-path encoders

Some formats may require both PNG and raw data. If so:

- Justify the extra memory/CPU cost in code comments and PR notes.
- Keep bounded in-flight behavior unchanged.
- Verify that progress/cancellation semantics remain identical.

### When changing capabilities

If you change encoder capability flags, validate all of the following:

1. Correct payload is emitted (PNG/raw/both).
2. No `MissingRenderedLayerPayload` regressions.
3. Perf counters still make sense (`render_ns`, `png_encode_ns`, `archive_encode_ns`).
4. Desktop integration behavior is unchanged (or intentionally documented).

## Testing recommendations

- Unit-test edge-case geometry and raster behavior.
- Add targeted tests for new encoder capability requirements.
- Use benchmark runner for performance trend checks after algorithm changes.

## Documentation update policy

Any non-trivial change to:

- stage behavior
- API contracts
- error semantics
- encoder capabilities

should include updates in this `docs/` directory in the same PR.
