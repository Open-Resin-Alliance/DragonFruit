# Pipeline

## 1) Job validation

`engine::validate_job` rejects malformed requests up front:

- positive pixel dimensions
- positive, finite layer/build settings
- non-zero layer count
- triangle buffer length multiple of 9

## 2) Geometry parse

`geometry::parse_triangles` converts packed f32 data into typed triangles used downstream by index and raster stages.

## 3) Layer index build

`index::build_layer_index` maps triangles to candidate layer ranges using z-overlap, avoiding full-triangle scans per layer.

## 4) Encoder capability selection

Engine resolves `output_format` via registry and selects one of these paths:

- **preferred**: RLE stream + parallel encode (`render_layers_rle_encoded`)
- **fallback**: RLE stream + serial encode drain (`render_layers_rle`)
- **legacy**: pre-rendered PNG/raw mask materialization path

## 5) Preferred V3.1 path: `render_layers_rle_encoded`

### Worker side (Rayon)

For each layer:

1. `rasterize_layer_rle(...)`
2. encoder closure from `parallel_encode_fn(layer_index, &runs)`
3. send `(layer_index, encoded_bytes)` to bounded channel

### Drain side (serial)

As results arrive out-of-order:

- call `store_encoded_layer(layer_index, bytes)`
- report progress on arrival
- check cancellation

This preserves low memory pressure and smooth progress behavior.

## 6) Fallback RLE path: `render_layers_rle`

Workers emit `(layer_index, runs)`, and serial drain calls `consume_rle_layer`.

This path is still bounded/cancelable and useful for encoders not exposing parallel encode closures.

## 7) Rasterization details

`raster::rasterize_layer_rle` uses scanline winding unions:

- handles overlapping/intersecting solids robustly
- removes opposite-winding crossings less than one source pixel apart before span construction, preventing unrenderable features or gaps from leaking across repeated instances
- keeps unmatched exit/entry gap signatures local when the entry is closer to the orphan exit than its next possible closing exit
- AA off => strict binary 0/255 writes
- AA on => subscanline coverage accumulation to grayscale
- output is row-major `Vec<RleRun>`

### Coverage-off RAW scanline batching

Binary-core jobs use the original scalar triangle/plane intersection math.
The scanline stage batches independent real layers through `scanline_simd`:
lanes keep separate row cursors, edge lists, winding, spans and output. Variable
edge counts, row extents, empty layers and tails do not require matching geometry.
Healthy-row winding and span-boundary arithmetic execute as SIMD; defective-row
repair retains the existing scalar semantics.

Groups contain at most four streams. The concurrency cap admits scanner groups
rather than dividing worker parallelism by four. Twelve workers can therefore
hold up to forty-eight live layer contexts; the bound is at most four times
`DF_V3_MAX_CONCURRENT`. This increases raster scratch and partial-output RSS
relative to singleton scalar rendering and must be included in comparisons.
Groups share one Rayon pool; nested preparation/encoding needs no admission
semaphore or second pool. No model copies or extra output representations are
introduced. Ordered per-layer draining, channels, progress and cancellation
retain their contracts.

Full-width output retains previous-row coherence. Blocks retain context-free
repair, absolute-column phase, halo/crop handling and window-local statistics,
while reusing each layer's scalar geometry across windows. Model/support stream
presence and merged statistics retain their original contracts. Noneligible
AA/perturbation and downstream blur/dithering/encoding remain unchanged.

The crate-private block producer now works with bounded layer groups so each
window can use cross-layer scanline SIMD. It reports eligible raster/stat time
separately from postprocessing and format encoding. `raw_geometry_ns` records
scalar geometry preparation; `raw_scanline_ns` records scanline setup and
rendering. Both remain summed worker elapsed times, not pipeline wall time.

## 8) O(num_runs) PNG encode details

Encode functions in `encode.rs` operate from runs directly:

- `encode_grayscale_png_from_rle`
- `encode_truecolor_packed_png_from_rle` (`rgb8_div3`)
- `encode_grayscale_averaged_png_from_rle` (`gray3_div2`)

Shared implementation ideas:

- row filter bytes interspersed into run stream
- fixed-Huffman single-block deflate
- Adler-32 appended to zlib stream
- PNG chunk assembly (IHDR/IDAT/IEND, plus pHYs for packed modes)

## 9) Finalization

Encoder finalization (`finalize_to_bytes` / `finalize_to_path`) assembles format-specific archives.

## 10) Progress + cancellation semantics

- progress reported per layer completion arrival
- first/final/phase updates emitted immediately by integration throttler
- cancellation is cooperative and checked in both worker and drain loops

## 11) Perf counters

`SlicingPerfV3` provides stage-oriented timings for diagnostics and tuning:

- `index_build_ns`
- `render_wall_ns`
- `render_ns`
- `png_encode_ns`
- `archive_encode_ns`
- `total_ns`

