# Island Detection

## Purpose

The `dragonfruit-islands` crate identifies **unsupported regions** (islands) in 3D printed models. An island is a contiguous group of solid pixels on a layer that has no support from the layer below — these regions will fail to print correctly on resin printers without added supports.

Ported from the TypeScript implementation in `src/volumeAnalysis/IslandScan/` to native Rust for performance. Achieves **7-8x faster island scanning** and **28x faster end-to-end** (including rasterization) compared to single-threaded TypeScript.

## Crate Structure

```text
rust/dragonfruit-islands/
├── Cargo.toml
├── docs/ISLANDS.md           (this file)
├── src/
│   ├── lib.rs                — Crate root (module declarations)
│   ├── geometry.rs           — Re-exports from dragonfruit-slicing-engine
│   ├── model.rs              — Core domain types (Value Objects, Entities)
│   ├── rle.rs                — RLE Domain Service (stateless mask algebra)
│   ├── scan.rs               — Per-layer scan Domain Service
│   ├── tracker.rs            — IslandTracker Aggregate Root
│   ├── pipeline.rs           — Application Service (orchestration)
│   ├── rasterize.rs          — Triangle-to-RLE rasterization (scanline fill)
│   └── bin/
│       ├── island_bench.rs   — Synthetic speed benchmark
│       ├── island_diff.rs    — Semantic comparison of TS vs Rust output
│       ├── island_harness.rs — Run pipeline against golden fixtures
│       ├── island_ipc_debug.rs — IPC debugging tool
│       ├── island_scan_cli.rs  — Standalone island scan CLI
│       └── island_stl_bench.rs — Real STL file benchmark
```

### Dependencies

```
dragonfruit-slicing-engine  ← geometry types (Vec3, Triangle, parse_triangles)
       ↑
dragonfruit-islands    ← this crate (island detection library + tooling)
       ↑
src-tauri (Tauri app)  ← imports islands directly for IPC command
```

### DDD Building Block Mapping

| Concept | DDD Type | Rust Type |
|---|---|---|
| `RleRun`, `RleMask`, `RleLabels` | Value Object | Immutable-by-convention, `Clone + PartialEq` |
| `RleLabelRun`, `ComponentInfo` | Value Object | Per-component statistics |
| `IslandId` | Value Object (Newtype) | `struct IslandId(u32)` — type-safe ID |
| `Island` | Entity | Has `id: IslandId`, mutable lifecycle |
| `IslandTracker` | Aggregate Root | Owns all Islands, enforces merge invariants |
| `scan_layer()` | Domain Service | Stateless per-layer detection |
| RLE operations | Domain Service | Stateless mask algebra |
| `run_island_scan()` | Application Service | Orchestrates the pipeline |
| `IslandScanJob` | Value Object (Command) | Input parameters |
| `IslandScanResult` | Value Object (Result) | Output data |

## Pipeline

Three-phase pipeline matching the TypeScript `ScanOrchestrator`:

```text
Phase 1: Per-layer scan (parallel via rayon)
  For each layer:
    supported  = current_mask AND Dilate(prev_mask, buffer)
    candidates = current_mask MINUS supported
    labels     = ConnectedComponents(candidates)

Phase 2: Island tracking (sequential — cross-layer dependency)
  For each layer:
    solid_components = CCL(solid_mask)
    For each solid component:
      Find overlapping island IDs from previous layer
      → 0 overlaps: new island
      → 1 overlap:  continuation (update existing)
      → N overlaps: merge (create placeholder, evaluate after 30 layers)

Phase 3: Volume calculation + filtering
  For each island:
    volume = Σ(per_layer_area × layer_height)
  Filter: remove placeholders, remove islands below min_area threshold
  Reassign placeholder pixels to resolved parent islands
```

### Why Phase 2 is sequential

Each layer's island labels depend on the previous layer's island labels. The tracker maintains state (pending merges, parent chains) that must be updated in order.

### Why RLE is fast

The RLE representation makes algorithm complexity proportional to **object perimeter**, not grid area. For the Lilith wing model (659×804 grid, 3.1% fill), CPU processes ~3K runs per layer vs 530K pixels in a dense grid — a 150x working-set reduction.

## Key Algorithms

### RLE Operations (`rle.rs`)

All operations work directly on sorted run lists, never decoding to dense grids:

- **`rle_encode` / `rle_decode`** — Binary grid ↔ RLE conversion
- **`rle_encode_labels` / `rle_decode_labels`** — Labeled grid ↔ RLE conversion
- **`rle_intersect_dilated(A, B, buffer)`** — Computes `A AND Dilate(B, buffer)`.
- **`rle_subtract(A, B)`** — Computes `A AND NOT B`. Two-pointer sweep.
- **`rle_label_components(mask, connectivity)`** — Two-pass connected component labeling on RLE data using union-find. Supports 4 and 8 connectivity.

### Island Tracker (`tracker.rs`)

Aggregate Root managing cross-layer island propagation:

- **Overlap detection**: Searches a `±neighborhood` pixel window in the previous layer's island labels.
- **Merge handling**: Creates a placeholder island and records a `PendingMerge`. After 30 layers (evaluation window), the candidate with the highest cumulative overlap becomes the parent.
- **Parent resolution**: Chains of placeholders resolved via iterative traversal with cycle protection.

## Tests

### Unit Tests (15 total)

Run with: `cargo nextest run -p dragonfruit-islands`

**RLE tests** (`rle.rs` — 7 tests):
- `encode_decode_roundtrip`, `encode_decode_labels_roundtrip`
- `subtract_basic`, `intersect_dilated_basic`
- `label_components_4_connectivity`, `label_components_8_connectivity`
- `pixel_count`

**Scan tests** (`scan.rs` — 3 tests):
- `first_layer_all_candidates`, `supported_pixels_removed`, `buffer_expands_support`

