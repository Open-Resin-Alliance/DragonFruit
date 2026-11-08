# Native CUDA slicing backend

The optional CUDA backend places the numerical slicing pipeline in the native C++/CUDA library under `rust/dragonfruit-slicing-engine/native/cuda/`. Rust keeps the public `SliceJobV3` and encoder lifecycle; the CUDA adapter returns final RLE runs to the existing format encoders.

## Build and selection

CUDA support is opt-in. Install CUDA 12.9 with its **Visual Studio Integration**
component and **Visual Studio 2022 Build Tools with MSVC 19.3x** (v143 toolset
14.30–14.39, for example 14.38). A newer default 19.4x VS2022 toolset is not a
substitute; select an older v143 x64/x86 toolset in the installer's Individual
components. The Rust application can retain its VS2026 toolchain.

Native MSVC compilation uses UTF-8 source/execution character sets, including
NVCC's host compilation phase, so UTF-8 CUDA/CUB headers are not decoded using
the machine's legacy code page. CUDA's pre-75 architecture deprecation warning
remains visible: Pascal targets are intentional and stay supported by CUDA 12.9.

```powershell
$env:CUDA_PATH_V12_9 = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9'
node scripts/tauri-build.mjs --features cuda
```

For a development build with the native console and frontend dev server:

```powershell
npm run tauri:dev -- --features cuda
```

`scripts/tauri-dev.mjs` forwards the feature arguments and inherits stdout/stderr.
CUDA dev launches enable the first-output trace unless `DF_CUDA_TRACE` is already
set; set `$env:DF_CUDA_TRACE = '0'` before launching to disable it. The engine build
stages the matching CUDA runtime beside the debug executable, as it does for
release and test executables. Compiling with CUDA does not select it for a job:
choose **CUDA** in the slicing panel.

`CUDA_PATH_V12_9` selects the native toolkit; when unset, the build uses the path
above. Generic `CUDA_PATH`/`CUDACXX` values pointing to newer CUDA versions do not
override it. The build discovers installed VS2022 instances, selects the newest
compatible 14.3x toolset, and pins the generator, instance, C++ toolset, `nvcc`
path and Visual Studio `cuda=` toolkit directory. Both native compilation and
runtime-DLL staging use that same toolkit.

Native build directories are keyed by the toolkit and host compiler under
`OUT_DIR/cuda-12.9-<fingerprint>`. They do not reuse an earlier CUDA 13.x/VS2026
CMake cache, so cleaning the whole Rust target directory is unnecessary. Missing
toolkit integration or compatible MSVC tools produces an explicit prerequisite
error instead of silently selecting a newer compiler.

The native build uses CUDA 12.9, C++17, a static `df_cuda_slicer` core and the dynamically linked CUDA runtime. CPU-only builds do not require the CUDA toolkit or native VS2022 discovery. The current deployment target is 64-bit Windows with Pascal or newer NVIDIA hardware and at least 6 GB VRAM. The 6 GB value is a support floor, not a working-set cap.

The desktop slicing panel and the TypeScript scene CLI expose `cpu` and `cuda`. CPU is the default. The native job checks CUDA availability and reports typed failures. A reported CUDA failure discards that attempt's encoder state and restarts the complete job on CPU; layers are never mixed between backends. Cancellation, encoder errors and filesystem errors do not trigger a retry.

## Native boundary

`native/cuda/include/df_cuda_slicer.h` is the C ABI. It exposes an opaque job handle and coarse operations:

- create a job from borrowed packed triangle/tank buffers and block specifications;
- receive ordered layer/tank/block output descriptors;
- queue one RLE range for direct device-to-host transfer;
- wait for and release the output lease;
- cancel and destroy the job.

The ABI never transfers C++ containers or Rust allocation ownership. `DfCudaRun` is an explicit eight-byte layout. The source geometry remains caller-owned and immutable until job destruction.

Input geometry and final RLE destinations use `cudaHostRegister` plus asynchronous pinned-buffer DMA. Intermediate masks, blur windows, compaction metadata and temporary RLE storage remain in device memory. CUDA events order upload, compute, pack and readback streams. A destination cannot move, be consumed, resized or released until its transfer event has completed.

## Memory admission

The job-wide CUDA allocator budgets up to 90% of currently available device memory, including the job's already-owned allocations. Cached device allocations remain charged and are recycled only after their last-use event. Worker execution contexts share that allocator and the cancellation state; they do not each acquire a separate device budget. Pinned host transfer ranges are bounded separately. Larger GPUs admit more useful in-flight work and wider scratch bands; the scheduler still reserves indispensable neighbor data and ordered RLE output resources.

Large 4K–16K layers are transferred in bounded chunks. No full-frame worst-case RLE buffer is reserved merely because the image is high resolution.

Dependency-plane admission uses a conservative scene-covered physical-row
envelope, including rounded interpolation, phase conversion and the clipped
XY/work-frame halo. The estimate retains full printer width for raster
intermediates; it does not charge full printer height for every empty or sparse
Z-neighbor plane. This avoids rejecting compact high-resolution scenes solely
because their nominal frame is 16K.

Raster scratch is demand-sized after selected candidates and actual row/subrow
descriptors are known. Active lanes use their maximum crossing counts; band
storage uses the largest admitted band actually present in the layer. CUB
temporary storage uses null-storage queries for the planned operations. The
workspace quota remains an admission ceiling, not an eager allocation target.
Buffers retain high-water reuse, so planned bytes in the trace need not equal
resident VRAM after a larger layer.

## Parallel execution