## 12) Perturbation 3DAA independent-layer dithering

The RLE-native perturbation path retains its stage order: raster/XY blur, exact
radius-neighbor Z blur, energy dithering (or tail LUT), then raw support merge.
Only dither-enabled, inert-zero-LUT jobs on a native four-f32-lane Pulp backend
collect up to four ready layers. SIMD lanes are independent Z streams; adjacent
dependent XY pixels are never evaluated together. Raw/ordinary 2D jobs and
dither-disabled jobs follow their existing paths.

The post dispatcher acquires its first existing `PostTaskGate` permit normally.
It probes additional capacity and input/model results nonblocking, popping each
charged center before refilling: pending models stay within the existing
`radius + 1` frontier, each future snapshot contains at most `radius` models,
and history stays radius-sized. An unfinished XY receiver occupies only the
ordinary loop's single waiting-input stage and retains its acquired permit.
Batching adds no Z lookahead, Arc window, image buffer or uncharged layer queue.

A charged partial group can now remain in the external std dispatcher while
other queued/executing post bodies provide useful work. Completion/readiness
notifications wake it to collect toward four; one failed nonblocking extension
does not immediately flush that group. The dispatcher sleeps on the gate's
condvar, never on a Rayon worker, and uses an event-generation/recheck handshake
around capacity/channel probes so notifications before sleep cannot be lost.
Permit availability is also rechecked under that mutex; a failed empty-input
probe cannot generate a self-wakeup loop. There are no fill timers, spins or
polling loops.

If no other useful post body remains, the dispatcher flushes rather than starving
the pool. EOF, cancellation/failure, and an adaptive cap below four also stop
waiting; caps one/two/three keep their original individual dispatch. Ready data
can still fill a group without waiting, including at EOF. Complete four-layer
groups share one scoped worker; every partial group and final tail is split into
the original individual per-layer scoped tasks.

`PostTaskBody` registers one queued/executing body before scoped injection and
ends after finalization, **before encoding or sending output**. A blocked sink
therefore cannot be mistaken for useful post work. Body completion/unwind,
successful input enqueue, XY result readiness/disconnection, input sender closure
and cap retuning notify the same gate. Sender lifetime guards publish readiness
only after the corresponding sender is dropped, including unwind. Existing
source-side output draining stays independent of the dispatcher; no source or
waiting-input stage must acquire a dispatcher-owned progress resource. Jobs
ineligible for batching do not register bodies or add input/XY notifications.

The blocking post dispatcher runs on its existing scoped std thread via
`ThreadPool::in_place_scope`, while finalization still runs on the unchanged post
pool. This matters even for scalar/low-cap jobs: Rayon local-deque spawn wakeups
may miss sleeping peers and rely on the pushing worker eventually executing its
own jobs. A dispatcher that immediately blocks in a gate/channel wait cannot
provide that fallback. External scoped injection provides the required wakeup
guarantee without extra threads, capacities, polling or changing pinned caps.
Low-cap consumer tests also assert that the real dispatcher is not a Rayon worker.

Every collected/queued/active/waiting post layer owns one RAII `PostTaskPermit`.
Z windows are dropped after blur, but the permit stays with retained gray/dithered
RLE and byte-row/error-row scratch through support merge. When a layer's turn
arrives, only its permit is released at the original post-finalize/encode boundary;
the other three outputs of a full batch remain charged while they wait. The
current layer then occupies the existing one-output-per-worker encode stage and
bounded output channel. Scalar, partial and dither-disabled tasks retain that
same original release point. Failure/unwind drops unsent waiting outputs and
their permits. The output drain still routes by layer index and reports progress
on each arrival; support order, cancellation and sink-error propagation remain
per layer.

The default admission ceiling is four times the selected post-worker count,
allowing one complete four-layer group per worker: 48 charged layers for twelve
workers, or eight for two workers. This changes the default, not
`DF_3DAA_POST_MAX_INFLIGHT`: that explicit pin still disables adaptation. Normal
jobs retain the existing half-free-RAM budget and worst-model-layer retuning
formula, which may lower the live cap below the worker-scaled ceiling. Channel
capacities, raster/model-receiver staging bounds, post pool size, Z windows and
permit release points are unchanged. The fixed batch contains at most four
charged layers, not another gray-layer queue. Dither scratch is streamed rows,
not image buffers; see
[Development Guide](development-guide.md) for the private APIs, Pulp width policy,
exact arithmetic and regression tests.

The queued/executing body count is a **batch-fill liveness predicate**, not a
worker-utilization or CPU-occupancy counter. Z blur has internal parallelism, so
four batch closures do not imply four busy cores. Likewise the existing in-flight
task/window statistics count charged layers and logical Arc-shared windows, not
unique RSS or occupied workers. Evaluate grouping coverage and actual process CPU
in a separate untimed diagnostic; production timing binaries must not carry a
diagnostic overlay.
