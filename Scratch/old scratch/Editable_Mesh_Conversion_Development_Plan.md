# Editable Mesh Conversion (Welded + Indexed) Development Plan

## Reader context (assume you are new)
This project currently loads STL files into Three.js `BufferGeometry`. STLs frequently behave like “triangle soup” where vertices are duplicated per face and there is no practical topology for fast editing.

We are adding mesh editing tools (starting with a smoothing brush). The current smoothing implementation works but can be slow and does not support “add polygons while smoothing” (dynamic detail) in a practical way.

This plan proposes a safe architecture upgrade: create an **editable mesh representation** (welded + indexed) while preserving all existing analysis features (island scans, layer slider overlays, voxel visualization, etc.) by maintaining a **dual representation**.

## What problem this solves
- **Performance:** editing is dramatically faster on welded/indexed meshes vs STL triangle soup.
- **Quality:** dynamic detail (adding polygons) becomes feasible.
- **Future tools:** planar cuts, hole cutting, hollowing, etc. become more reliable with real connectivity.

## What can go wrong (and why this plan is strict)
If we switch the app’s “one true geometry” to indexed without accommodations, several subsystems will break because they assume triangles are laid out as consecutive triplets in the position buffer.

Therefore, this plan emphasizes:
- Feature flag rollout
- Dual representation
- Explicit sync rules and staleness prevention
- A validation matrix that must pass before enabling by default

## Glossary
- **Triangle soup / non-indexed geometry:** triangles are stored as sequential vertex triples. `position.count / 3` is the face count.
- **Indexed geometry:** triangles reference a shared vertex list via an index buffer (`geometry.getIndex()`). `index.count / 3` is the face count.
- **Welded geometry:** duplicate vertices are merged so neighbors really share vertices.
- **Editable geometry:** the canonical mesh used for edits (welded + indexed).
- **Analysis geometry view:** a derived triangle-soup view used by code that assumes non-indexed triangles.
- **BVH:** acceleration structure for raycasting (`three-mesh-bvh`).

## Goal
Convert imported STL geometry into a **welded / indexed “editable mesh”** representation that is fast for interactive tools (smoothing, cuts, hollowing), *without breaking existing analysis features* (island scan, layer slider overlays, voxel visualizations, etc.).

### Non-goals (for this plan)
- Implement dynamic topology / “add polygons while smoothing” itself (that will be a follow-up plan). This plan is the prerequisite.
- Rewrite the entire island scan pipeline to be index-aware (optional future work).
- Change coordinate system conventions.

## Why we need this
STL geometry behaves like “triangle soup” (many duplicated vertices). This makes:
- Interactive editing slow
- Dynamic polygon addition (detail while brushing) much harder

A welded/indexed mesh enables:
- Real vertex sharing
- Stable neighborhood/topology operations
- Better performance for brush tools

## Non‑negotiable compatibility requirement
Existing analysis features must continue working.

## Safety & rollout strategy (must-have)
We will not flip the entire app to a new representation in one step.

- Use a **feature flag** (default OFF) for the new editable mesh conversion.
- When OFF:
  - The app behaves exactly like today.
- When ON:
  - The app uses the dual representation described below.
- Include a **one-click rollback**: if anything fails, disable the flag and everything returns to the current path.

## Invariants (these must remain true)
- All existing features must keep working:
  - Island scan
  - Layer slider and overlays
  - Voxel visualization
  - Cross section cap
  - Selection and support placement raycasts
- The user must not be able to enter a state where the mesh looks correct but analysis uses stale geometry.
- Any mesh edit must keep the model in a valid renderable state:
  - Position attribute updated
  - Normals computed
  - BVH raycasting kept correct (refit or rebuild)
- Export must use the user-visible edited mesh.

## Dual representation contract (how we avoid breakage)
Each model will maintain two representations:

- **Editable geometry (indexed/welded)**
  - Used for:
    - Smoothing
    - Future mesh edits (cuts, holes, hollowing)
    - Raycasting (via BVH)

