# DragonFruit CLI Reference

Two CLI tools expose the full DragonFruit pipeline for headless / LLM-agent use.
Every command produces JSON output (`--json`) and reports timing metrics.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  dragonfruit-cli (Rust)                                     │
│  Wraps existing Rust backend — same code as Tauri IPC       │
│                                                             │
│  mesh ──── read-stl, info, export-stl                       │
│  island ── rasterize, scan, track, analyze, full, bench     │
│  slice ─── run, preview-layer, info                         │
│  print ─── save, read-bytes, read-layer, cleanup            │
│  info                                                       │
└─────────────────────────────────────────────────────────────┘
        ▲ positions.bin / .nanodlp
        │
┌─────────────────────────────────────────────────────────────┐
│  dragonfruit-ts-cli (TypeScript / tsx)                       │
│  Wraps existing TS modules — same code as GUI               │
│                                                             │
│  scene ─── create, add-model, remove-model, list-models,    │
│            transform-model, duplicate, arrange, slice, load  │
│  support ─ add-trunk, add-branch, add-leaf, add-brace,      │
│            add-knot, remove, list                            │
└─────────────────────────────────────────────────────────────┘
```

**Shared file formats** — both CLIs and the GUI operate on the same data:
- `.voxl` — scene + support state (VOXL V1 JSON, optional zlib compression)
- `positions.bin` — flat `f32` triangle vertices `[x,y,z,...]`
- `.nanodlp` — sliced layer archive (ZIP of PNGs)

---

## Rust CLI — `dragonfruit-cli`

Binary: `rust/dragonfruit-slicer-v3/target/release/dragonfruit-cli`

Build: `cargo build --release` (from `rust/dragonfruit-slicer-v3/`)

Every command prints `[command] Xms` timing to stderr.

### `mesh` — Mesh I/O

| Command | Description | Wraps |
|---------|-------------|-------|
| `mesh read-stl <input.stl> -o <dir>` | Parse binary STL → `positions.bin` + `mesh-info.json` | `cli::load_binary_stl` |
| `mesh info <dir-or-stl> [--json]` | Print triangles, bbox, volume | `geometry::parse_triangles` + `cli::compute_bbox` |
| `mesh export-stl -i <dir> -o <out.stl>` | Write `positions.bin` back to binary STL | `cli::read_positions_bin` |

**Example:**
```bash
dragonfruit-cli mesh read-stl model.stl -o /tmp/mesh
# read-stl: 957808 triangles, bbox (-23.77,-11.94,0.00)-(23.77,11.94,67.21)
#   [mesh read-stl] 165.7ms

dragonfruit-cli mesh info /tmp/mesh --json
# { "triangles": 957808, "volume_mm3": 6838.85, ... }
#   [mesh info] 100.5ms
```

### `island` — Island Detection Pipeline

| Command | Description | Wraps |
|---------|-------------|-------|
| `island rasterize -i <dir> -o <dir>` | Triangles → per-layer RLE masks | `islands::rasterize::rasterize_for_island_scan` |
| `island scan -i <dir> -o <dir>` | Support subtraction + CCL | `islands::scan::scan_layer` |
| `island track -i <dir> -o <dir>` | Cross-layer island tracking | `islands::tracker::IslandTracker` |
| `island analyze -i <dir> -o <dir>` | Volume calculation + filtering | Island volume aggregation |
| `island full <input.stl> -o <dir> [--json]` | All stages in one pass | Full pipeline |
| `island bench <input.stl> [--iterations N] [--json]` | Timing breakdown | Benchmarking harness |

**Key flags** (apply to `full`, `bench`, and individual stages):
- `--px-mm 0.1` — raster pixel size
- `--layer-height 0.05` — slice step (mm)
- `--buffer 0.6` — support buffer (mm)
- `--connectivity 4` — CCL connectivity (4 or 8)
- `--overlap 4` — island tracking overlap threshold (px)
- `--min-area 0.0` — filter islands below this area (mm²)
- `--params-json <file>` — load params from JSON (CLI flags override)

**Example:**
```bash
dragonfruit-cli island full model.stl -o /tmp/islands --json
# { "triangles": 957808, "islands_total": 42, "islands_filtered": 15,
#   "raster_ms": 890, "scan_ms": 450, "total_ms": 1340, ... }
#   [island full] 1892.3ms
```

### `slice` — Slicing Pipeline

| Command | Description | Wraps |
|---------|-------------|-------|
| `slice run <input> -o <out.nanodlp> [--json]` | Full slice → archive | `engine::slice_with_progress_v3_to_path` |
| `slice preview-layer <archive> --layer N -o <out.png>` | Extract layer PNG | Same as Tauri `read_print_layer_png` |
| `slice info` | List formats + defaults | `encoders::registry::supported_output_formats` |

**Input:** STL file or `positions.bin` (from `mesh read-stl` or `scene slice` merge).

**Key flags for `slice run`:**
- `--layer-height 0.05` — layer step (mm)
- `--build-width-mm 218.0` — build plate width
- `--build-depth-mm 122.0` — build plate depth
- `--source-width-px 11400` — raster resolution X
- `--source-height-px 6400` — raster resolution Y
- `--png-compression balanced` — fastest / balanced / smallest / optimal
- `--anti-aliasing Off` — Off / 2x / 4x / 8x
- `--mirror-x`, `--mirror-y` — mirror axes
- `--metadata-json '{}'` — opaque metadata passthrough

**Example:**
```bash
dragonfruit-cli slice run model.stl -o /tmp/out.nanodlp --json
# { "layers": 1345, "total_s": 39.7, "layers_per_second": 33.9,
#   "perf": { "index_build_ns": 43894216, "render_wall_ns": 39055515810, ... } }
#   [slice run] 39751.5ms

