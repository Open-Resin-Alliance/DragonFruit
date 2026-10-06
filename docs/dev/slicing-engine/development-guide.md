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

#### Runtime-dispatched AVX2 blur

The shipped x86 baseline remains `x86-64-v2` in `.cargo/config.toml`. Do not
enable AVX2 or FMA globally: older CPUs must be able to reach the scalar kernels.
On x86/x86_64, each blur operation selects function-scoped AVX2 kernels after
runtime CPU/OS feature detection. Other architectures use the scalar kernels.
No FMA or AVX-512 support is required.

- Gaussian XY blur in `raster.rs` processes four pixels with u64 accumulators,
  preserving saturation, horizontal u32 clamping, crop boundaries, integer
  division/rounding and minimum-alpha filtering. Boundaries and tails are scalar.
- Streaming box XY blur retains its rolling horizontal sums and vectorizes the
  independent vertical column additions/evictions eight pixels at a time.
  Radii above 127 retain the original scalar path because horizontal sums no
  longer necessarily fit the u16 ring. No full-image buffer is introduced.
- Dense-mask weighted Z blur in `engine.rs` accumulates contiguous bounded
  source-row spans eight pixels at a time with saturating u32 multiply/add.
  Source offsets, coverage and rounding are unchanged.
- The 3DAA RLE fast path uses the same eight-pixel AVX2 strategy on its decoded
  neighboring rows, without adding heap buffers. It retains scalar division,
  rounding and vector tails, then emits the same cropped RLE as the scalar path.

Sharp benefits only from its XY path; Balanced can use both XY and Z paths.
These optimizations do not change preset selection, blur radii or support policy.
Parity tests cover scalar/AVX2 output, unaligned rows, vector tails, crops,
alpha thresholds and saturation. Run `cargo test --lib` in the slicing crate.
Benchmark representative full exports as well as individual kernels: faster
blur kernels do not guarantee a comparable total slicing speedup.

The engine and CLI report XY and Z post-processing separately as
`post_xy_blur_ns` and `post_z_blur_ns`. They sum elapsed operation durations
across concurrent work, including any waits inside those operations; they are
not pure CPU time and must not be added to wall time or used to infer scheduling
overhead. The CLI also keeps `post_blur_ns` as their saturating sum, matching the
combined blur value used by the desktop IPC/UI. The desktop and benchmark
dashboards are unchanged. The CLI's full `--job` handoff and resolved AA settings
remain those of the pinned `dev` revision.

### `rle`

- always merge adjacent same-value runs
- keep hot helpers lightweight

The non-AA full-width and column-block raster paths emit binary runs directly
from their sorted scanline spans. They do not fill, scan and clear a dense row
buffer. Emission clips spans to the requested column window and unions overlaps;
`RleAccum` preserves canonical merging, including across row boundaries. Pixel
counts, bounds, component areas and previous-row winding coherence are unchanged.
The grayscale row encoder and XY/Z division algorithms are unchanged.

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
