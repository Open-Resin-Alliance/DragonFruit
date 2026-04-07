# CLI Gaps Implementation Plan

Moldable Development → TDD → DDD approach.
**Rule: NO new logic. Only wrappers to existing functions.**

## Triage

37 gaps identified. THREE.js runs in Node.js (proven by `scene arrange`).
Split into 4 work streams by where the existing code lives.

---

## Stream 1: Rust CLI — STL/3MF Export + Benchmark

### 1A. Move STL Export to Library (refactor, not new code)

**Observe:** `cmd_mesh_export_stl` in `dragonfruit_cli.rs:381-439` has the STL writer inline.
Same binary STL format as `cli::load_binary_stl` reads.

**Model:** Move to `cli.rs` as `pub fn write_binary_stl(path, positions) -> Result<()>`.
Value Object: `BBox` (already exists). No new types needed.

**Test (write first):**
```rust
// cli.rs tests
#[test]
fn stl_write_roundtrip() {
    let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let dir = temp_dir();
    write_binary_stl(&dir.join("rt.stl"), &positions).unwrap();
    let back = load_binary_stl(&dir.join("rt.stl")).unwrap();
    assert_eq!(positions.len(), back.len());
    for (a, b) in positions.iter().zip(back.iter()) {
        assert!((a - b).abs() < 1e-6);
    }
}

proptest! {
    #[test]
    fn stl_roundtrip_prop(positions in proptest::collection::vec(-100.0f32..100.0, 0..90)
        .prop_map(|mut v| { v.truncate(v.len() / 9 * 9); v }))
    {
        if positions.is_empty() { return Ok(()); }
        let dir = temp_dir();
        write_binary_stl(&dir.join("prop.stl"), &positions).unwrap();
        let back = load_binary_stl(&dir.join("prop.stl")).unwrap();
        prop_assert_eq!(positions.len(), back.len());
        for (a, b) in positions.iter().zip(back.iter()) {
            prop_assert!((a - b).abs() < 1e-5);
        }
    }
}
```

**Implement:** Extract the body of `cmd_mesh_export_stl` into `cli::write_binary_stl`. CLI calls the new function.

**Expose:** Already exposed as `mesh export-stl`. No CLI change needed.

### 1B. 3MF Export (New Rust encoder — smallest viable)

**Observe:** No 3MF code exists anywhere in Rust. The GUI imports 3MF via TypeScript
(`loadMeshGeometry` in `useSceneCollectionManager.ts`), but no Rust writer.

3MF is a ZIP containing XML + binary mesh data. Minimal spec:
- `[Content_Types].xml`
- `_rels/.rels`
- `3D/3dmodel.model` (XML with `<mesh>` → `<vertices>` + `<triangles>`)

**Model:** Domain Service `write_3mf(positions: &[f32], path: &Path) -> Result<()>`.
No new types — reuses existing `Vec<f32>` positions format.

**Test (write first):**
```rust
#[test]
fn write_3mf_produces_valid_zip() {
    let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let dir = temp_dir();
    write_3mf(&positions, &dir.join("test.3mf")).unwrap();
    // Verify it's a valid ZIP with expected entries
    let file = std::fs::File::open(&dir.join("test.3mf")).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    assert!(zip.by_name("[Content_Types].xml").is_ok());
    assert!(zip.by_name("3D/3dmodel.model").is_ok());
}

#[test]
fn write_3mf_contains_correct_vertex_count() {
    let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                         0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let dir = temp_dir();
    write_3mf(&positions, &dir.join("test2.3mf")).unwrap();
    let file = std::fs::File::open(&dir.join("test2.3mf")).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut model = String::new();
    zip.by_name("3D/3dmodel.model").unwrap().read_to_string(&mut model).unwrap();
    // 6 vertices (2 triangles × 3 verts), 2 triangles
    assert!(model.contains("<vertex x="));
    assert!(model.contains("<triangle v1="));
}
```

**Implement:** `cli::write_3mf` using the existing `zip` crate (already a dependency).

