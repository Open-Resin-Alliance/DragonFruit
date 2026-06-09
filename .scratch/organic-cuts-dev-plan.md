# Organic Cuts — Design Doc

> Status: **Draft for review** · Branch: `feat/organic-cuts` · Owner: TableflipFoundry
> Scope of this doc: agree the problem, architecture, and a milestone plan toward a **prototype**, with a path to production.

---

## 1. Problem & Goal

When a model is scaled up past the printer's build volume, it must be split into parts that each fit. The naïve split is a **flat planar cut**, which leaves an obvious straight seam across the surface — immersion-breaking on character models (D&D minis, busts).

Expert artists instead make an **organic cut**: a seam that follows natural breaks in the form (armor edges, belts, hairlines) so it's hidden or looks intentional. Doing this today requires Blender-level skill.

**Goal:** a purpose-built tool *inside DragonFruit* that lets a non-expert produce a clean organic split by **drawing a seam on the surface**, without learning Blender.

### What this tool does and does not do

- ✅ **Does:** faithfully turn a user-drawn closed loop on the surface into a clean, consistent-thickness cutter ("wafer") and split the model into two watertight, printable parts.
- ❌ **Does not (by design):** decide *where* the seam should go. **Hiding the seam is the user's job.** No automatic curvature analysis, armor-panel detection, or seam suggestion. This is the single most important scoping decision — it turns a hard AI problem into a tractable geometry problem.

### Prototype scope (explicitly narrowed)

- One closed-loop cut → exactly two parts.
- Triangle meshes in / triangle meshes out (STL/OBJ), matching the existing pipeline.
- **No** registration keys/pegs, **no** auto-split-for-build-volume, **no** hollowing coordination — these are future work and must not be architecturally precluded.

---

## 2. The user's manual (Blender) process — the spec we're automating

Captured directly from the domain expert. This *is* the requirements list:

1. Today: select mesh vertices to define the seam — **disliked**, because it locks the cut to existing polygon edges and gives little shape control.
2. Desired: **draw freely on the surface**, independent of mesh topology.
3. Once the loop is closed: **smooth the path** into a clean curve.
4. Build a **"wafer"**: a solid of **consistent thickness** from the loop (a thin slab, *not* a zero-thickness sheet).
5. The wafer mesh must be **clean and smoothed** — no "impossible shapes" (self-intersections, degenerate/inverted geometry) that would break a boolean.
6. **Boolean** the wafer through the model to split off the part.

**Quality bar (from the expert):**
- Clean part separation — the halves genuinely come apart.
- Good final fitment that can be **easily indexed** (aligned/registered later).
- Seam-hiding is the user's responsibility, not the algorithm's.

---

## 3. Existing machinery we reuse (research findings)

DragonFruit already contains the closest possible analog: **hole-punching**. Findings from tracing it:

- **Two boolean engines coexist:**
  - **`manifold-csg`** (Rust crate, v0.1.4, `manifold` feature — *enabled* on desktop): the real CSG boolean. Hole-punch's **primary** path builds cutter meshes and calls `model.difference(&cutters)`. Crisp, detail-preserving.
  - **Custom voxel/SDF engine** (`rust/dragonfruit-mesh-repair/src/hollowing.rs`): voxelize → classify inside/outside (flood-fill + ray-parity) → Euclidean distance transform → threshold a `keep[]` array → re-mesh. Robust to messy input. Hole-punch's **fallback** path carves corridors this way.
- **Tauri command pattern** (per operation): `…capture_staged_source` → `…from_captured_source(optionsJson)` → binary `…read_positions`. Plus a one-shot `…_staged`.
- **Transport:** JSON options in; **raw little-endian f32 triangle soup** out (9 floats/triangle). Geometry staged via `stage_mesh_binary_set`.
- **Frontend types** follow a clean shape: `XSpec` (one operation), `XOptions` (`{ items: XSpec[] }`), `XReport` (counts), `XResult` (`{ report, positions }`).
- **Surface picking:** `three-mesh-bvh` `boundsTree` on the mesh geometry; an `SDFCache` wraps it for signed-distance queries. This is exactly what path-drawing needs.