Parallelism has two axes. Raster crossing/span and pixel work run in budget-sized
row/subrow bands; component initialization, unions, counts and frontier stitching
run in parallel GPU bands. Normal raster rows do not read their control state
back to the host. Ordered edge advancement and the narrow defect-orientation
frontier retain their actual numerical dependencies, including partial AA rows
at band seams. Component bands preserve exact 8-connectivity and carry each
bottom-frontier component once.

A native readiness coordinator queues raw, spatial/model and final layer tasks
onto worker-private non-default CUDA streams. GPU slots derive from shared VRAM
admission and GPU concurrency capabilities, **not CPU-core count**. The number
of retained later outputs is bounded, so they cannot consume the resources needed
by the next ordered output. Workers receive dependency-ready tasks; they never
wait for prerequisites queued behind them in the same pool.

`RasterGeometryPtr` and `SharedPostTablesPtr` retain immutable geometry/indexes
and post tables uploaded once by the root. Worker constructors initialize only
private mutable scratch. `Runtime(root, workspace_limit)` shares job memory and
cancellation but owns its own streams; destroying it never clears shared memory.
The root geometry builder's upload/sort scratch is retired before pool admission,
while immutable assets remain alive through every worker's teardown.

Each `(tank, layer)` raw result is cached for reuse rather than rendering and
discarding lookahead planes. Ordinary modes have no topology prefill; preferred
perturbation requires its Z radius, and generic models require complete raw
`look_back` context before spatial processing, followed by the actual Z-model
neighborhood. A worker joins only its own stage stream before publishing a result.
Other admitted workers and root RLE pack/readback streams can continue operating.

Cancellation updates condition-variable predicates under their mutex, wakes
coordinating/worker waits, and drains all tasks and registered DMA before returning
caller-buffer ownership. Exclusively transferred planes acquire the consuming
stream's retirement ownership before a potentially throwing model operation.

GPU consumer tests in `src/cuda/conformance.rs` are explicitly opt-in/ignored.
They cover sloped multi-layer/subrow seams, component merges/splits and extrema,
tank/support isolation, cancellation/input reuse, palette membership, and exposure
bounds in actual merged border regions. The dither case uses active 3DAA mode,
not ordinary Blur where dithering is disabled. Run numerical and throughput
validation only on an approved Windows CUDA machine; source patch applicability
does not establish runtime parity or speedup.

## First-output diagnostics

Use the dev-console trace when a CUDA job is stuck before its first completed
layer. Outside the dev wrapper, set `DF_CUDA_TRACE=1` before launching a
CUDA-enabled binary. Other builds leave it off by default. The opt-in is read
when a native job is created; changing it requires a new launch.

`native/cuda/src/trace.h` and `trace.cpp` provide the job-owned host trace shared
by worker runtimes. Lines beginning `[DF_CUDA_TRACE] HOST` are flushed to stderr.
They report elapsed **host wall time**, not GPU kernel time, and do not add CUDA
timing events, synchronization, per-pixel logging, or geometry dumps.

The startup record includes grid dimensions, triangle count, raster mode and AA
settings. Milestones distinguish device/runtime initialization, geometry and
table preparation, pool admission and worker initialization, and raw/model/final
work for ordered layer zero and the first completion of each stage. Raster plan
records include actual candidates, events, rows, active crossings, bands, CUB
bytes and desired storage versus quota. Allocation diagnostics identify large
allocation/reuse activity and host waits before the first output.

Output milestones cover RLE count and readback. Native diagnostics stop after
the first complete layer's output lease is released, not merely its first block.
`src/cuda.rs` separately logs the first encoder handoff's `encoder.begin` and
`encoder.done` or `encoder.error`; that handoff can be a single block, not a
whole layer. A missing matching completion localizes an outstanding host stage;
GPU utilization alone does not. These logs do not prove numerical parity or a
throughput improvement.

## Raster and post stages

The active backend preserves the current route semantics:

- preferred RLE: binary or Coverage SSAA rasterization, followed by the existing LUT/blur route where the CPU path requests it;
- dense/generic: analytic Coverage or binary model/support rendering, with dense Blur's BOX/LUT stage owned by the postprocessor;
- perturbation 3DAA: active perturbation rasterization, bounded XY/Z post-processing, LUT or deterministic regional energy quantization, and support merge; retired EDT/BFS stages are not restored;
- direct legacy RLE-PNG: normalized binary route with no dense-only support bypass or post/dither stages.

Binary spans preserve global pixel-center phase, winding repair, defective-row pairing, previous-row orientation evidence, mirror behavior and tank/support classification. Coverage keeps fractional boundaries. Support masks merge by maximum after the model stage. Generic legacy work frames retain their global origin, denominator dimensions, topology crop and blur ROI rather than resetting phase at an encoder block.

The deterministic dither path uses globally phased 16×16 regions, merges partial borders into actual in-frame regions, preserves palette endpoints and carries energy within each region. It is checked against requested post-LUT/gamma exposure, not against the CPU Floyd–Steinberg spatial pattern. A region whose actual residual exceeds the strict bound reports a numerical CUDA failure and causes the whole job to restart on CPU.

## Output and lifecycle invariants

RLE output is row-major and canonical: zero prefixes/tails and adjacent equal values are merged, including across chunk and block boundaries. Block streams use global column coordinates. Area statistics are computed once for the final layer/tank result and are not double-counted when a descriptor is split into blocks.

Progress remains layer/tank ordered at the Rust encoder boundary. `cpuFallback` is emitted before the fresh CPU attempt so the UI can reset progress and show the retry. The native backend never silently substitutes a CPU pixel loop for a missing CUDA stage.

## Related pages

- [Slicing Engine overview](index.md)
- [Pipeline](pipeline.md)
- [Architecture](architecture.md)
- [Slice Job Assembly](../slice-job-assembly.md)
- [CLI reference](../../reference/cli.md)
