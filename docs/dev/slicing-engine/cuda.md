# Native CUDA slicing backend

The optional CUDA backend places the numerical slicing pipeline in the native C++/CUDA library under `rust/dragonfruit-slicing-engine/native/cuda/`. Rust keeps the public `SliceJobV3` and encoder lifecycle; the CUDA adapter returns final RLE runs to the existing format encoders.

## Build and selection

CUDA support is opt-in:

```text
node scripts/tauri-build.mjs --features cuda
```

The native build uses CUDA 12.9, C++17, a static `df_cuda_slicer` core and the dynamically linked CUDA runtime. CPU-only builds do not require the CUDA toolkit. The current deployment target is 64-bit Windows with Pascal or newer NVIDIA hardware and at least 6 GiB VRAM. The 6 GiB value is a support floor, not a working-set cap.

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

At job creation, the CUDA allocator budgets up to 90% of currently free device memory, including the job's already-owned allocations. Cached device allocations remain charged and are recycled only after their last-use event. Pinned host transfer ranges are bounded separately. Larger GPUs therefore admit more resident geometry, Z-window data and concurrent layer work; the scheduler still preserves the layer window and encoder backpressure.

Large 4K–16K layers are transferred in bounded chunks. No full-frame worst-case RLE buffer is reserved merely because the image is high resolution.

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