### Reuse map

| Hole-punch component | Organic-cut analog | Reuse level |
|---|---|---|
| Place cylinders on surface | Draw closed loop on surface | New UI; **same BVH raycast infra** |
| Build cylinder cutter meshes | Build **one wafer cutter mesh** | **New geometry (the core invention)** |
| `manifold.difference(model, cutters)` | `manifold` split via wafer | **Reuse engine**, new caller |
| Voxel corridor fallback | Voxel level-set fallback | Reuse engine, deferred |
| capture → preview → apply commands | Same pattern, new command names | **Copy the pattern** |
| LE f32 triangle-soup transport | Same | **Reuse as-is** |

---

## 4. Engine decision (made on the expert's behalf)

The expert explicitly cannot choose between manifold and voxel — so this is an engineering call, justified by their own description.

> **Decision: explicit watertight wafer mesh + `manifold-csg` boolean as the primary engine. Voxel engine retained only as a graceful fallback (mirroring hole-punch), deferred past the prototype.**

**Why:** The expert's spec — *consistent thickness, clean mesh, smoothed, no impossible shapes, then boolean* — is the literal description of an explicit-mesh CSG cutter. The voxel engine would actively fight this: it cannot produce a crisp consistent-thickness wafer or a clean **indexable** mating face; it would blur the seam to the voxel resolution (~24–192 cells across the model). Manifold preserves the original surface detail at the seam exactly, and produces clean mating faces suitable for later indexing.

**Risk accepted:** manifold booleans can fail on non-watertight / self-intersecting input. Mitigations: (a) ensure the **wafer** is clean (we control it), (b) reuse hole-punch's retry-with-welding, (c) keep the voxel fallback as the safety net.

---

## 5. Pipeline architecture