dragonfruit-cli slice preview-layer /tmp/out.nanodlp --layer 500 -o /tmp/layer500.png
#   [slice preview-layer] 24.4ms
```

### `print` — Print File Operations

| Command | Description | Wraps |
|---------|-------------|-------|
| `print save <input> -o <output>` | Copy archive to destination | Tauri `save_print_file_from_path` |
| `print read-bytes <input> -o <output>` | Raw binary read | Tauri `read_print_file_bytes` |
| `print read-layer <archive> --layer N -o <out.png>` | Extract layer PNG | Tauri `read_print_layer_png` |
| `print cleanup [--path P] [--all] [--max-age-seconds N]` | Clean temp files | Tauri `delete_print_temp_file` / `cleanup_*` |

**Safety:** `print cleanup --path` refuses to delete non-DragonFruit temp artifacts (same guard as Tauri `is_dragonfruit_temp_artifact`).

### `info`

```bash
dragonfruit-cli info
# { "name": "dragonfruit-cli", "supported_formats": [".nanodlp"],
#   "commands": ["mesh","island","slice","print","info"], ... }
```

---

## TypeScript CLI — `dragonfruit-ts-cli`

Run: `npx tsx scripts/dragonfruit-ts-cli.ts <command> <subcommand> [args]`

Operates on `.voxl` files — the same scene format the GUI saves/loads.
Every command injects `_perf: { command, elapsed_ms }` into JSON output
and prints `[command] Xms` to stderr.

### `scene` — Scene Management

| Command | Description | Wraps |
|---------|-------------|-------|
| `scene create --o <scene.voxl>` | Create empty scene | `voxl/codec::buildVoxlDocumentV1` |
| `scene add-model <voxl> --mesh <stl> [--name N] [--position x,y,z]` | Add model | VOXL model entry |
| `scene remove-model <voxl> --id <id>` | Remove model (cascades supports) | VOXL mutation |
| `scene list-models <voxl> [--json]` | List models with transforms | VOXL read |
| `scene transform-model <voxl> --id <id> [--position x,y,z] [--rotate x,y,z] [--scale x,y,z]` | Set transform | VOXL mutation |
| `scene duplicate <voxl> --id <id> [--count N] [--offset x,y,z]` | Duplicate model | VOXL mutation |
| `scene arrange <voxl> --mesh-dir <dir> [--spacing 2] [--build-width-mm 218] [--build-depth-mm 122] [--anchor center]` | Auto-arrange on plate | `highPrecisionArrange` (SAT nesting) |
| `scene slice <voxl> --o <out.nanodlp> --mesh-dir <dir> [--layer-height 0.05] [--build-width-mm 218]` | Merge + slice via Rust | Loads STLs → applies transforms → `dragonfruit-cli slice run` |
| `scene load <voxl> [--json]` | Dump full scene | `voxl/codec::parseVoxlDocument` |

**Arrange wraps the same algorithm as the GUI** (`src/features/scene/arrange/highPrecisionArrange.ts`):
- 2.5D SAT nesting with convex hull footprints
- Multi-order constructive search with fit-rate rescue
- Post-pack compaction + anchor alignment

**Anchor modes:** `center`, `front_left`, `front_right`, `back_left`, `back_right`

### `support` — Support Management

| Command | Description |
|---------|-------------|
| `support add-trunk <voxl> --model-id <id> --position x,y,z [--diameter 2.0]` | Add trunk + root |
| `support add-branch <voxl> --model-id <id> --parent-knot-id <id> [--diameter 1.0]` | Add branch |
| `support add-leaf <voxl> --model-id <id> --parent-knot-id <id> --contact x,y,z [--normal x,y,z]` | Add leaf contact |
| `support add-brace <voxl> --model-id <id> --start-knot <id> --end-knot <id> [--diameter 0.5]` | Add brace |
| `support add-knot <voxl> --parent-shaft-id <id> --position x,y,z [--t 0.5]` | Add knot on shaft |
| `support remove <voxl> --id <id>` | Remove element (cascading) |
| `support list <voxl> [--json]` | List all supports |

**Support types match the GUI's `DragonfruitImportFormat`** (`src/supports/types.ts`):
- Roots, Trunks, Branches, Leaves, Braces, Knots, Kickstands
- Removing a root cascades to its trunk → knots → branches/braces

---

## End-to-End Pipeline Example

```bash
# 1. Create scene
npx tsx scripts/dragonfruit-ts-cli.ts scene create --o scene.voxl

