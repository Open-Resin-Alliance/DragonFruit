# Organic Cut — Wafer / Curved-Split Handoff

> **Purpose:** Hand off the next (and hardest) phase of the organic-cut feature: making the
> actual cut *follow the geodesic loop* as a **curved zero-thickness split**, instead of the
> current flat plane. This doc captures the full current state, every locked decision, the exact
> integration points (with file:line), the algorithm to build, the known gotchas, and a
> step-by-step execution plan.
>
> **Audience:** whoever implements this next (the user, a fresh AI session, or a contributor).
> Assume they have NOT seen the prior conversation. Be able to execute from this doc alone.
>
> **Last updated:** 2026-06-09 · Branch: `feat/organic-cuts` · Last commit: `093b26a` (geodesic seam).

---

## 0. TL;DR — what to build next

The user draws a smooth geodesic loop on the model surface (DONE, committed). Right now the
**cut still slices along a flat plane** and ignores the loop's shape. The job:

1. Build a **membrane**: a triangulated surface that spans the geodesic loop and bows through the
   model interior as a **minimal (soap-film) surface** (boundary pinned to the loop).
2. Thicken it by a **sub-resolution hair (~0.01 mm)** into a razor-thin watertight cutter solid.
3. `manifold.split(cutter)` the model → two parts that mate along the contoured seam.
4. Make this **selectable** alongside the existing flat-plane cut (don't delete the plane path).

Result: a **curved, zero-thickness (physically) split** following the drawn seam — the actual
"organic cut" this whole project is named for.

---

## 1. Current state (what works, end-to-end)

All committed on `feat/organic-cuts`. The feature is isolated in `src/features/organicCut/` (frontend)
and the `dragonfruit-mesh-repair` crate + `src-tauri` (backend).

### Working today
- **Flat planar cut**: 2 points → live translucent plane preview → `manifold.split_by_plane` →
  two real parts inserted into the scene (part A replaces the model, part B added as a new model).
- **Surface-following geodesic seam**: click N waypoints → Rust computes a smooth geodesic loop
  on the surface (Dijkstra over mesh edges + minimal-surface straightening) → rendered as the
  on-surface polyline. UX model: **more waypoints = more path control.**
- **Scale-aware waypoint markers** (small, proportional to model bbox).
- **Live cut-plane preview** that exactly matches the committed cut (shared plane formula).

### NOT done (the gap this handoff closes)
- The **cut does not follow the loop**. The geodesic loop is drawn and rendered, but the actual
  split is still the flat plane derived from the points. Loop shape is ignored at cut time.
- No membrane, no curved split.

### Decisions LOCKED (do not relitigate)
| # | Decision | Rationale |
|---|---|---|
| 1 | Curved split is **zero-thickness** (parts mate perfectly, no material removed) | User wants a clean glue seam, not a kerf. |
| 2 | Membrane = **relaxed minimal surface (soap-film)**, NOT flat fill | Real seams are non-planar; flat fill would clip through the model. |
| 3 | Cutter thickness = **sub-resolution hair (~0.01 mm)**, NOT true mathematical zero | 0.01 mm is unprintable/invisible = physically zero, but robust + reuses working manifold path. True-zero (half-enclosing solid) is fragile. |
| 4 | Curved cut is **selectable alongside** flat-plane (mode), not a replacement | Flat is sometimes what you want; keep both. |
| 5 | Geometry runs in **Rust** (`dragonfruit-mesh-repair`); frontend is thin | Consistent with the whole pipeline; mesh already staged there. |
| 6 | Split engine = `manifold-csg` `split(cutter)` | It splits a solid by an arbitrary cutter solid (generalization of `split_by_plane`). |

---

## 2. The split engine — exact API (this is the key enabler)

`manifold-csg` v0.1.4 (Rust, behind the `manifold` cargo feature, ENABLED on desktop).
Source: `~/.cargo/registry/src/index.crates.io-*/manifold-csg-0.1.4/src/manifold.rs`.

**The method to use** (manifold.rs:1111):
```rust
/// Split by another manifold (instead of a plane).
pub fn split(&self, cutter: &Self) -> (Self, Self);
// Returns (model ∩ cutter, model − cutter).
// i.e. .0 = the part INSIDE the cutter, .1 = the part OUTSIDE the cutter.
```

Other relevant methods already in use / available:
- `Manifold::from_mesh_f32(vert_props: &[f32], n_props: usize, tri_indices: &[u32]) -> Result<Self, CsgError>` — n_props=3 for plain xyz. (manifold.rs:152)
- `to_mesh_f32(&self) -> (Vec<f32>, usize /*np*/, Vec<u32> /*indices*/)` (manifold.rs:431)
- `is_empty()`, `num_tri()`, `difference()`, `intersection()`, `boolean()`, `decompose()`.
- `split_by_plane(normal:[f64;3], offset:f64) -> (Self,Self)` — the CURRENT flat path (manifold.rs:591).

**How the cutter relates to the parts:** the cutter is a thin slab straddling the membrane.
`split` gives (inside-cutter, outside-cutter) — NOT the two halves directly. To get the two
HALVES, the cutter must be a closed solid representing **one entire side** of the membrane, OR
you thicken the membrane into a slab and then take `intersection`/`difference` to separate the
two sides. See §4 step 4 for the exact construction — this is the subtle part.

---

## 3. Where to plug in (exact integration points, with file:line)

### Backend — `rust/dragonfruit-mesh-repair/`
- **`src/organic_cut.rs`** — the cut entry point.
  - `pub fn organic_cut(mesh: IndexedMesh, options: &OrganicCutOptions) -> OrganicCutOutcome`
    (organic_cut.rs:~238) — dispatches to `organic_cut_plane` (manifold) or no-op fallback.
  - `fn organic_cut_plane(mesh, options) -> Result<OrganicCutOutcome, String>` (organic_cut.rs:259)
    — builds a `Manifold`, calls `split_by_plane`, converts back. **This is the function to branch:**
    when a curved cut is requested, call a NEW `organic_cut_membrane(...)` instead of `split_by_plane`.
  - `fn manifold_to_indexed(model) -> Option<IndexedMesh>` (organic_cut.rs:336) — reuse for the parts.
  - `struct OrganicCutSpec` (organic_cut.rs:~34) — add a field to select curved vs plane (see §5).
  - `struct OrganicCutReport { ..., engine: String, detail: String }` — set `engine: "membrane"`.
- **`src/geodesic.rs`** — the geodesic loop engine (committed). Reuse its helpers:
  - `pub fn surface_loop_from_mesh(mesh, waypoints, close) -> Option<Vec<Vec3>>` — the loop polyline.
  - `closest_point_on_tri`, `project_to_faces`, `local_faces` — useful for membrane relaxation +
    keeping membrane vertices related to the model. (Private now; make `pub(crate)` if needed.)
  - The straightening (`straighten_path`) is the SAME math family (Laplacian relaxation) you'll
    use for the membrane — study it as a template.
- **`src/core/halfedge.rs`** — `Topology::build(mesh)` gives edge→faces + vertex→faces adjacency.
- **`src/core/mesh.rs`** — `IndexedMesh { positions: Vec<Vec3>, triangles: Vec<[u32;3]> }`,
  `tri_positions(face)`, `tri_normal(face)`, `bbox()`. `Vec3` has `add/sub/scale/dot/cross/length`
  (methods, NOT operators; no `normalize` — use `.scale(1.0/len)`).
- **`src/lib.rs`** — re-export any new pub fns (e.g. `pub use crate::membrane::...`).

### Backend — `src-tauri/src/`
- **`mesh_repair.rs`** — Tauri commands. The cut commands already exist:
  - `mesh_organic_cut_staged(options_json)`, `mesh_organic_cut_from_captured_source(options_json)`,
    `mesh_organic_cut_read_part_a/_b`, plus the geodesic ones
    (`mesh_organic_cut_geodesic_loop`, `mesh_organic_cut_read_geodesic`).
  - **No new command needed** — the curved-vs-plane choice rides in the existing `optionsJson`
    (extend `OrganicCutSpec`). The `parse_organic_cut_options` helper already deserializes it.
- **`main.rs`** — `tauri::generate_handler![...]` registry (~line 3265). Only touch if you add a
  NEW command (you probably don't).

### Frontend — `src/features/organicCut/`
- **`types.ts`** — `OrganicCutSpec` (TS mirror). Add the mode field (must match Rust serde name).
- **`useOrganicCutSession.ts`** — owns session state + `apply()`. The `apply()` builds the payload
  (`{ cut: { loopPoints, thicknessMm, smoothing, plane } }`) and calls `cutFromCapturedSource`.
  Add the mode to the payload here.
- **`meshOrganicCut.ts`** — the Tauri bridge (`cutFromCapturedSource`, `computeGeodesicLoop`, etc.).
- **`OrganicCutPanel.tsx`** — the UI card (top-right). Add the **mode toggle** (Flat / Contour) here,
  mirroring the existing `drawMode` toggle.
- **`OrganicCutTool.tsx`** — in-canvas R3F viz (markers, geodesic line, plane preview). For the
  curved cut, OPTIONALLY render the membrane preview (see §6 "preview" — can defer).
- **`cutPlane.ts`** — the shared flat-plane formula (single source of truth for the plane preview).

### How a cut is invoked end-to-end (current flow — mirror it)
1. Frontend `apply()` (useOrganicCutSession.ts) → `stageCutSource(geometry, key)` stages the mesh +
   captures it as the source.
2. → `cutFromCapturedSource({ cut: {...} })` (meshOrganicCut.ts) → `invoke('mesh_organic_cut_from_captured_source', { optionsJson })`.
3. Rust `mesh_organic_cut_from_captured_source` → `organic_cut(mesh, &options)` → returns a report;
   stashes part A & part B bytes.
4. Frontend reads `mesh_organic_cut_read_part_a` / `_b` → `partToGeometry` → `commitParts` →
   `scene.splitModelInTwo(...)` (atomic: model→part A, append part B).

---

## 4. THE ALGORITHM — membrane → cutter → split

This is the core invention. Build it in a NEW file `rust/dragonfruit-mesh-repair/src/membrane.rs`,
unit-tested in pure Rust BEFORE any UI wiring.

### Inputs
- `mesh: &IndexedMesh` — the model (model-local space; same space as the loop).
- `loop_pts: &[Vec3]` — the closed geodesic loop polyline on the surface (from
  `surface_loop_from_mesh`). Already ordered, closed (last connects to first), de-duplicated.

### Step 1 — Seed the membrane (initial spanning triangulation)
You can't relax a surface that doesn't exist. Produce *some* triangulated surface whose boundary
is the loop:
- **Simplest seed:** compute the loop centroid; add it as an interior vertex; fan-triangulate
  (centroid → each consecutive loop-edge). This is a valid (if ugly) spanning disk.
- **Better seed:** project the loop onto its best-fit plane (PCA, same as `best_fit_plane_normal`
  in organic_cut.rs), do a 2D constrained Delaunay triangulation of the polygon, lift back to 3D.
  The crate already depends on `cdt` (a Delaunay crate — check `Cargo.toml`); `arrangement.rs`
  may show usage. Prefer this if `cdt` is easy to drive; else start with the fan.
- **Subdivide** the seed so there are enough interior vertices to relax into a smooth surface
  (a bare fan has only 1 interior vertex — useless). Target edge length ~ (loop length / N) where
  N ≈ 30–80. Midpoint-subdivide triangles until edges are below the target, OR seed a denser grid.

### Step 2 — Relax to a minimal surface (soap-film)
Iterative mean-curvature flow / Laplacian smoothing, **boundary (loop) vertices PINNED**:
```
repeat until converged (or max passes ~50):
  for each INTERIOR vertex v:
    target = average of v's neighbor vertices       // umbrella/Laplacian
    v = v + RELAX * (target - v)                     // RELAX ~ 0.5
  // boundary loop vertices never move
```
This is the SAME structure as `straighten_path` in geodesic.rs — copy its convergence/relaxation
pattern. The membrane bows naturally to follow the loop's 3D contour (that's the whole point of a
minimal surface vs. a flat fill). Convergence check: stop when total area change < epsilon.

**Optional remeshing during relaxation** (improves quality, adds complexity — can DEFER to v2):
as triangles distort, split long edges / collapse short ones / flip for better angles. v1 can skip
this and just relax a sufficiently-dense seed.

### Step 3 — Sanity / validity of the membrane
The membrane must be a clean manifold-able surface:
- No self-intersections (concave loops can fold — see §7 gotchas). v1: detect + report failure,
  fall back to plane. v2: untangle.
- Consistent winding / orientation (all triangles facing the same way). Compute a consistent
  normal field; flip inconsistent triangles. (Topology::inconsistent_edges can help detect.)
- Reasonable triangle quality (no zero-area slivers) — `manifold` rejects degenerate input.

### Step 4 — Thicken into a razor-thin cutter SOLID  ← the subtle step
`manifold.split(cutter)` needs a closed solid. The membrane is an open sheet. Make it a slab:
- Compute per-vertex membrane normals (area-weighted average of incident triangle normals).
- Offset each vertex by `±HALF_THICKNESS` along its normal (HALF_THICKNESS = 0.005 mm → 0.01 mm
  total). This yields a top sheet and a bottom sheet.
- Stitch the two sheets along the boundary loop (a ring of quads/triangles around the perimeter)
  to close the slab into a watertight solid.
- Result: a thin watertight "wafer" cutter, ~0.01 mm thick, hugging the membrane.

**Why this gives a (physically) zero-thickness mate:** 0.01 mm is far below print resolution; the
two resulting parts are separated by an invisible/unprintable gap = physically zero. (True
mathematical zero was explicitly rejected — decision #3.)

### Step 5 — Split
```rust
let model = Manifold::from_mesh_f32(...)?;      // already done in organic_cut_plane
let cutter = Manifold::from_mesh_f32(<slab>)?;  // the thin wafer from step 4
let (inside, outside) = model.split(&cutter);
// inside  = model ∩ cutter = the thin shaving INSIDE the wafer (NOT what we want as a "half")
// outside = model − cutter = the model with a thin slot removed
```
⚠️ **This is the crux to get right.** `split(cutter)` gives (∩, −), not the two halves. Options:
- **(A) Use `trim` semantics via two booleans:** the wafer slab, extended to fully span the model's
  cross-section at the seam, divides the model into two lumps that fall out of `outside`. After
  `outside = model − wafer`, run `outside.decompose()` → it should yield **two connected
  components** = the two halves. THIS IS LIKELY THE CLEANEST PATH: difference the thin wafer, then
  `decompose()` into the two halves. (Verify decompose splits along the slot.)
- **(B) Build the cutter as a HALF-space solid:** extend the membrane into a closed solid that
  encloses one entire side of the model, then `split` gives the two halves directly. More robust
  separation but much harder to construct the enclosing solid (this is basically decision #3's
  rejected "true zero" approach — avoid).

**Recommended v1:** Step 4 builds the thin wafer; `model.difference(&wafer)` then `.decompose()`;
expect exactly 2 components; map each to `IndexedMesh` via `manifold_to_indexed`. If `decompose`
yields ≠ 2 components (wafer didn't fully sever the body, or severed into >2), report failure +
fall back to plane.

### Step 6 — Output
Return `OrganicCutOutcome { part_a, part_b, report }` with `engine: "membrane"`. Same shape the
flat path returns, so the frontend commit flow is unchanged.

---

## 5. Data model changes (keep frontend/Rust serde names in sync)

The curved-vs-flat choice rides in the existing `OrganicCutSpec`. Add ONE field.

**Rust** (`organic_cut.rs`, `OrganicCutSpec`, `#[serde(rename_all = "camelCase")]`):
```rust
/// "plane" (flat) or "contour" (membrane). Default "plane" for back-compat.
#[serde(default)]
pub mode: Option<String>,   // or an enum CutMode { Plane, Contour } with serde rename
/// Cutter thickness for the contour cut, mm. Default ~0.01.
#[serde(default)]
pub cutter_thickness_mm: Option<f32>,
```
(An enum is cleaner than a String — `#[derive(Deserialize)] #[serde(rename_all="lowercase")] enum CutMode { Plane, Contour }`.)

**TS** (`types.ts`, `OrganicCutSpec`): add `mode?: 'plane' | 'contour'` and
`cutterThicknessMm?: number`. ⚠️ The serde field is `cutterThicknessMm` (camelCase of
`cutter_thickness_mm`). **Field-name mismatches silently drop data** (this bit us hard before:
TS sent `loop`, Rust expected `loopPoints` → 0 points reached the backend with no error, because
`#[serde(default)]` filled an empty vec). DOUBLE-CHECK every serde name matches camelCase exactly.

**Dispatch** in `organic_cut` / `organic_cut_plane`: if `mode == Some("contour")` AND
`loop_points.len() >= 3`, call `organic_cut_membrane(...)`; else the existing plane path.

---

## 6. Frontend wiring (after the Rust algorithm is proven by tests)

1. **`OrganicCutPanel.tsx`**: add a Flat/Contour mode toggle (mirror the existing `drawMode`
   Waypoint/Free-draw toggle — same Card sub-section pattern, `activeModeStyle`, etc.). Store in
   `OrganicCutPanelState`.
2. **`useOrganicCutSession.ts`**: include `mode` + `cutterThicknessMm` in the payload built in
   `apply()` (the `cut: {...}` object). Read them from panel state (use the refs pattern already
   in place so `apply` stays a stable callback — see the existing `panelStateRef`).
3. **Preview (optional, can defer):** to preview the membrane before committing, add a
   `mesh_organic_cut_membrane_preview` command that returns the membrane mesh positions, and render
   it translucent in `OrganicCutTool` (like the plane preview). NICE-TO-HAVE; ship the cut first.
4. **No change** to the commit flow (`commitParts` → `scene.splitModelInTwo`) — the two parts come
   back the same way.

---

## 7. GOTCHAS / failure modes (read before coding — these WILL bite)

1. **`split(cutter)` returns (∩, −), not two halves.** Use `difference` + `decompose()` (§4 step 5).
   Verify `decompose` yields exactly 2 components; handle ≠2 gracefully (fall back to plane).
2. **Serde field-name mismatch = silent data loss.** camelCase the Rust fields; verify TS matches.
   (History: `loop` vs `loopPoints` cost an hour of "0 points" debugging.)
3. **Manifold rejects non-watertight input.** The dragon STL etc. may not be watertight; the
   cutter slab MUST be watertight or `from_mesh_f32` fails / `split` misbehaves. Stitch the slab
   boundary carefully. If the model itself is rejected, the existing code already reports
   "manifold rejected source mesh" — keep that.
4. **Self-intersecting membrane on concave loops.** A minimal surface over a loop that wraps a
   concave region can fold through itself → invalid cutter. v1: detect (or just let `manifold`
   fail) and fall back to plane with a clear `detail` message. v2: untangle / use a coarser
   relaxation.
5. **Membrane bulging outside the model.** The minimal surface might bow OUTSIDE the model surface
   in places. For a SPLIT this is usually fine (the difference still severs the body), but watch
   for cases where the wafer pokes out and changes the outer silhouette. Clamp membrane vertices
   to stay inside the solid if needed (project inward).
6. **Coordinate space.** Loop points + staged mesh are BOTH in model-LOCAL geometry space (the
   space from `hit.object.worldToLocal`, where hit.object is StlMesh's inner mesh). The membrane,
   cutter, and split all happen in this space. Do NOT mix in world space. (The flat cut already
   gets this right; mirror it.)
7. **Performance.** Models are ~600k tris. Building `Topology` + the membrane per cut is fine
   (one-shot on Apply). But the geodesic loop is recomputed on EVERY point placement — if you add
   a live membrane preview, debounce it. Don't rebuild Topology on every keystroke.
8. **Rust changes require a `tauri dev` restart** (frontend HMR does NOT recompile Rust). Also:
   adding a new module + re-exports to `dragonfruit-mesh-repair` can trigger a spurious
   **incremental-compile linker error storm** (`LNK2001` unresolved symbols in UNRELATED functions
   like `hollow_voxel`/`analyze`). FIX: `cargo clean -p dragonfruit-mesh-repair -p dragonfruit-desktop`
   then rebuild. This is a known MSVC+incremental-Rust quirk, NOT a code bug. (Happened once; clean
   rebuild fixed it.)
9. **`cargo build` of the binary standalone always panics** at `generate_context!` with
   "frontendDist path doesn't exist" — that's ENVIRONMENTAL (no built frontend), not a code error.
   The real build/run is via `npm run tauri:dev`. To check Rust code compiles, build the LIBRARY:
   `cargo test -p dragonfruit-mesh-repair --features manifold`.

---

## 8. Build / test / verify commands

```bash
# Rust crate (library) — fast, this is where you validate membrane logic:
cargo test --manifest-path rust/dragonfruit-mesh-repair/Cargo.toml --features manifold membrane
cargo test --manifest-path rust/dragonfruit-mesh-repair/Cargo.toml --features manifold   # all 45+ tests

# Frontend typecheck (expect exactly 9 PRE-EXISTING errors, all in src/supports/__tests__/*):
npx tsc --noEmit 2>&1 | grep -E "error TS" | grep -vE "src/supports/__tests__/"   # should be EMPTY

# Full app (the only way to actually run it — needs the frontend):
npm run tauri:dev    # RESTART this after any Rust change

# If you hit the LNK2001 linker storm after adding a module:
cargo clean --manifest-path src-tauri/Cargo.toml -p dragonfruit-mesh-repair -p dragonfruit-desktop
```

**Pre-existing frontend errors:** there are 9 TS errors in `src/supports/__tests__/*` (raft/SDFCache/
trunk test fixtures) that EXIST ON MAIN and are unrelated. "Clean" = 9 total, 0 outside that dir.

---

## 9. Step-by-step execution plan (recommended order — de-risks the hard part first)

- [ ] **M4a — Membrane builder (pure Rust, test-first).** New `membrane.rs`. Seed (fan or Delaunay)
      + subdivide + Laplacian relaxation (boundary pinned). Unit test on a synthetic non-planar loop
      (e.g. a loop on a half-cylinder / saddle): assert the membrane spans it, boundary unmoved,
      interior area decreased (relaxed), stays bounded. NO UI yet.
- [ ] **M4b — Cutter construction (Rust, test-first).** Thicken membrane → watertight slab. Test:
      slab is closed (every edge has 2 faces — use `Topology::boundary_edges().is_empty()`), and
      `Manifold::from_mesh_f32(slab)` succeeds (non-empty manifold).
- [ ] **M4c — Split + decompose (Rust, test-first).** On a simple solid (e.g. a cube) + a flat-ish
      membrane, `model.difference(&wafer).decompose()` → assert exactly 2 non-empty components.
      Map to IndexedMesh. This proves the §4-step-5 crux before touching real models.
- [ ] **M4d — Wire into `organic_cut`.** Add `mode`/`cutterThicknessMm` to `OrganicCutSpec`
      (Rust + TS, serde names matched). Branch `organic_cut` to `organic_cut_membrane` when
      `mode == contour && loop>=3`. Set `engine: "membrane"`. Fall back to plane on any failure
      with a descriptive `detail`.
- [ ] **M4e — Frontend toggle.** Flat/Contour toggle in `OrganicCutPanel`; thread `mode` into the
      `apply()` payload. RESTART tauri dev.
- [ ] **M4f — Verify on the dragon.** Draw a loop around the waist, Contour mode, Cut → two parts
      that mate along the contoured seam (pull apart in the scene to confirm). Check console:
      `engine=membrane committed=true`.
- [ ] **M4g (optional) — Membrane preview.** Translucent membrane render before committing.
- [ ] **M4h (optional) — Quality:** remeshing during relaxation, self-intersection untangling,
      thickness as a user control for an intentional kerf/channel.

**Each step: write the test, make it pass, THEN move on.** The split-crux (M4c) is the single
riskiest unknown — prove it on a cube before building the full membrane pipeline, so you're not
debugging membrane + split simultaneously.

---

## 10. Deferred / parked items (not blocking the wafer)
- **Selection-race bug:** the very first cut once logged `commitParts: no active model` and deleted
  a model (model got deselected mid-apply). Intermittent; hasn't recurred. Fix later by capturing
  the target model id at click time, not commit time. (page.tsx `commitParts` / `handleOrganicCutClick`.)
- **Loop closure UX:** closing is currently implicit (≥3 points auto-closes for the geodesic). A
  "click near the first point to close" affordance would be nicer.
- **Perf:** cache `Topology` between geodesic recomputes (rebuilt every point placement now).
- **Free-draw mode:** panel has the toggle but only waypoint mode is wired.

---

## 11. Key files quick-reference

| File | Role |
|---|---|
| `rust/dragonfruit-mesh-repair/src/organic_cut.rs` | Cut entry point; `organic_cut`, `organic_cut_plane`, `manifold_to_indexed`. **Branch here for contour.** |
| `rust/dragonfruit-mesh-repair/src/geodesic.rs` | Geodesic loop (DONE). Reuse `surface_loop_from_mesh`, `closest_point_on_tri`, relaxation pattern. |
| `rust/dragonfruit-mesh-repair/src/membrane.rs` | **NEW — build this.** Membrane + cutter + split. |
| `rust/dragonfruit-mesh-repair/src/core/{mesh,halfedge}.rs` | `IndexedMesh`, `Vec3`, `Topology`. |
| `rust/dragonfruit-mesh-repair/src/lib.rs` | Re-export new pub fns. |
| `src-tauri/src/mesh_repair.rs` | Tauri cut commands (no new command needed). |
| `src/features/organicCut/types.ts` | TS `OrganicCutSpec` — add `mode`, `cutterThicknessMm`. |
| `src/features/organicCut/useOrganicCutSession.ts` | Session + `apply()` payload — add `mode`. |
| `src/features/organicCut/OrganicCutPanel.tsx` | UI — add Flat/Contour toggle. |
| `src/features/organicCut/OrganicCutTool.tsx` | In-canvas viz — optional membrane preview. |
| `src/features/organicCut/meshOrganicCut.ts` | Tauri bridge. |
| `.scratch/organic-cuts-dev-plan.md` | The overarching dev plan + milestone history. |

---

## 12. Mental model recap (for whoever picks this up)
- The user clicks waypoints → smooth geodesic loop on the surface (done). **More points = more control.**
- The loop is a CLOSED curve ON the surface. We need a SURFACE that fills it through the interior.
- That fill = a soap-film membrane (bows with the loop). Thicken to a hair → cutter solid →
  `manifold` difference + decompose → two parts that mate along the contoured seam.
- This is "the wafer," but ZERO physical thickness (parts glue together perfectly). Thickness as a
  deliberate kerf is a future option, not v1.
- Keep the flat-plane cut selectable; contour is a mode, not a replacement.