- **Analysis triangle-soup view (non-indexed positions)**
  - Used for:
    - Island scan workers (BucketedSlicer)
    - Slice2D
    - CrossSectionCap
    - MeshPainter

### Sync rule (single source of truth)
- The **editable geometry** is the source of truth once conversion is enabled.
- The analysis triangle-soup view is derived from the editable geometry.

### Sync triggers
- Generate analysis view:
  - On initial conversion
  - After any operation that changes mesh positions
  - After any operation that changes topology (triangle count / indices)

### Staleness prevention
- Track a per-model `meshRevision` counter.
- Any derived analysis data must record the `meshRevision` it was computed from.
- If an analysis request arrives with a stale revision, force a refresh before running analysis.

## Failure handling
- If conversion fails (OOM, exception, timeout):
  - Keep the original geometry active.
  - Disable the conversion flag for that model.
  - Show a clear message: “Editable mesh prep failed; using original mesh.”
- If derived analysis view generation fails:
  - Do not run island scan / overlays; instead surface an error state.
  - Provide a “retry” action.

Audit findings:
- Some code paths are already **index-aware** (safe on indexed geometry).
- Several critical features assume **non-indexed triangle soup** (and would break or miscount on indexed geometry unless updated).

Therefore, the safest approach is a **dual representation**:
- **Editable Geometry (Indexed/Welded)**: used for smoothing/cuts/hollowing and raycasting.
- **Analysis Geometry View (Triangle Soup positions)**: used by island scan workers, slicing, and painter/overlay logic that assumes triangles are consecutive.

## Audit Summary (what’s index-safe vs triangle-soup dependent)

### Index-safe (already supports indexed geometry)
- Mesh classification step:
  - `src/volumeAnalysis/islandVolume/steps/Step5_MeshClassification.ts`
  - Uses `indexAttr ? indexAttr.count/3 : position.count/3` and reads triangle vertices correctly.
- Raycasting + BVH:
  - `three-mesh-bvh` supports indexed geometry.

### Triangle-soup dependent (needs non-indexed positions OR must be updated)
- Island scan worker pipeline:
  - `src/volumeAnalysis/IslandScan/ScanOrchestrator.ts`
  - Passes `geometry.getAttribute('position').array` into workers.
  - Workers use `BucketedSlicer` which assumes non-indexed triangle soup.
- Slicing logic:
  - `src/components/analysis/Slice2D.ts` (`computeLoopsAtY`, `computeLoopsAtZ`, `BucketedSlicer`)
  - Iterates `for (let i = 0; i < pos.count; i += 3)` and also expects `positions.length` in steps of 9.
- Cross-section cap:
  - `src/components/scene/CrossSectionCap.tsx` (same triangle-soup slicing assumption).
- Analysis painting:
  - `src/components/analysis/MeshPainter.ts` (several loops assume `pos.count` is 3-per-triangle).

## Implementation blueprint (what to build)

### Data we need per model
The exact property names are flexible, but every model must have:
- **Editable geometry** (indexed/welded) and its BVH.
- **Analysis triangle soup positions** (a `Float32Array` where each triangle is 9 floats).
- **A `meshRevision` integer** that increments on every edit that changes geometry.
- **A conversion status**:
  - not started / in progress / ready / failed
- **Optional:** timings (conversion ms, rebuild ms) for debugging.

### Single source of truth
When conversion is enabled for a model:
- The editable geometry is authoritative.
- The analysis positions are derived and must be refreshed when stale.

### Known breakpoints (must not miss)
If any of these still receive indexed geometry directly, they can break:
- Island scan workers (they receive a raw positions buffer)
- BucketedSlicer and Slice2D loops
- CrossSectionCap
- MeshPainter triangle loops

## Development Checklist (detailed, safe order)

- [ ] **Phase 0: Guardrails first (no geometry changes yet)**
  - [ ] Add a feature flag for “editable mesh conversion” (default OFF).
  - [ ] Add a per-model conversion status state.
  - [ ] Add `meshRevision` tracking with a single rule: any mesh edit increments revision.
  - [ ] Add basic logging/telemetry for:
    - [ ] conversion start/end time
    - [ ] analysis view rebuild time
    - [ ] BVH rebuild/refit time
  - [ ] **Acceptance criteria:** with feature flag OFF, the app behaves identically.

