# dragonfruit-slicing-engine

Native Rust slicing backend for DragonFruit Desktop (Tauri), currently at **v3.2.1**.

This crate is the production slicing engine that converts triangle geometry into printer-ready layer containers. Format output is dispatched through a plugin-driven encoder registry (currently `.nanodlp`, `.ctb`, `.goo`, and others).

## What changed in v3.2

v3.2 adds volumetric anti-aliasing, grayscale dithering, and a deeply reworked post-processing pipeline:

- **3DAA (Z-axis anti-aliasing)** — perturbation-based Z supersampling with XY blur, Z blur, cross-layer edge-aware blending, backward distance-field propagation, and topology-gated floor thresholds. Eliminates stairstepping on sloped surfaces without a full 3D voxel pipeline.
- **RLE-native perturbation 3DAA path** — low-memory 3DAA mode that operates directly on run-length-encoded masks with row-streamed Z-blur kernels. Keeps per-layer working sets compact even at 12K resolution.
- **Binned Floyd–Steinberg dithering** — O(1) binned energy lookup for non-8-bit display systems (2–7 bit). Integrates with the cure LUT and device gamma to produce perceptually linear PWM values.
- **Dedicated encode thread** — PNG/format encoding runs concurrently with the next layer's raster + EDT pipeline, recovering ~35 ms/layer of serialised latency.
- **Parallel post-processing workers** — topology sweep, backward EDT, and cross-blend stages fan out across multiple threads for large layers (≥ 8 MPx), with ROI-local workspace bounds to keep resident memory practical.
- **Gaussian blur kernels** — adjustable sigma on X, Y, and Z axes, replacing the previous box-only blur. Centre-weight scaling prevents over-dominance at low kernel depths.
- **Classified support geometry** — `model_triangle_count` field splits model and support triangles in the flat buffer. Supports can be rasterised independently (binary) and composited, or excluded from AA passes.
- **Vertical-AA refactored as ZAA** — the old `Vertical2` mode is absorbed into the unified ZAA kernel selector (`zaa_kernel`, `zaa_pattern`, `zaa_duplicate_z`).
- **Winding-leak containment** — hardened scanline rasteriser against defective meshes with flipped or degenerate rows.
- **GOO v5 support** — encoder for Elegoo's GOO v5 container format.

## End-to-end flow

1. Validate `SliceJobV3`
2. Parse packed geometry into typed triangles
3. Build per-layer triangle index
4. Rasterise each layer to RLE (binary or multi-sample)
5. **3DAA post-processing** (when enabled) — backward EDT, cross-blend, XY/Z blur, topology-gated floors, tail-LUT remap
6. **Support mask merge** — overlay independently-rasterised support geometry
7. Encode layers (parallel or streaming, depending on encoder capability)
8. Finalise container bytes/path through the format encoder

## Core API

```rust
// Slice to an in-memory artifact (layers held as PNG/RLE depending on encoder)
pub fn slice_with_progress_v3(
    job: SliceJobV3,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SliceArtifactV3, SlicerV3Error>

// Slice directly to a filesystem path
pub fn slice_with_progress_v3_to_path(
    job: SliceJobV3,
    output_path: &Path,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SlicingPerfV3, SlicerV3Error>

// Lower-level pipelines (RLE, encoded, perturb-3DAA) — see engine.rs
pub fn slice_and_rasterize_rle_v3(...)
pub fn slice_and_rasterize_rle_encoded_v3(...)
pub fn slice_and_rasterize_perturb_3daa_rle_v3(...)
pub fn slice_and_rasterize_v3(...)
```

Primary public contracts live in:

- `src/lib.rs` — crate root, re-exports, `ENGINE_VERSION`
- `src/types.rs` — `SliceJobV3`, `SliceArtifactV3`, `ProgressCallbackV3`
- `src/engine.rs` — orchestration, validation, all public entry points, `SlicerV3Error`

## Module map