# 2. Add model
npx tsx scripts/dragonfruit-ts-cli.ts scene add-model scene.voxl \
  --mesh model.stl --name "Part"

# 3. Duplicate
MODEL_ID=$(npx tsx scripts/dragonfruit-ts-cli.ts scene list-models scene.voxl --json \
  | jq -r '.models[0].id')
npx tsx scripts/dragonfruit-ts-cli.ts scene duplicate scene.voxl \
  --id "$MODEL_ID" --count 2 --offset 0,0,0

# 4. Arrange (SAT nesting — same algo as GUI)
npx tsx scripts/dragonfruit-ts-cli.ts scene arrange scene.voxl \
  --mesh-dir . --spacing 5 --build-width-mm 218 --build-depth-mm 122

# 5. Slice (TS merges scene → Rust slices)
npx tsx scripts/dragonfruit-ts-cli.ts scene slice scene.voxl \
  --o sliced.nanodlp --mesh-dir . --json

# 6. Extract layer preview
dragonfruit-cli slice preview-layer sliced.nanodlp --layer 500 -o preview.png

# 7. Island scan (independent of scene — operates on STL directly)
dragonfruit-cli island full model.stl -o /tmp/islands --json

# 8. Save to final print file
dragonfruit-cli print save sliced.nanodlp -o final.nanodlp
```

### Pipeline Timing (957K triangle model × 3 copies, 218×122mm plate)

| Step | Command | Time |
|------|---------|------|
| Create scene | `scene create` | 5ms |
| Add model | `scene add-model` | 5ms |
| Duplicate ×2 | `scene duplicate` | 6ms |
| Arrange (SAT) | `scene arrange` | 505ms |
| Slice (merge + Rust engine) | `scene slice` | 45,141ms |
| &nbsp;&nbsp;└ Rust slice engine | `slice run` | 43,631ms |
| &nbsp;&nbsp;&nbsp;&nbsp;└ index build | | 99ms |
| &nbsp;&nbsp;&nbsp;&nbsp;└ render (wall) | | 42,696ms |
| &nbsp;&nbsp;&nbsp;&nbsp;└ archive encode | | 451ms |
| Extract layer | `slice preview-layer` | 24ms |

---

## Performance Metrics

### Rust CLI

Every command prints `[command] Xms` to stderr.

`slice run --json` includes detailed engine perf:
```json
{
  "total_s": 43.35,
  "layers_per_second": 31.0,
  "perf": {
    "total_ns": 43352094093,
    "index_build_ns": 99444275,
    "render_wall_ns": 42696194233,
    "render_ns": 160167975799,
    "png_encode_ns": 509564718513,
    "archive_encode_ns": 450898940
  }
}
```

`island full --json` includes rasterize/scan breakdown:
```json
{
  "raster_ms": 890.0,
  "scan_ms": 450.0,
  "total_ms": 1340.0
}
```

`island bench --json` reports best-of-N with throughput:
```json
{
  "best_ms": { "read_stl": 42, "rasterize": 890, "scan": 300, "track": 120, "analyze": 1, "total": 1353 },
  "throughput": { "layers_per_sec": 994, "mpx_per_sec": 12.5 }
}
```

### TypeScript CLI

Every command injects `_perf` into JSON output:
```json
{
  "arranged": [...],
  "_perf": {
    "command": "scene arrange",
    "elapsed_ms": 504.95
  }
}
```

Non-JSON mode prints `[command] Xms` to stderr.

---

## Backend Coverage

| Tauri IPC Command | CLI Equivalent |
|---|---|
| `slice_solid_native` | `slice run` (to stdout via `--json`) |
| `slice_solid_native_to_temp_path` | `slice run -o <path>` |
| `stage_mesh_binary` | implicit (CLI reads STL/positions.bin directly) |
| `cancel_slicing` | N/A (CLI runs to completion) |
| `run_island_scan_native` | `island full` |
| `save_print_file` / `save_print_file_from_path` | `print save` |
| `write_bytes_to_path` | `print save` |
| `read_print_file_bytes` | `print read-bytes` |
| `read_print_layer_png` | `print read-layer` / `slice preview-layer` |
| `delete_print_temp_file` | `print cleanup --path` |
| `cleanup_stale_print_temp_files` | `print cleanup --max-age-seconds` |
| `cleanup_all_print_temp_files` | `print cleanup --all` |
| `pick_open_files` / `pick_save_path` | N/A (CLI uses paths directly) |
| `focus_main_window_command` | N/A (no GUI) |
| Scene state (React) | `scene *` (via VOXL files) |
| Support state (`supports/state.ts`) | `support *` (via VOXL files) |
| Arrange (`highPrecisionArrange.ts`) | `scene arrange` (same algorithm) |
| `plugin_network_request` | Not covered (plugin dispatch) |

---

## Full Coverage Audit

Comprehensive audit of every data-producing operation across Rust, Tauri IPC, and TypeScript.

### Tauri IPC Commands (19 total)

| # | Command | Status | CLI Equivalent | Notes |
|---|---------|--------|----------------|-------|
| 1 | `slice_solid_native` | COVERED | `slice run --json` | Returns archive bytes |
| 2 | `stage_mesh_binary` | IMPLICIT | CLI reads files directly | Binary IPC staging |
| 3 | `slice_solid_native_to_temp_path` | COVERED | `slice run -o <path>` | Two-phase slice |
| 4 | `cancel_slicing` | N/A | — | CLI runs to completion |
| 5 | `run_island_scan_native` | COVERED | `island full` | Full pipeline |
| 6 | `save_print_file` | COVERED | `print save` | CLI uses path, no dialog |
| 7 | `save_print_file_from_path` | COVERED | `print save` | Direct path copy |
| 8 | `pick_save_path` | N/A | — | GUI dialog only |
| 9 | `write_bytes_to_path` | COVERED | `print save` | Byte write |
| 10 | `pick_open_files` | N/A | — | GUI dialog only |
| 11 | `get_launch_scene_files` | N/A | — | App launch only |
| 12 | `notify_launch_scene_handoff` | N/A | — | App launch only |
| 13 | `focus_main_window_command` | N/A | — | GUI window only |
| 14 | `read_print_file_bytes` | COVERED | `print read-bytes` | Raw file read |
| 15 | `read_print_layer_png` | COVERED | `print read-layer` | ZIP layer extract |
| 16 | `delete_print_temp_file` | COVERED | `print cleanup --path` | Safe delete |
| 17 | `cleanup_stale_print_temp_files` | COVERED | `print cleanup --max-age-seconds` | Age sweep |
| 18 | `cleanup_all_print_temp_files` | COVERED | `print cleanup --all` | Full sweep |
| 19 | `plugin_network_request` | GAP | — | Plugin HTTP dispatch |

**Summary:** 12/19 covered, 5 N/A (GUI-only), 1 implicit, 1 gap (plugin dispatch).

### Rust Public API (dragonfruit-slicer-v3)

| Module | Public Functions | Used in CLI | Not in CLI |
|--------|-----------------|-------------|------------|
| `engine` | `slice_with_progress_v3`, `slice_with_progress_v3_to_path`, `slice_and_rasterize_v3`, `dispatch_encode_by_format`, `dispatch_encode_by_format_to_path` | `slice_with_progress_v3_to_path` | `slice_and_rasterize_v3` (internal), `dispatch_encode_*` (internal) |
| `cli` | `load_binary_stl`, `write_positions_bin`, `read_positions_bin`, `compute_bbox`, `write_json`, `read_json`, `write_rle_mask_json`, `read_rle_mask_json`, `write_rle_labels_json`, `read_rle_labels_json`, `ensure_dir` | All 11 | — |
| `geometry` | `parse_triangles` | Yes | — |
| `islands::rasterize` | `rasterize_for_island_scan` | Yes | — |
| `islands::scan` | `scan_layer` | Yes | — |
| `islands::tracker` | `IslandTracker::new`, `process_layer`, `get_islands`, `finalize_islands` | All 4 | — |
| `islands::rle` | `rle_encode`, `rle_decode`, `rle_encode_labels`, `rle_decode_labels`, `rle_intersect_dilated`, `rle_subtract`, `rle_label_components` | `rle_label_components` (via scan) | 6 individual ops |
| `islands::pipeline` | `run_island_scan` | Yes (island full) | — |
| `encoders::registry` | `find_encoder`, `supported_output_formats` | Both | — |
| `raster` | `rasterize_layer`, `rasterize_layer_with_stats` | Via pipeline | Not direct |
| `pipeline` | `render_layers_bounded` | Via engine | Not direct |
| `encode` | `encode_grayscale_png` | Via pipeline | Not direct |
| `index` | `build_layer_index` | Via engine | Not direct |
| `benchmark` | `run_benchmark_v3` | **GAP** | Synthetic benchmark |
| `metrics` | `SlicingPerfV3::total_s`, `layers_per_second` | Yes | — |

**Gaps:**
- `benchmark::run_benchmark_v3` — synthetic slicer benchmark, useful for CI/perf monitoring
- Individual `rle_*` operations — useful for debugging island pipeline stages

### TypeScript Support State (`supports/state.ts` — 60+ exports)

| Operation Type | Total | CLI Covered | Could Cover | Cannot Cover |
|----------------|-------|-------------|-------------|--------------|
| **Add** (addRoot, addTrunk, addBranch, addLeaf, addBrace, addTwig, addStick, addKnot) | 8 | 5 (trunk+root, branch, leaf, brace, knot) | 3 (twig, stick, root standalone) | 0 |
| **Update** (updateTrunk, updateBranch, updateLeaf, updateBrace, updateTwig, updateStick, updateKnot) | 7 | 0 | 7 (pure state) | 0 |
| **Remove** (removeTrunk, removeBranch, removeLeaf, removeBrace, removeTwig, removeStick, removeKnotById, removeRootById, removeJoint, removeBranchJoint, removeJointById, removeKickstandCascade) | 12 | 1 (generic remove) | 11 (pure state) | 0 |
| **Transform** (transformSupportsForModel, transformAllSupportsForSingleModel) | 2 | 0 | 0 | 2 (THREE.js matrix) |
| **Toggle** (toggleSegmentCurve) | 1 | 0 | 1 (pure logic) | 0 |
| **State** (setSnapshot, resetStore, loadFromLychee, mergeFromLychee) | 4 | 1 (load via VOXL) | 3 | 0 |
| **Selection** (setSelectedId, setHoveredId, setHoveredCategory, setInteractionWarning) | 4 | 0 | 0 | 4 (UI state) |
| **Read** (getSnapshot, getRoots, getTrunks, getBranches, etc.) | 20+ | All (via JSON) | — | — |

**Summary:** 38 mutating operations. 5 covered, 25 extractable, 6 GUI-only, 2 THREE.js-only.

### TypeScript Scene Operations (`useSceneCollectionManager.ts`)

| Operation | CLI Coverage | Notes |
|-----------|-------------|-------|
| Add model | COVERED | `scene add-model` |
| Remove model | COVERED | `scene remove-model` |
| Duplicate model | COVERED | `scene duplicate` |
| Transform model | COVERED | `scene transform-model` |
| Arrange models | COVERED | `scene arrange` (same SAT algo) |
| Load from VOXL | COVERED | `scene load` |
| Save to VOXL | COVERED | `scene create` / all mutations auto-save |
| Load from LYS | GAP | LYS → VOXL conversion |
| Export to STL | GAP | Requires THREE.js STLExporter |
| Export to 3MF | GAP | Requires THREE.js + XML builder |
| Group models | GAP | Pure logic, not wired |
| Ungroup models | GAP | Pure logic, not wired |
| Center XY | GAP | Pure arithmetic on transform |
| Place on platform | GAP | Requires geometry bbox |
| Auto-lift Z | GAP | Requires geometry bbox |

### TypeScript Kickstand State (`kickstandStore.ts`)

| Operation | CLI Coverage | Extractable |
|-----------|-------------|-------------|
| `addKickstand` | GAP | Yes (pure logic) |
| `updateKickstand` | GAP | Yes (pure logic) |
| `removeKickstand` | GAP | Yes (pure logic) |
| `reassignAllKickstandModelIds` | GAP | Yes (pure logic) |
| `transformKickstandsForModel` | N/A | No (THREE.js matrix) |
| `transformAllKickstands` | N/A | No (THREE.js matrix) |

### TypeScript Export Operations

| Operation | CLI Coverage | Extractable |
|-----------|-------------|-------------|
| VOXL export | COVERED | Yes (codec.ts) |
| STL export | GAP | No (THREE.js STLExporter) |
| 3MF export | GAP | No (THREE.js + XML) |
| Raster layer ZIP | GAP | No (THREE.js geometry) |
| Slice export orchestration | COVERED | Via `scene slice` → Rust slicer |

---

## Coverage Summary

### By Category

| Category | Total Ops | Covered | Gaps (Extractable) | N/A (GUI-only) |
|----------|-----------|---------|--------------------|-----------------|
| Tauri IPC | 19 | 12 | 1 (plugin dispatch) | 6 |
| Rust public API | 35 | 28 | 2 (benchmark, RLE ops) | 5 (internal) |
| TS support state | 38 | 5 | 25 | 8 |
| TS scene ops | 15 | 7 | 5 | 3 |
| TS kickstand | 6 | 0 | 4 | 2 |
| TS export | 5 | 2 | 0 | 3 |
| **Total** | **118** | **54 (46%)** | **37 (31%)** | **27 (23%)** |

### Gaps Worth Closing

**High value (enables new LLM agent workflows):**

1. **`support update-*`** — update existing trunks/branches/leaves/braces (7 operations, pure state)
2. **`support add-twig`** / **`support add-stick`** — twig and stick support types (2 operations)
3. **`scene group`** / **`scene ungroup`** — model grouping (2 operations, pure logic)
4. **`scene center-xy`** — center model on plate (1 operation, arithmetic on transform)
5. **`scene import-lys`** — LYS → VOXL conversion (1 operation, pure logic)
6. **`benchmark run`** — Rust synthetic benchmark (1 operation, `benchmark::run_benchmark_v3`)

**Lower priority (niche use cases):**

7. **`island rle-*`** — expose individual RLE operations for debugging
8. **`plugin network-request`** — dispatch plugin HTTP from CLI
9. **`support add-kickstand`** — kickstand placement (pure logic portion)

### Not Extractable (GUI-only, by design)

These operations require THREE.js geometry in memory and cannot run headlessly:

- `transformSupportsForModel` / `transformAllSupportsForSingleModel` — 3D matrix transforms on support geometry
- STL/3MF export — THREE.js `STLExporter` / `ThreeMFExporter`
- Raster layer ZIP — JavaScript rasterization with THREE.js geometry
- Auto-lift / place-on-platform — requires geometry bounding box computation
- File dialogs — `pick_open_files`, `pick_save_path`