**Expose:** Add `mesh export-3mf -i <dir> -o <out.3mf>` CLI command.

### 1C. Benchmark CLI Command

**Observe:** `benchmark::run_benchmark_v3(cfg)` exists in `benchmark.rs:118`.
Takes `BenchmarkConfigV3`, returns `BenchmarkResultV3`.

**Test:** Not needed for wrapper — the benchmark module has its own tests.

**Implement:** Add `benchmark` subcommand to CLI that constructs `BenchmarkConfigV3`
from flags and calls `run_benchmark_v3`.

**Expose:**
```
dragonfruit-cli benchmark [--cube-count N] [--width-px W] [--height-px H] [--layers L] [--json]
```

---

## Stream 2: TS CLI — Support Mutations (wrap state.ts directly)

THREE.js works in Node.js. Import `supports/state.ts` functions directly.

### 2A. Support Updates

**Observe:** `state.ts` exports `updateTrunk(trunk)`, `updateBranch(branch)`, etc.
These mutate the in-memory state singleton. For CLI, we need to:
1. Load VOXL → hydrate state via `loadFromLychee`
2. Call the update function
3. Export state → save back to VOXL

**Model:** The CLI operates at VOXL file level. We need a bridge pattern:
```
load VOXL → loadFromLychee(supports) → mutation → getSnapshot() → save VOXL
```

But `loadFromLychee` does geometry normalization with THREE.js. For pure data updates
(changing a trunk's diameter, a knot's position), we can operate directly on the
`DragonfruitImportFormat` JSON inside the VOXL — no state.ts needed.

**Decision:** For simple field updates (diameter, position, etc.), operate on VOXL JSON
directly. Same as current `add-*` commands. No state.ts import needed.

**Test (in pipeline — run CLI and verify JSON output):**
```bash
# Add trunk, then update its diameter
npx tsx scripts/dragonfruit-ts-cli.ts support add-trunk scene.voxl --model-id m1 --position 5,0,0 --diameter 2 --json
npx tsx scripts/dragonfruit-ts-cli.ts support update scene.voxl --id <trunk-id> --diameter 3.5 --json
npx tsx scripts/dragonfruit-ts-cli.ts support list scene.voxl --json | jq '.supports.trunks[0].segments[0].diameter'
# should be 3.5
```

**Implement:** Add `support update` command that finds element by ID across all
collections (roots, trunks, branches, leaves, braces, knots) and patches fields.

**Expose:**
```
support update <voxl> --id <id> [--diameter N] [--position x,y,z] [--tip-diameter N] [--json]
```

### 2B. Cascading Removes (already partially done)

**Observe:** Current `support remove` does cascading for roots → trunks → knots → branches.
But it doesn't cascade trunk removal to knots → branches → leaves → braces (the full cascade
in `state.ts::removeTrunk`).

**Test:**
```bash
# Add trunk + knot + branch + leaf, then remove trunk — all should cascade
npx tsx scripts/dragonfruit-ts-cli.ts support add-trunk scene.voxl ...
npx tsx scripts/dragonfruit-ts-cli.ts support add-knot scene.voxl ...
npx tsx scripts/dragonfruit-ts-cli.ts support add-branch scene.voxl ...
npx tsx scripts/dragonfruit-ts-cli.ts support add-leaf scene.voxl ...
npx tsx scripts/dragonfruit-ts-cli.ts support remove scene.voxl --id <trunk-id>
npx tsx scripts/dragonfruit-ts-cli.ts support list scene.voxl --json
# all 0
```

**Implement:** Fix cascade in existing `supportRemove` to handle trunk removal properly
(currently misses leaves attached to knots that are attached to branches).

### 2C. Kickstand Operations

**Observe:** `kickstandStore.ts` exports `addKickstand(build: KickstandBuildResult)`,
`removeKickstand(id)`, `updateKickstand(build)`. These are **pure data operations** — no THREE.js.

