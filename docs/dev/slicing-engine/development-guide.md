# Development Guide

## Engineering principles

When changing `dragonfruit-slicing-engine`, preserve:

1. **Correctness** (geometry/raster parity)
2. **Determinism** (stable output for same input)
3. **Bounded memory** (avoid unbounded queues/materialization)
4. **Hot-path efficiency** (maintain O(num_runs) where expected)

## Recommended change workflow

1. scope the change to specific module boundaries
2. update/add tests near the changed behavior
3. run `cargo check` + `cargo test`
4. benchmark if touching raster/encode/pipeline
5. validate desktop integration behavior for progress/cancel
6. update docs in same PR

## Module guidance

### `raster`

- preserve winding union behavior
- keep AA-off strictly binary
- handle scanline edge rounding carefully

Binary spans include pixel centers in the half-open interval `[left, right)`:
`start = ceil(left - 0.5)`, `end_exclusive = ceil(right - 0.5)`, clipped to the
frame. This matches the existing Y-center sample phase. The shared span builder
applies the same rule to dense masks, binary RLE and binary support/SSAA raster
jobs. Block output clips globally sampled spans, never a block-local phase.
Coverage AA retains floating X boundaries and fractional overlap; do not apply
binary snapping to those bounds or compensate with blur.

Valid closed rows retain subpixel features and holes, including spans containing
one pixel center and fractional AA contributions. Near-canceling crossing pairs
are collapsed only when repairing a defective row, preserving the existing
matched-pair and previous-row leak containment. This intentionally changes old
edge pixels; old raster hashes are not a correctness oracle for the fix.

`binary_spans_use_half_open_pixel_centers`,
`thin_closed_spans_preserve_centers_holes_and_fractional_aa` and
`binary_annulus_matches_center_samples_and_global_block_coordinates` cover
half-pixel ties, clipping, thin geometry, annulus symmetry and block seams.

### `rle`

- always merge adjacent same-value runs
- keep hot helpers lightweight

### `encode`

- avoid full pixel buffer materialization on V3.1 fast paths
- keep packing transforms well-tested (boundary and odd-length cases)
- preserve PNG/pHYs correctness for packed modes

### `pipeline`

- preserve bounded channel architecture
- preserve progress-on-arrival semantics
- keep cancellation checks in both worker and drain loops

### `encoders`

- use registry-driven dispatch, not engine hardcoding
- ensure `RleStreamEncoder` capability flags match behavior
- ensure parallel closures are thread-safe and index-safe

### `engine`

- validate early and fail clearly
- keep error variants meaningful and surfaced

## Adding a new packing mode

Suggested sequence:

1. define mode in `types`
2. add physical→logical RLE transform in `encode`
3. add encode wrapper with correct PNG metadata
4. wire encoder match arm
5. add tests for transform/encode parity
6. document behavior in `ARCHITECTURE` and `PIPELINE`

## Testing checklist

- geometry overlap/disjoint edge cases
- AA off/on behavior
- packing-specific transform tests
- encoder finalization correctness
- benchmark throughput sanity

## Docs policy

If behavior or contract changes, docs must be updated in the same PR.

## Acknowledgment

Many thanks to **mslicer** for algorithmic inspiration that helped guide several V3.1 development decisions.
