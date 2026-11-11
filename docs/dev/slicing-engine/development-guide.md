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

### Coverage-off RAW scanline SIMD

Triangle/plane intersections use the original scalar geometry helper. The
previous intersection work-pair SIMD kernel has been removed. Parsed/projected
triangles and `LayerIndex` candidate slices remain shared; the cutover adds no
whole-model copy or triangle-by-layer Cartesian-product queue.

`scanline_simd` renders bounded groups of independent real layer streams.
Each SIMD lane has its own row cursor, active edges, winding accumulator,
spans, previous-row history and output. Layers need not share geometry, edge
counts or Y extents. Healthy-row winding predicates and binary span-boundary
arithmetic are vectorized; this is not merely SIMD geometry preparation or
edge-X advancement. Defective rows retain the existing scalar matched-crossing
repair, with previous-row coherence for full output and context-free repair for
block windows.

`BinaryScanlineRaster` owns one stream's scanline index, scratch and output.
Its row preparation and commit methods retain global coordinates, zero rows,
statistics and incremental-X ordering. The crate-internal RLE entrypoint is:

```rust
let mut rasters = segments_by_layer.iter().map(|segments| {
    crate::raster::BinaryScanlineRaster::new_rle(job, segments, false, None)
}).collect::<Vec<_>>();
crate::scanline_simd::render_scanline_batch(
    &mut rasters, backend, cancel_flag,
)?;
for raster in rasters {
    let (runs, stats) = raster.finish_rle();
    consume_layer(runs, stats)?;
}
```

A group contains at most `MAX_SCANLINE_LANES` streams. `DF_V3_MAX_CONCURRENT`
limits scanner groups/workers, not layers divided by the SIMD width: twelve
workers can run twelve four-layer groups, retaining up to forty-eight layer
contexts. This finite working-set increase is intentional and must be measured
as peak RSS; it is not an implicit promise of the old one-layer-per-worker RAM
footprint. Group jobs use the same Rayon pool, with nested scalar preparation
and per-layer encoding. Binary masks use their required per-layer output
buffers, not an additional full-frame RLE expansion. Blocks reuse scalar
geometry across windows. Use the same high safety ceiling (without memory-high
throttling) when comparing variants, so real RSS differences remain visible.

`Backend::for_layer_scanline` narrows x86 execution to four native f32 lanes;
the complete batch enters one Pulp feature gate on its executing worker.
Scalar fallback is real scalar rendering. No per-row/per-vector feature
dispatch, FMA, approximate reciprocal, changed pixel-center phase or
closed-form replacement of incremental scanline X is introduced. Mask selection
uses portable Pulp operations, never mask/vector size assumptions.

`raw_geometry_ns` now measures scalar preparation. `raw_scanline_ns` measures
scanline setup/render/stat work, excluding postprocessing, format encoding and
sink waits. They remain summed worker elapsed times, not wall time. Noneligible
AA/perturbation, blur and dithering retain their original algorithms. Compare
real output and the existing phase counters before claiming a throughput gain.

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

### Prepared perturbation 3DAA support splits

For a valid model/support boundary with support AA disabled, the perturbation
3DAA RLE path prepares `PerturbSupportSplitJobs` once per render in `pipeline.rs`.
The internal model job clears split metadata after candidate classification, so
it cannot re-enter the generic support-bypass full-frame mask fallback. Model AA
samples, patterns and all later XY/Z/LUT/dither processing are unchanged. The
cached support job remains AA Off/Coverage with a binary core, merged after the
model tail. No halo settings or generation are introduced.

Support-free layers use the prepared model directly before partition allocation.
Required component statistics are computed once on the final combined or
support-only stream. Raw, ordinary 2DAA and support-AA-enabled jobs retain their
previous paths. No worker, queue/window or adaptive RAM limits are changed by
support preparation.

### Active-row perturbation RLE coverage