**Tracker tests** (`tracker.rs` — 2 tests):
- `single_island_tracked_across_layers`, `two_separate_islands`

**Pipeline tests** (`pipeline.rs` — 3 tests):
- `pipeline_single_cube_no_islands_after_layer_0`, `pipeline_two_separated_cubes`, `pipeline_overhang_creates_new_island`

### Golden File Parity Tests

Validates Rust output against TypeScript golden data across 5 synthetic meshes. Fixtures are **generated** (not checked in):

```bash
# Step 1: Generate golden fixtures from TypeScript (run from repo root)
npx tsx scripts/island-debug-export.ts --synthetic all --output fixtures/island-scan/

# Step 2: Run Rust harness (from rust/dragonfruit-islands/)
for mesh in cube two-cubes t-overhang bridge hollow; do
  cargo run --bin island_harness -- \
    --fixture ../../fixtures/island-scan/$mesh --stage tracker \
    --output ../../fixtures/island-scan/$mesh/rust-output
done

# Step 3: Validate parity
for mesh in cube two-cubes t-overhang bridge hollow; do
  echo "=== $mesh ==="
  cargo run --bin island_diff -- \
    --golden ../../fixtures/island-scan/$mesh \
    --actual ../../fixtures/island-scan/$mesh/rust-output
done
```

### Real STL Benchmark

```bash
# Rust benchmark (from rust/dragonfruit-islands/)
cargo run --release --bin island_stl_bench -- path/to/model.stl

# TypeScript benchmark (from repo root)
npx tsx scripts/island-stl-bench.ts path/to/model.stl

# Synthetic benchmark
cargo run --release --bin island_bench
```

**Results on `lilith-lilith-part1.stl`** (958K triangles, 1345 layers, 951×478 grid, 8.9% fill):

| | TypeScript | Rust (rayon) | Speedup |
|---|---|---|---|
| Rasterization | 68,904 ms | 1,779 ms | **38.7x** |
| Island scan | 1,516 ms | 392 ms | **3.9x** |
| Total | 70,419 ms | 2,170 ms | **32.4x** |
| Islands found | 93 | 93 | **exact match** |

**Results on `lilith-lilith-leftwing.stl`** (406K triangles, 2030 layers, 659×804 grid, 3.1% fill):

| | TypeScript | Rust (rayon) | Speedup |
|---|---|---|---|
| Rasterization | 35,540 ms | 1,051 ms | **33.8x** |
| Island scan | 1,874 ms | 256 ms | **7.3x** |
| Total | 37,415 ms | 1,307 ms | **28.6x** |
| Islands found | 14 | 14 | **exact match** |

## Tooling Binaries

Run from `rust/dragonfruit-islands/`:

| Binary | Purpose | Usage |
|---|---|---|
| `island_harness` | Run pipeline against golden fixtures | `cargo run --bin island_harness -- --fixture <dir> --stage <rle\|scan\|tracker\|full>` |
| `island_diff` | Semantic comparison of TS vs Rust output | `cargo run --bin island_diff -- --golden <dir> --actual <dir>` |
| `island_bench` | Synthetic speed benchmark | `cargo run --release --bin island_bench` |
| `island_stl_bench` | Real STL file benchmark | `cargo run --release --bin island_stl_bench -- <file.stl>` |

## Tauri IPC Integration

The island scan is exposed to the frontend via a Tauri IPC command. The Tauri app (`src-tauri`) depends on `dragonfruit-islands` directly.

### IPC Flow

```text
Frontend                         Tauri IPC                  Rust Backend
────────                         ─────────                  ────────────
stage_mesh_binary()  ──────►  raw binary body  ──────►  staged_mesh (Mutex)

run_island_scan_native() ──►  { paramsJson }   ──────►  spawn_blocking {
                                                           parse triangles
  ◄─ islandscan://progress ──  window.emit()   ◄──────    rasterize (rayon)
  ◄─ islandscan://progress ──  window.emit()   ◄──────    run_island_scan()
                                                           build ScanResults
  ◄─ NativeIslandScanResult ─  return JSON     ◄──────    serialize
}
```

### Files

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | `run_island_scan_native` IPC command (uses `dragonfruit_islands::*` directly) |
| `src/volumeAnalysis/IslandScan/nativeIslandScan.ts` | TS bridge (`runIslandScanNative()`) |
| `src/volumeAnalysis/IslandScan/useIslandManager.ts` | React hook with `useNativeScan` toggle |

## Design Notes

### GPU acceleration — evaluated and rejected

An experimental GPU path (wgpu compute shaders) was prototyped and removed because CPU+RLE is consistently faster:

1. **RLE algorithmic advantage** — CPU processes only occupied runs (~3K per layer), not the full grid (~530K pixels).
2. **Dense readback overhead** — GPU output must be read back as dense grids (400MB–2.8GB across the memory bus).
3. **Low arithmetic intensity** — Dilation requires 25 reads per pixel.
4. **Sequential cross-layer dependency** — prevents full GPU batching.

### Deterministic rasterization

The rasterizer uses `IndexMap` (not `HashMap`) for polygon loop stitching. This preserves insertion order, matching JavaScript's `Map` iteration semantics. Without this, the same model produces different rasterized masks across runs due to non-deterministic iteration affecting edge-case loop construction at degenerate triangle intersections.

## Dependencies

| Crate | Purpose |
|-------|---------|
| `dragonfruit-slicing-engine` | Geometry types (`Vec3`, `Triangle`, `parse_triangles`) |
| `serde` | Serialization for island types |
| `rayon` | Parallel rasterization |
| `indexmap` | Insertion-order map for deterministic loop stitching |
| `clap` | CLI argument parsing for tooling binaries |
