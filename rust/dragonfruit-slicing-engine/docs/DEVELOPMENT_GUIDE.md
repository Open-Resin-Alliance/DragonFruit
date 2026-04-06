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