Only the Z-perturbed branch of `rasterize_layer_rle` tracks each physical row's
union of touched X extents across its subscanlines. Coverage resolution and
scratch cleanup visit that range and its closing delta sentinel, with explicit
zero runs before and after the emitted interval. Every emitted row byte is
overwritten, including fractions that round to zero; bytes outside the interval
are never emitted, so no whole-row clear is needed. Component row transitions,
float accumulation order, winding repair, clipping, bounds and statistics remain
unchanged. Binary single-Z, dense/ordinary 2DAA and block raster paths are untouched.

### Touched-row 3DAA XY BOX blur

The perturbation engine calls the private
`blur_gray_rle_streaming_3daa_with_bounds` entry. It const-specializes the shared
streaming BOX kernel to track decoded row extents, expanded horizontal ranges
and per-ring-slot bounds. Addition, eviction, normalization and RLE emission
visit only the relevant ranges; zero decoding clears only overlap with prior
content. Moving/contracting or empty ranges cannot reuse stale source rows.

SIMD and scalar-tail normalization offset their divider metadata to the same
image-global coordinates; cropped row ranges do not change border denominators,
integer rounding or output bounds. Extra bounds metadata is O(radius) on the
stack, with no new row-sized/image buffer or cache. The optimized domain is the
existing 3DAA radius limit 0–6 and min-alpha zero; larger radii use the original
generic kernel. Public BOX blur callers retain the dense-ROI specialization,
so Raw and ordinary 2DAA do not acquire sparse per-pixel checks or new settings.

These paths compose with the independent-layer dithering below: prepared support
splits feed the active-row rasterizer, whose gray RLE stream feeds touched-row
BOX blur and the existing Z blur. The model then receives LUT/energy dithering
before raw supports are merged. Raster/blur bounds metadata does not cross the
stage boundary. The combined variant uses default admission of four times the
selected post-worker count and retains its adaptive RAM clamp; no extra worker
or image buffer is introduced.

### Portable SIMD arithmetic

`pulp_simd` is a crate-private dispatch seam shared by XY/Z blur and RAW scanlines.
Operations implement `pulp::WithSimd` once: blur uses generic integer arithmetic,
while `scanline_simd` uses integer winding and exact FP32 span arithmetic. The application owns no
x86 intrinsics or handwritten CPU-feature-gated kernels. Pulp 0.22.3
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

### Independent-layer Floyd–Steinberg SIMD

Perturbation 3DAA RLE jobs with dithering enabled can run four independent layer
streams together **after Z blur and before raw support merge**. This is not SIMD
over adjacent pixels: each layer still walks left-to-right, top-to-bottom, and
has its own two f32 error rows, source decoder, output accumulator and exact carry
band. No error crosses Z. The scalar API and ordinary 2D/Raw paths are unchanged.

The crate-private surface in `dither.rs` is `DitherLayer`,
`LAYER_DITHER_BATCH`, `can_batch_layers`, and `dither_rle_layers`. Borrow input
runs (do not clone them), supply dimensions per stream, and dispatch from the
worker executing the operation:

```rust
let backend = Backend::detected();
let layers = std::array::from_fn::<_, 4, _>(|lane| DitherLayer {
    runs: &model_runs[lane], width, height,
});
let output = dither_rle_layers(&layers, &palette, backend);
```

The returned fixed array has one output per supplied stream; unused entries are
empty. The private API accepts zero through four streams. A complete native-four
batch performs packed f32 addition, subtraction and multiplication; partial
batches, scalar backends and non-zero-at-input-zero LUTs call the original
`dither_rle_layer_with_lut_and_gamma`. Its empty/all-zero-layer decisions and
full-frame fallback remain the oracle, even for a curing-zero LUT. Neither
clipping margins nor approximate error cutoffs are permitted.

`Backend::for_layer_dither` reuses the cached runtime feature proof but narrows
x86 V3/V4 to their Pulp-provided native V2 gate: four f32 lanes, not eight or
sixteen mostly-unused lanes. This is an operation-specific width choice, not a
user override; XY/Z blur retain their existing wider backend selection. Other
architectures use their existing Pulp dispatcher, batching only when its f32
width is exactly four. The arithmetic gate is entered on the executing scoped
post worker. `can_batch_layers` checks width/inert-zero eligibility once for
scheduling, not inside pixel loops.