The `KickstandBuildResult` type has: `{ root, hostKnot, kickstand }`.
Kickstands are stored in `DragonfruitImportFormat.kickstands[]`.

**Test:**
```bash
npx tsx scripts/dragonfruit-ts-cli.ts support add-kickstand scene.voxl \
  --model-id m1 --base 5,5 --contact 10,10,20 --diameter 1.5 --json
npx tsx scripts/dragonfruit-ts-cli.ts support list scene.voxl --json | jq '.kickstands'
```

**Implement:** Add `support add-kickstand` command. Construct `KickstandBuildResult`-shaped
JSON and append to `doc.supports.kickstands[]`.

**Expose:**
```
support add-kickstand <voxl> --model-id <id> --base x,y --contact x,y,z [--diameter 1.5] [--json]
support remove-kickstand <voxl> --id <id> [--json]
```

### 2D. Toggle Segment Curve

**Observe:** `state.ts::toggleSegmentCurve(segmentId)` converts straight ↔ bezier.
Uses `calculateBezierControlPoints` (THREE.js).

For CLI: operate on VOXL JSON directly. A straight segment has no `type` or `type: 'straight'`.
A bezier segment has `type: 'bezier'` + control points. Toggle = change the type field.

For straight→bezier: need control points. Can't compute without THREE.js geometry context.
For bezier→straight: just remove the bezier fields.

**Decision:** Support `bezier-to-straight` only in CLI (removes curve data).
`straight-to-bezier` requires geometry context → GUI only.

**Expose:**
```
support straighten-segment <voxl> --id <segment-id> [--json]
```

---

## Stream 3: TS CLI — Scene Operations (wrap VOXL directly)

### 3A. Group / Ungroup

**Observe:** `useSceneCollectionManager.ts:1879` has `groupModels(modelIds, groupName)`.
It sets `groupId` and `groupName` on each model's `LoadedModel` record. Pure state.

In VOXL: models don't have an explicit group field in the spec. But the CLI can use
the `extensions` field on `VoxlDocumentV1` to store groups, or add groupId to model entries.

**Decision:** Since VOXL `VoxlModelEntry` doesn't have `groupId`, store groups in
`doc.extensions.groups` as `{ id, name, modelIds }[]`. The GUI doesn't read this
(it manages groups in React state), but it's preserved in the file for CLI round-trips.

**Test:**
```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene group scene.voxl --ids id1,id2 --name "Assembly" --json
npx tsx scripts/dragonfruit-ts-cli.ts scene list-groups scene.voxl --json
npx tsx scripts/dragonfruit-ts-cli.ts scene ungroup scene.voxl --group-id g1 --json
```

**Expose:**
```
scene group <voxl> --ids <id1,id2,...> [--name "Group"] [--json]
scene ungroup <voxl> --group-id <id> [--json]
scene list-groups <voxl> [--json]
```

### 3B. Center XY

**Observe:** `useModelTransform.ts:82` — `centerXY` sets position X=0, Y=0, preserves Z.

For CLI: set `model.transform.position.x = 0`, `model.transform.position.y = 0`.

**Test:**
```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene transform-model scene.voxl --id m1 --position 50,30,10
npx tsx scripts/dragonfruit-ts-cli.ts scene center-xy scene.voxl --id m1 --json
# position should be (0, 0, 10)
```

**Expose:**
```
scene center-xy <voxl> --id <model-id> [--json]
```

### 3C. LYS Import

**Observe:** `useLysImport.ts` handles `.lys` file parsing. It's a Lychee slicer format
with embedded mesh data + support state. The import pipeline:
1. Parse LYS JSON
2. Extract mesh geometry
3. Build `DragonfruitImportFormat` for supports
4. Load into scene

The LYS parser is in TypeScript and uses THREE.js for geometry construction.
For CLI: parse LYS → extract to VOXL (same interchange format).

**Decision:** Import `useLysImport` logic. THREE.js works in Node.