```
┌─ FRONTEND (TS / React / three.js) ──────────────────────────────────────────┐
│                                                                              │
│  1. Draw loop on surface        2. Smooth/fair the loop                      │
│     • waypoint mode (click)        • resample + smooth into a clean          │
│     • free-draw mode (drag)          closed curve on the surface             │
│     • BVH raycast → surface pts    • live preview (ribbon/tube)              │
│                                                                              │
│            └────────────── send loop + thickness (JSON) ──────────┐          │
│                                                                   ▼          │
└───────────────────────────────────────────────────────────────────┼─────────┘
                                                                    │ Tauri
┌─ RUST BACKEND (dragonfruit-mesh-repair) ──────────────────────────┼─────────┐
│                                                                   ▼          │
│  3. Build wafer cutter            4. Clean/smooth wafer mesh                  │
│     • span the loop (membrane)      • weld, remove degens, ensure manifold   │
│     • offset to consistent          • fair the surface (no impossible shapes)│
│       thickness (thin slab)                                                  │
│                                                                              │
│  5. Boolean split                 6. Return two parts                        │
│     • manifold: model − wafer       • triangle soup ×2 (or part A + part B)  │
│       → two components              • report (tri counts, watertight flags)  │
│     • (fallback: voxel level-set)                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Layer responsibilities**
- **Frontend** owns interaction and rendering only: draw, smooth-for-preview, render the loop and the resulting two parts. No geometry truth lives here.
- **Rust** owns all geometry truth: wafer construction, cleanup, boolean, component separation.

---

## 6. The core invention: loop → wafer

This is the only genuinely new geometry. Breaking it into sub-problems:

### 6a. Loop on the surface (frontend)
- Input: ordered points on the mesh surface (from waypoints or free-draw), each with position + surface normal (from BVH hit).
- **Waypoint mode:** connect consecutive clicks along the surface. Options: straight chords projected to surface (simplest) → geodesic shortest path on mesh (nicer, harder). *Prototype: chords + projection; geodesic later.*
- **Free-draw mode:** sample the drag, raycast each sample to the surface, decimate.
- **Closure:** connect last point back to first; detect/encourage a clean closed loop.
- Output: a closed polyline of surface points (+ normals).

### 6b. Smooth/fair the loop
- Resample to roughly uniform spacing.
- Smooth (e.g. Laplacian / moving average / spline fit) with a user-adjustable strength, **re-projecting to the surface** so it stays on the model.
- This is what the expert means by "apply smoothing to the shape."

### 6c. Span the loop → membrane (Rust)
- Build a surface whose boundary is the loop and that passes through the solid interior.
- Candidate approaches (decide during prototyping):
  - **Simplest:** triangulate the loop against its average plane / centroid fan, then relax. Fast; may clip through geometry on highly non-planar loops.
  - **Better:** minimal-surface / membrane relaxation (soap-film) spanning the loop — smoother interior, better mating faces.
- The expert agreed the **interior can start simple**, with a **hook to let the user influence interior depth/curvature later** (in case a flat span would clip through visible geometry).

### 6d. Thicken → consistent-thickness wafer (Rust)
- Offset the membrane by ±half-thickness along its normal to make a closed, watertight thin slab.
- "Consistent thickness" is a hard requirement — uniform offset, watertight caps around the loop boundary.

### 6e. Clean/smooth the wafer (Rust)
- Weld coincident verts, drop degenerate tris, ensure manifoldness/orientation, fair the surface so the offset didn't create self-intersections ("impossible shapes").
- Goal: a mesh `manifold-csg` will accept without complaint.

### 6f. Boolean split (Rust — reuse)
- `manifold`: `model.difference(wafer)` (or intersect both sides) → separate into two connected components → part A and part B.
- Return both as triangle soup + a report.

---

## 6.5 Interaction model: "Cutting Mode" (persistent modal tool)

Drawing the loop is **not** a one-click action — it's a **stateful tool session**, because a loop that wraps around a model cannot be drawn from a single viewpoint. This is the part of the UX where "no Blender expertise needed" is won or lost.

**Core behavior:**
- The user **enters Cutting Mode**, which activates a tool that **stays active** until the loop is **completed** or **cancelled**.
- The loop is assembled from **multiple segments placed over time**. The user will **rotate/pan/zoom the camera between and during point placement** (front, then orbit to the back, etc.).
- The tool is **resumable across viewpoints**: place points on the front, orbit, keep placing, then close the loop.

**Hard requirement — drawing must not fight the camera.** Point placement and orbit/pan/zoom must coexist cleanly. Candidate input scheme (decide at M3):
- **Left-click / left-drag** = place point / free-draw stroke (the active drawing gesture).
- **Right-drag or middle-drag** = orbit/pan the camera (stays live the whole time).
- **Scroll** = zoom (always live).
- Optional modifier (e.g. hold a key) to temporarily suppress placement while reframing, if needed.

**Tool session state machine (frontend):**
```
        ┌────────────┐  enter cutting mode   ┌─────────────┐
        │   Idle     │ ────────────────────▶ │  Drawing    │
        └────────────┘                       │ (n points)  │
              ▲                               └─────────────┘
              │ cancel / complete                 │   ▲
              │                     place point ───┘   │ orbit/pan/zoom
              │                     (camera stays live)│ (no state change)
              │                                        │
              │   close loop (click first pt / "Close")│
              │                               ┌─────────────┐
              └─────────────────────────────  │  Closed →   │
                                              │  preview/   │
                                              │  apply      │
                                              └─────────────┘