| Module | Role |
|--------|------|
| `types` | Job contract, render payloads, progress/error types |
| `engine` | Orchestrator, validation, encoder dispatch, 3DAA pump thread |
| `geometry` | Triangle parsing and XY projection |
| `index` | Per-layer triangle candidate lookup |
| `raster` | Scanline rasterisation (binary and multi-sample AA) |
| `rle` | Run-length encoding primitives, accumulators, row emitters |
| `pipeline` | Bounded parallel work dispatch, progress, cancellation |
| `binary_mask` | Bounded binary/gray masks with row-span views |
| `dither` | Floyd–Steinberg binned dithering for low-bit-depth displays |
| `zaa` | Z-axis anti-aliasing kernel selection and perturbation patterns |
| `encode` | RLE-to-PNG encoding, sub-pixel packing (`rgb8_div3`, `gray3_div2`) |
| `encoders` | Format encoder registry, trait definitions, plugin-generated encoders |
| `metrics` | `SlicingPerfV3` timing counters |
| `benchmark` | Internal benchmarking harness |

## Anti-aliasing modes

| Mode | Description |
|------|-------------|
| `Off` | Binary rasterisation, no AA |
| `Blur` | 2D box/Gaussian blur post-process on grayscale masks |
| `Coverage` | Multi-sample Y sub-scanline AA with analytic X span coverage |
| `3DAA` | Perturbation-based Z-axis supersampling with XY + Z blurs, cross-layer blending, and topology-gated thresholding |

3DAA is the recommended mode for production-quality prints. It operates via a dedicated pump thread that overlaps rasterisation with EDT/blur work, and a separate encode thread so container packaging never stalls the pipeline.

## Encoder registry

Output formats are discovered through a trait-based registry (`encoders/registry.rs`). Each encoder declares:

- The file extension(s) it handles
- Whether it supports parallel layer encoding
- A finalisation function that assembles the container

Plugin-owned encoders (Elegoo GOO, Anycubic, CTB, etc.) live in `encoders/generated_plugin_encoders.rs`. The registry is queried at runtime; adding a new format does not require engine changes.

## Environment controls

| Variable | Effect |
|----------|--------|
| `DF_V3_MAX_MASK_INFLIGHT_MB` | Caps concurrent in-flight raster masks (memory budget) |
| `DF_V3_STREAMING_BUFFER_DEPTH` | Streaming pipeline buffer depth (default 4) |
| `DF_3DAA_POST_THREADS` | Override 3DAA post-processing thread count |
| `DF_3DAA_POST_BUFFER_DEPTH` | Override post-worker pipeline depth (0 = sequential) |
| `DF_3DAA_ENCODE_BUFFER_DEPTH` | Encode channel capacity (default 3 for RLE baseline) |
| `DF_3DAA_XY_BLUR_RADIUS_SCALE` | Scale factor for XY blur radius (default 1.5) |
| `DF_3DAA_Z_BLUR_CENTER_WEIGHT_SCALE` | Centre-weight damping for Z-blur Gaussian kernel (default 0.8) |
| `DF_3DAA_RATE_LOG_EVERY` | Log encode throughput every N layers (0 = off) |
| `DF_ZAA_PERTURBATION_MODE` | Perturbation pattern override (`uniform`, `halton`, `base2`) |

## Integration notes

- `src-tauri` depends on crate `dragonfruit-slicing-engine` (lib: `dragonfruit_slicing_engine`).
- Slicing runs inside a dedicated Rayon pool (`dragonfruit-slicing-engine-N` threads).
- Progress events are throttled in the Tauri bridge for UI smoothness (~60 fps).
- Cancellation is atomic and cooperative — checked between layers and at sub-step boundaries within 3DAA.

## Documentation map

- [`docs/README.md`](docs/README.md) — docs index and module summary
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design and module boundaries
- [`docs/API.md`](docs/API.md) — public API and error semantics
- [`docs/PIPELINE.md`](docs/PIPELINE.md) — execution path details
- [`docs/ENCODERS.md`](docs/ENCODERS.md) — format registry and encoder traits
- [`docs/INTEGRATION_TAURI.md`](docs/INTEGRATION_TAURI.md) — Tauri bridge integration
- [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md) — performance measurement
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — common issues and debugging
- [`docs/DEVELOPMENT_GUIDE.md`](docs/DEVELOPMENT_GUIDE.md) — contributor setup and conventions
- [`docs/ROADMAP_V3_2.md`](docs/ROADMAP_V3_2.md) — v3.2 planning and design notes

## Documentation policy

Any change to pipeline semantics, public types, encoder contracts, AA behaviour, or packing logic should update the relevant docs in the same PR.

## Acknowledgement

With genuine appreciation: **many thanks to the mslicer project and contributors** for inspiration on slicing and rasterisation algorithms that helped inform DragonFruit's design direction.

DragonFruit's implementation is fully integrated and maintained in this repository.