**Test:**
```bash
npx tsx scripts/dragonfruit-ts-cli.ts scene import-lys input.lys --o scene.voxl --json
npx tsx scripts/dragonfruit-ts-cli.ts scene list-models scene.voxl --json
```

**Expose:**
```
scene import-lys <input.lys> --o <output.voxl> [--json]
```

---

## Stream 4: Rust — 3MF Writer

### 4A. Minimal 3MF Writer

**Observe:** No existing code. Must implement from scratch.
3MF Core Spec: ZIP with XML model file. Minimal structure:

```
[Content_Types].xml
_rels/.rels
3D/3dmodel.model   ← XML with <mesh><vertices/><triangles/></mesh>
```

**Model:** Domain Service in `cli.rs`:
```rust
pub fn write_3mf(positions: &[f32], path: &Path) -> Result<(), String>
```

**Test (write first):**
```rust
#[test]
fn write_3mf_roundtrip_structure() { ... }

#[test]
fn write_3mf_rejects_non_multiple_of_9() {
    let result = write_3mf(&[1.0, 2.0], &PathBuf::from("/tmp/bad.3mf"));
    assert!(result.is_err());
}

proptest! {
    #[test]
    fn write_3mf_vertex_count_matches(positions in proptest::collection::vec(-100.0f32..100.0, 0..90)
        .prop_map(|mut v| { v.truncate(v.len() / 9 * 9); v }))
    {
        if positions.is_empty() { return Ok(()); }
        let dir = temp_dir();
        write_3mf(&positions, &dir.join("prop.3mf")).unwrap();
        // Verify ZIP is valid and triangle count matches
        let file = std::fs::File::open(&dir.join("prop.3mf")).unwrap();
        let zip = zip::ZipArchive::new(file).unwrap();
        prop_assert!(zip.len() >= 3); // Content_Types, rels, model
    }
}
```

**Implement:** Write XML using string formatting (no XML crate needed for this minimal output).
Uses existing `zip` crate dependency.

**Expose:**
```
dragonfruit-cli mesh export-3mf -i <dir> -o <output.3mf>
```

---

## Implementation Order

| Phase | Stream | Task | Effort | Tests |
|-------|--------|------|--------|-------|
| 1 | 1A | Extract `write_binary_stl` to `cli.rs` | S | 2 (unit + prop) |
| 2 | 1C | Add `benchmark` CLI command | S | 0 (existing) |
| 3 | 2A | Add `support update` command | S | Pipeline test |
| 4 | 2B | Fix cascading removes | S | Pipeline test |
| 5 | 2C | Add kickstand commands | S | Pipeline test |
| 6 | 3A | Add group/ungroup commands | S | Pipeline test |
| 7 | 3B | Add `scene center-xy` | XS | Pipeline test |
| 8 | 2D | Add `support straighten-segment` | S | Pipeline test |
| 9 | 4A | Write minimal 3MF writer | M | 3 (unit + prop + structure) |
| 10 | 1A | Add `mesh export-3mf` CLI command | S | Pipeline test |
| 11 | 3C | Add `scene import-lys` | M | Pipeline test |

**Total: 11 tasks, ~37 gaps closed.**

## Verification

After each phase, run:
```bash
cargo nextest run                                    # Rust tests
npx tsx scripts/dragonfruit-ts-cli.ts --help          # TS CLI still works
# Pipeline smoke test:
npx tsx scripts/dragonfruit-ts-cli.ts scene create --o /tmp/test.voxl
npx tsx scripts/dragonfruit-ts-cli.ts scene add-model /tmp/test.voxl --mesh model.stl --name Test
npx tsx scripts/dragonfruit-ts-cli.ts scene arrange /tmp/test.voxl --mesh-dir .
npx tsx scripts/dragonfruit-ts-cli.ts scene slice /tmp/test.voxl --o /tmp/test.nanodlp --mesh-dir .
```

After all phases, update `docs/CLI.md` coverage table — target: **91/118 (77%)** covered
(up from 54/118 = 46%).