```

**Session affordances:**
- **Visual feedback while drawing:** show placed points, the in-progress polyline on the surface, the rubber-band segment to the cursor, and a clear indicator of the **closure point** (snap/highlight the first point when the cursor is near it).
- **Edit while open:** undo last point, drag a point, delete a point.
- **Completion:** click the first point (or a "Close Loop" button) → loop closes → smoothing applies → preview the wafer/parts.
- **Cancellation:** explicit cancel (Esc / button) discards the session; camera and model untouched.
- **Non-destructive until apply:** nothing is committed to the mesh until the user hits Apply (mirrors hole-punch's preview→apply).

This tool session is **frontend-only state** — Rust never sees it until a completed loop is sent for wafer construction.

---

## 7. Data structures & command surface (matching existing conventions)

### Frontend types (`src/utils/meshOrganicCut.ts`, new)
```ts
export interface OrganicCutLoopPoint {
  position: [number, number, number]; // surface point, local space
  normal:   [number, number, number]; // surface normal at point
}

export interface OrganicCutSpec {
  loop: OrganicCutLoopPoint[];   // closed loop (last connects to first)
  thicknessMm: number;           // wafer thickness ("consistent thickness")
  smoothing: number;             // 0..1 path-fairing strength
  // future hooks (not in prototype): interiorDepth?, interiorCurvature?, keys?
}

export interface OrganicCutOptions { cut: OrganicCutSpec; }

export interface OrganicCutReport {
  sourceTriangleCount: number;
  partATriangleCount: number;
  partBTriangleCount: number;
  watertightA: boolean;
  watertightB: boolean;
  engine: 'manifold' | 'voxel';
}