The native kernel `dither_independent_layers_with_simd` has interleaved complete
four-f32 error-row vectors and individual byte rows: `32 * max(width)` error
bytes plus the sum of active stream widths in byte-row storage. Production
streams have equal dimensions, so this equals four scalar row working sets.
There is no full-frame expansion, per-pixel allocation, input-RLE copy, or scratch
for eight/sixteen native lanes. Different dimensions/ROIs retain per-lane borders
and the exact existing carry-band growth/clearing rules. Table lookup remains
scalar per lane; FS energy/bin arithmetic and error-weight multiplication/addition
are separate f32 operations. Do not introduce FMA or reassociate additions.

After each row, scalar and per-lane SIMD carry bounds contract to the first and
last actual nonzero incoming errors. Only exact signed zeros are discarded;
positive/negative subnormals, infinities and NaNs remain active. Zero-only tails
can therefore close naturally instead of widening an obsolete interval. The
full-frame oracle, diffusion order and row-clearing range are unchanged; there
is no epsilon, FTZ/DAZ mode or assumed clipping margin.

#### Borrowed source rows

`RleSourcePosition` derives each row's actual raw-nonzero input extent without
expanding an input byte row. `RleEnergyCursor` caches the exact immutable source
energy for the current input run, including across rows. The processed interval
is the union of actual input and incoming-error bounds; rightward bleed is still
followed. Existing byte rows hold output only. No input clone, frame buffer or
per-row span vector is added, and non-inert-zero LUTs keep the full-frame path.


`finalize_perturb_rle_post_batch` owns the Z-blurred gray outputs while every
layer remains charged to `PostTaskPermit`. The collector
`extend_perturb_rle_post_batch` uses `try_extend_perturb_rle_post_batch` for
nonblocking probes, but retains a charged partial group while other queued or
executing post bodies can make useful progress. The external std dispatcher alone
may wait on `PostTaskGate`; it samples the gate generation before probing and
rechecks generation, permit availability, body count, EOF/failure and the current
cap under the same mutex before sleeping. Empty probes do not advance generation,
avoiding self-notification spins. Cap shrink below four, no useful bodies, EOF
or failure flush without waiting. Partial groups still split into individual
scoped tasks; low caps and final tails never serialize their scalar chains.

`PostTaskBody` is an RAII queued/executing-body guard, registered before spawn
and dropped after finalize, before encode/output send. `PostInputProgress`
publishes XY readiness/disconnection or source closure after its sender drops,
including panic. Successful source enqueue and cap changes also notify the gate.
Only batch-eligible jobs create these guards/notifications. Existing permit
release points, channel depths, RAM formula, radius windows and the single
waiting-input stage are unchanged; see [Pipeline](pipeline.md).

Regression tests named `layer_simd_` cover scalar-run parity for all CPU-supported
Pulp backends, zero through four streams, dimensions/ROIs, curing-zero fallback,
subnormals, quantization boundaries, packed FP arithmetic, consumer routing,
monotonic progress, low caps, 257-layer slow-sink pressure, sink/cancellation
failure and permit unwind. `queue_aware_` tests use channel/condvar handshakes,
not sleeps/polling, to retain a partial group across absent input and unfinished
XY work, form four after notifications, flush on last-body completion while its
encode permit remains held, handle shrink/EOF/failure/cancellation/body/XY unwind, and cover
notifications or permit release before sleep. Consumer tests add all one-through-
seven-layer tails with zero/nonzero Z radius and both RLE/encoded sinks. The
wait observer, backend and cap injection are test-only and never mutate process
environment.

Body/task counts are not occupied-worker or CPU measurements: Z blur has internal
parallelism, and logical Arc-window bytes are not unique resident memory. Measure
actual process CPU and grouping coverage separately in an untimed diagnostic.
A benchmark must prove a native four-stream execution inside `LayerDither::with_simd`
in the real CLI, then remove the throwaway diagnostic before measuring production
code. No diagnostic overlay belongs in production timing binaries.


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