- [ ] **Phase 1: Implement conversion to editable mesh (still not used by features)**
  - [ ] Implement welding + indexing conversion.
  - [ ] Build/attach BVH to the editable geometry.
  - [ ] Keep original (current) geometry path intact.
  - [ ] Add hard safety limits (fail fast and fallback):
    - [ ] max triangles
    - [ ] max vertices
    - [ ] max conversion time (optional)
  - [ ] **Acceptance criteria:** conversion can run on a test STL without changing visuals (flag still OFF).

- [ ] **Phase 2: Generate analysis triangle-soup view from editable geometry**
  - [ ] Implement a reliable way to produce triangle-soup positions from editable geometry.
  - [ ] Store it alongside the model and tie it to `meshRevision`.
  - [ ] Define refresh triggers:
    - [ ] on conversion complete
    - [ ] after any geometry edit
  - [ ] **Acceptance criteria:** triangle count and bounds match expected values.

- [ ] **Phase 3: Wire dual representation into the analysis pipeline (no behavior change)**
  - [ ] Island scan workers must receive triangle-soup positions.
  - [ ] CrossSectionCap and Slice2D must operate on triangle-soup positions.
  - [ ] MeshPainter must operate on triangle-soup geometry (or be made index-aware later).
  - [ ] Add a “stale revision” check: if analysis inputs are stale, rebuild analysis view first.
  - [ ] **Acceptance criteria:** island scan + overlays produce the same results as before on a known mesh.

- [ ] **Phase 4: Move editing tools onto editable geometry (feature flag ON)**
  - [ ] Update smoothing to operate on editable geometry.
  - [ ] On stroke end:
    - [ ] increment `meshRevision`
    - [ ] update normals
    - [ ] refit/rebuild BVH
    - [ ] rebuild analysis triangle-soup view (or mark stale and rebuild on-demand)
  - [ ] **Acceptance criteria:** smoothing works and island scan still works after smoothing.

- [ ] **Phase 5: Export contracts (STL now, 3MF later)**
  - [ ] STL export uses the current edited mesh (editable geometry when conversion is enabled).
  - [ ] Export validation:
    - [ ] export STL
    - [ ] re-import
    - [ ] compare bounds/triangle counts vs expectation
  - [ ] 3MF note:
    - [ ] indexed geometry is a natural fit and should help (smaller, structured), but is not required for this plan.
  - [ ] **Acceptance criteria:** exports remain correct and re-importable.

- [ ] **Phase 6: Validation matrix (must pass before enabling by default)**
  - [ ] Run each test with feature flag OFF (baseline) and ON (new path):
    - [ ] Load STL
    - [ ] Orbit/pan/zoom
    - [ ] Raycast hover correctness
    - [ ] Support placement raycasts still attach properly
    - [ ] Island scan completes, visuals match baseline
    - [ ] Layer slider cross section cap renders correctly
    - [ ] Voxel visualization renders correctly
    - [ ] MeshPainter still paints correctly
    - [ ] Smoothing is responsive
    - [ ] Export STL and re-import
  - [ ] Benchmarks to record:
    - [ ] load time
    - [ ] conversion time
    - [ ] island scan time
    - [ ] smoothing stroke responsiveness

## Rollback plan (do this immediately if anything regresses)
- Disable the feature flag.
- Confirm the app returns to baseline behavior.
- Fix the specific subsystem, then retest with flag ON.

## What this unlocks next (follow-up plans)
- Dynamic detail (add polygons while smoothing) with strict caps.
- More robust planar cuts / hollowing / hole cutting.
- Better 3MF export structure.

## Notes / Risks
- Conversion can add load-time work; if it’s noticeable, run it on-demand and/or in a worker.
- Keeping dual representation uses extra memory; this is intentional to avoid breaking existing systems.