export interface OrganicCutResult {
  report: OrganicCutReport;
  partA: Float32Array; // triangle soup
  partB: Float32Array; // triangle soup
}
```

### Rust options (mirror `HolePunchOptions`/`HolePunchSpec` in `hollowing.rs`)
```rust
pub struct OrganicCutSpec {
    pub loop_points: Vec<[f32; 3]>,
    pub loop_normals: Vec<[f32; 3]>,
    pub thickness_mm: f32,
    pub smoothing: f32,
}
pub struct OrganicCutOptions { pub cut: OrganicCutSpec }
```

### Tauri commands (mirror the punch trio in `src-tauri/src/mesh_repair.rs`)
| Command | Signature | Purpose |
|---|---|---|
| `mesh_organic_cut_staged` | `(options_json: String) -> Result<String,String>` | One-shot: split staged mesh, store both parts |
| `mesh_organic_cut_capture_staged_source` | `() -> Result<(),String>` | Capture source for repeated previews |
| `mesh_organic_cut_from_captured_source` | `(options_json: String) -> Result<String,String>` | Preview without mutation |
| `mesh_organic_cut_read_part_a` | `() -> Result<Response,String>` | Part A positions (LE f32) |
| `mesh_organic_cut_read_part_b` | `() -> Result<Response,String>` | Part B positions (LE f32) |
| `mesh_organic_cut_read_wafer` | `() -> Result<Response,String>` | (Debug) wafer mesh, for visualizing the cutter |

### UI (`src/features/organic-cut/OrganicCutPanel.tsx`, mirror `HolePunchPanel`)
- Mode toggle: **Waypoint** / **Free-draw**.
- Thickness field (`ScrollableNumberField`, mm).
- Smoothing field/slider.
- Buttons: Reset · Apply (same disabled/loading pattern).
- Live preview: render loop ribbon + (optionally) the wafer + the two parts pulled slightly apart.

---

## 8. Milestone plan (toward prototype)

Built as an **end-to-end thin slice first**, then deepen the hard part — so we always have something that runs.

- **M0 — Design sign-off.** This doc agreed.
- **M1 — Plumbing skeleton.** ✅ DONE. New Tauri commands + frontend module + panel shell, wired to the staging/capture/apply pattern. No-op cut proved the round-trip.
- **M2 — Trivial planar cut.** ✅ MOSTLY DONE. Plane derived from clicked points → `manifold-csg` `split_by_plane` → two parts → part A replaces original, part B added as a new scene model. Surface picking rides the StlMesh click pipeline (`onOrganicCutClick`), like hole-punch.
- **M3 — Cutting Mode + draw the loop.** Persistent modal tool (§6.5): enter/cancel/complete, camera stays live, points placed across viewpoints. Render the in-progress loop on the surface.
- **M4 — Real wafer.** Membrane spanning + consistent-thickness offset + mesh cleanup; the seam follows the drawn loop. Core-invention milestone.
- **M5 — Smoothing & free-draw.** Path fairing + free-draw mode + better preview.
- **M6 — Robustness.** Failure handling, voxel fallback hook, messy-mesh testing, perf on large models.

**Prototype = M5.** Production hardening = M6+ (and later: keys, auto-split, hollowing coordination).

### ⚠️ Interaction pivot (discovered during M2 testing)

The literal "click every point of a closed loop" interaction is **unworkable**: tracing a real seam around a model would take hundreds of clicks fighting the camera, and straight chords between clicks cut *through* the mesh instead of following the surface. Two consequences:

1. **Input model changes (user decision):** the keeper interaction is **"click a few rough points → the tool builds the loop"** — snap clicks to the surface and connect them with **geodesic paths that hug the surface** (not straight chords), auto-closing the loop. Few clicks, tool does the hard geometry.
2. **Interim (current):** to prove the split pipeline NOW without the geodesic work, the cut is defined by a **best-fit plane (PCA) through a few clicked points** — `plane_from_loop` fits the least-variance normal through the centroid. 3+ non-collinear clicks → a plane → a real split. No loop required yet.

**Revised near-term sequence:**
- **M2.5 (now): plane-from-a-few-points.** ✅ PCA best-fit plane; robust to scattered/near-collinear clicks. Decouples "does cutting work" from "where exactly the seam is." Proves split + scene insertion end to end.
- **M3 (revised): geodesic loop.** Replace straight chords with surface-hugging geodesic paths (via the per-mesh BVH) between clicked waypoints; auto-close; render the on-surface loop. THEN the loop both looks right and can drive the wafer.
- **M4+:** unchanged (real wafer from the now-clean on-surface loop).

---

## 9. Open questions / risks (to resolve as we build)

1. **Geodesic vs. projected chords** between waypoints — start projected; revisit if loops look unnatural.
2. **Membrane method** — flat-fan vs. minimal-surface; decide at M4 with real models.
3. **Non-planar loops that clip geometry** — when does a flat interior re-emerge through a visible surface? Drives whether we need the interior-influence hook sooner.
4. **Manifold robustness** on real scaled minis — how often does it fall back? Informs M6 priority.
5. **Two-component separation** — guaranteeing exactly two parts when a loop is valid; handling degenerate/self-touching loops.
6. **Coordinate space** — local vs. world, and matching the normalized-bbox convention hole-punch uses for specs.

---

## 10. Decisions locked

| # | Decision |
|---|---|
| 1 | Triangle meshes in/out (STL/OBJ). |
| 2 | Cut = user draws closed loop on surface → tool builds consistent-thickness wafer → boolean split. |
| 3 | Closed loop only → exactly two parts. |
| 4 | Two draw modes: waypoint (precise) + free-draw (fast). |
| 5 | Lives inside DragonFruit (reuses viewport, mesh pipeline, BVH, Tauri patterns). |
| 6 | Seam-hiding is the user's job; no automatic seam suggestion. |
| 7 | Engine: explicit wafer + `manifold-csg` primary; voxel fallback deferred. |
| 8 | Interior of wafer starts simple; design leaves a hook for user interior influence later. |
| 9 | Prototype scope: just the cut. No keys/auto-split/hollowing-coordination yet (not precluded). |
| 10 | Build end-to-end thin slice first, then deepen the wafer generator. |
| 11 | Loop drawing is a persistent "Cutting Mode" tool session (frontend-only state) that coexists with live camera controls; resumable across viewpoints; non-destructive until Apply. |
