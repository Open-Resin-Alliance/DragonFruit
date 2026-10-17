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

### Portable SIMD arithmetic

`pulp_simd` is a crate-private seam shared by XY raster blur and Z blur. Each
operation implements `pulp::WithSimd` once, with generic integer arithmetic; the
application owns no x86 intrinsics or handwritten CPU-feature-gated kernels. Pulp 0.22.3
provides the runtime-gated native implementations. On x86 the cached selection
is AVX512/x86-64-v4, then AVX2/x86-64-v3, then SSE/x86-64-v2, then scalar. The
explicit v2 choice is important: Pulp's stock x86 dispatcher otherwise skips
that native SSE fallback. Other architectures retain Pulp's native dispatcher
and scalar fallback. Do not enable AVX2 or AVX512 globally in compiler flags;
the x86-64-v2 build baseline remains unchanged.

Call `Backend::detected()` outside pixel/vector loops and pass the result into
work chunks. Call `Backend::dispatch` **inside the thread executing that work**,
including inside Rayon worker closures, so Pulp's feature-gated entry covers
the actual arithmetic. Streaming and sequential box blur dispatch once for the
complete operation; keep generic row helpers inline inside that gate. Parallel
work chunks dispatch on their executing worker, never per pixel or SIMD vector:

```rust
// Each operation implements `pulp::WithSimd` and borrows its row/chunk scratch.
let backend = Backend::detected();
operations.into_par_iter().for_each(|operation| {
    backend.dispatch(operation);
});
```

Streaming box blur uses `BoxRleBlur`; dense sequential box blur uses
`BoxSequentialBlur`. Normal/oversized radius selection stays outside pixel
loops, with const-specialized horizontal addition and column add/subtract.
Scalar and oversized-radius paths retain fused full-u32 addition before
truncated-u16 eviction. Measure complete XY/Z operations and native exports
against manual AVX+RLE; a column-only microbenchmark is not acceptance.


The shared helpers widen byte/16-bit input directly into one u32 vector, clamp
unsigned addition/multiplication instead of accepting Pulp's wrapping arithmetic,
and form exact 32×32→64 products in ascending pixel order (lower half followed by
upper half). Gaussian products use `widening_mul_u32_to_u64`, not `mul_u64s`,
which is scalar on Pulp's v2/v3 backends. Complete u32 scratch chunks use
`S::as_simd_u32s` or `S::as_mut_simd_u32s` and direct vector reads/writes;
partial-access APIs are reserved for incomplete vectors. Reuse row scratch and
rings, preserving tail handling, cropped support and zero-row emission without
adding full image buffers or changing pipeline memory/backpressure lifetimes.

For Z blur, choose arithmetic once from the checked sum `W` of present-source
weights. Checked `255 * W + floor(W / 2) <= u32::MAX` proves products, partial
sums and normalization's rounding bias fit. Unit weights use addition only;
bounded non-unit weights use native low-u32 products and ordinary addition.
Unbounded weights retain saturating arithmetic and existing overflow behavior.
Dense Z crops each source once per row, reusing u32 accumulation and byte
coverage scratch for the complete operation; there is no per-vector crop or
nonzero-row prescan. Integer rounding and missing-neighbor denominators stay exact.

Normalization keeps the integer algorithm `(sum + floor(d / 2)) / d`; do not
replace it with an uncorrected floating-point reciprocal. `U32Divider` in
`pulp_simd` precomputes `floor(2^32 / d)`. The high half of its product with the
rounded numerator is at most one below the exact quotient; one remainder
comparison corrects it. Denominator one is an identity. This is exact for the
full u32 range, including rounding ties, and works with per-lane denominators
through `divide_u32s`.

BOX normalization caches the image-global horizontal denominator plateau and
reuses it while the vertical count is unchanged. Boundary-vector metadata stays
on the stack; no denominator matrix or additional image buffer is allocated.
Z normalization constructs one divider from the weights of sources actually
present in the layer, then reuses it across rows. Dense Z selects coverage in
the vector before byte emission, preserving uncovered output pixels. These
changes remove per-pixel integer division, not missing-neighbor or border
attenuation. Scalar tails use the same exact u32 quotient.

Gaussian emission needs only `min(n / d, 255)`. `U64ByteDivider` precomputes
an exact `floor(2^64 / d)` constant for scalar tails and narrow-vector plateau
lanes; multiply-high plus one remainder correction replaces hardware division.
On eight-u64-lane vectors it recovers the clipped quotient with eight descending
compare/subtract steps, testing `d * 128` through `d * 1`; unreachable
overflowing products are skipped. The eight-step method regressed complete V3
Gaussian workloads, so narrower vectors retain the constant-divisor method.
Mixed border denominators use `divide_u64s_to_u8`: vector doubling/overflow
masks on wide vectors, original scalar division on narrow boundary tiles rather
than rebuilding a reciprocal per pixel. No denominator matrix is allocated.
Uniform plateau denominators are reused, coefficient precision is unchanged,
and rounding-bias addition still wraps in release and panics in debug.

Gaussian precision is unchanged: retain the 1024 coefficient scale, crop-specific
denominators, saturating accumulation and horizontal u32 clamp, and the existing
integer divide/round/min-alpha behavior. Reduced precision is a separate
experiment, not a side effect of SIMD dispatch. Consumer tests may force each
CPU-supported backend through the test-only `Backend::supported_for_tests()`
iterator; shipping code has no backend override or telemetry.

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
