# Mesh Smoothing Brush (Prepare Mode) Development Plan

## Overview
We want a new tool in the **Preparation** step that lets you *gently smooth* the loaded STL mesh using a **brush**, similar to Blender sculpt smoothing. This is intended to help repair small surface issues that could cause printing problems.

From your perspective:
- You load an STL.
- In Preparation, alongside **Select** and **Modify**, you click **Smoothing**.
- A brush cursor appears on the model.
- You drag on the model to smooth only the area under the brush.
- On the right side, a settings panel lets you tune:
  - Brush Size
  - Intensity/Strength
  - Falloff
  - (Optionally) Smoothing method/quality
- Each “drag stroke” is a single undo step, so you can safely experiment.

The implementation should be “the real thing” (not a toy): it should scale to higher-poly meshes by using precomputed topology data and sensible performance safeguards.

## Implemented so far (what exists in the codebase now)
- **Brush tool + UI plumbing**
  - Smoothing mode exists in Prepare.
  - Brush cursor + hover state exists.
- **Topology cache for STL “triangle soup”** (no mesh representation change)
  - Weld/group duplicated STL vertices (epsilon)
  - Build adjacency (neighbors) for welded vertex ids
- **Fast affected-vertex selection**
  - Uses BVH shapecast when available
  - Has a spatial-hash fallback path
- **Performance safeguards and GC reductions**
  - Stroke spacing (skip tiny mouse jitter)
  - Per-geometry scratch buffers reused to avoid allocations
  - Reduced per-dab allocations in BVH query + fallback query
- **Single Web Worker smoothing pipeline**
  - Smoothing math runs off the main thread
  - “Latest wins” behavior (drops stale work)
  - Uses transferable buffers for per-dab data to avoid copying
  - End-of-stroke finalization is deferred until the last worker result lands

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: Plumbing (Tool mode + UI wiring)**
  - [x] Create the `src/features/mesh-smoothing/` feature directory and split responsibilities into separate files (settings vs brush logic).
  - [x] Add a third tool button (**Smoothing**) next to Select/Modify on the Preparation toolbar.
  - [x] Extend the current prepare tool state to support `smoothing` (in addition to `select` and `transform`).
  - [x] Ensure gizmo/transform UI stays exclusive to Modify mode (no gizmo in Smoothing).

- [x] **Phase 2: Smoothing settings panel (right sidebar)**
  - [x] Add a Preparation sidebar panel that conditionally shows when Smoothing is active.
  - [x] Add the initial settings:
    - [x] Brush Size (mm)
    - [x] Intensity/Strength (0–1)
    - [x] Falloff (e.g., Linear / Smooth / Sharp)
    - [x] Smoothing Type (Laplacian / HC / Taubin)
    - [x] Quality/Iterations (low/medium/high or numeric)
    - [x] Stroke spacing (prevents “over-applying” from tiny mouse movements)

- [x] **Phase 3: Brush interaction (cursor + stroke lifecycle)**
  - [x] Show a clear brush cursor on the mesh when hovering in Smoothing mode.
  - [x] Implement stroke lifecycle:
    - [ ] PointerDown begins stroke (capture undo “before” state)
    - [x] PointerMove applies smoothing steps (throttled)
    - [x] PointerUp ends stroke (finalize mesh; worker path defers finalize until last result)
  - [x] Ensure smoothing only targets the **active model**.

- [x] **Phase 4: Core smoothing engine (high quality)**
  - [x] Build/maintain a per-model topology cache:
    - [x] Vertex “welding/grouping” for STL duplicate vertices (epsilon-based)
    - [x] Vertex adjacency lists (neighbors)
    - [x] A vertex spatial lookup (uniform grid / kd-tree) for fast “within radius” queries
  - [x] Implement smoothing algorithms:
    - [x] Basic Laplacian (fast baseline)
    - [x] HC or Taubin smoothing (reduced shrinkage; better repeated brushing)
  - [x] Apply smoothing with radius + falloff + strength.

- [ ] **Phase 4b: Optional detail / remesh (for low-poly or janky topology)**
  - [ ] Add a “Detail” control (Off / Low / Medium / High) with strict caps.
  - [ ] Implement local subdivision/remeshing only within the brush radius.
  - [ ] Prevent polycount explosion (hard limits + graceful degradation).

- [x] **Phase 5: Geometry updates (normals + BVH + downstream correctness)**
  - [x] Recompute normals at end of stroke (worker path defers finalize until last result; CPU path finalizes immediately).
  - [x] Update BVH acceleration after edits so raycasting/support placement remain correct:
    - [x] Prefer refit if supported
    - [x] Otherwise rebuild at stroke end
  - [x] Ensure other systems that depend on geometry (selection, analysis, supports placement) remain stable.

- [ ] **Phase 6: Undo/Redo integration**
  - [ ] Create a history action type for smoothing strokes.
  - [ ] Store only what’s needed (affected vertex indices + before/after positions) to keep memory reasonable.
  - [ ] Confirm: 1 stroke = 1 undo step.

- [ ] **Phase 7: Performance + safety polish**
  - [x] Add throttling (pointer-move cadence) and per-stroke spacing.
  - [ ] Add safeguards for extreme meshes:
    - [ ] Cap max vertices affected per dab
    - [ ] Degrade gracefully (warning + auto-adjust) rather than freezing
  - [ ] Add a small on-screen status indicator if smoothing is temporarily degraded (optional).

- [x] **Phase 7b: Web Worker responsiveness (main-thread stays smooth)**
  - [x] Run smoothing math in a single Web Worker.
  - [x] Latest-wins behavior (drop stale jobs).
  - [x] Use transferable buffers for per-dab job data.
  - [x] Defer stroke finalization (normals/BVH) until the last worker result is applied.

- [ ] **Phase 8: Validation / testing workflow (user-facing confidence)**
  - [ ] Add a repeatable test mesh or two (small + large) and a manual test checklist.
  - [ ] Verify:
    - [ ] No crashes
    - [ ] Undo/redo correctness
    - [ ] No broken raycasts after smoothing
    - [ ] “Feels like a brush” (cursor, falloff behavior)

## Technical Details

### Relevant Existing Files / Integration Points
- `src/app/page.tsx`
  - Renders Preparation tool UI (`TransformToolbar`) and currently only shows `TransformControls` when in Modify.
  - Computes `sidebarContent` and currently returns empty content for `scene.mode === 'prepare'`.
- `src/components/controls/TransformToolbar.tsx`
  - Currently defines the Prepare toolbar buttons: Select/Modify.
- `src/hooks/useModelTransform.ts`
  - Defines `TransformMode` (currently `'select' | 'transform'`).
- `src/features/transform/useTransformManager.ts`
  - Plumbs `transformMode` and exposes `setTransformMode`.
- `src/features/scene/useSceneCollectionManager.ts`
  - Source-of-truth for loaded models, including per-model `geometry: GeometryWithBounds`.
- `src/hooks/useStlGeometry.ts`
  - STL load + normalization + BVH acceleration.
- `src/utils/bvh.ts`
  - BVH initialization + `accelerateGeometry(geometry)`.
- `src/components/scene/SceneCanvas.tsx`
  - Already tracks hover points via `onModelHoverPointChange` and `lastHoveredModelPointRef`.
  - Already has multiple “controller” patterns and overlays that are mode-conditional.
- `src/features/mesh-smoothing/meshSmoothingEngine.ts`
  - Dispatches smoothing steps and now supports a single-worker pipeline.
- `src/features/mesh-smoothing/meshSmoothing.worker.ts`
  - Background smoothing math (latest-wins) used to keep the UI responsive.
- `src/history/historyStore.ts`
  - `pushHistory`, `registerHistoryHandler`, undo/redo stacks.

### Proposed Feature Location (Domain/Feature-Based Structure)
This is a mesh editing feature in Preparation (not a support type). It should be its own feature directory, with settings and brush logic kept in separate files.

Recommended structure:
- `src/features/mesh-smoothing/`
  - `settings.ts` (source of truth for smoothing settings + defaults)
  - `MeshSmoothingSettingsPanel.tsx` (right-side sidebar panel UI)
  - `brushController.ts` (brush interaction + stroke lifecycle)
  - `topologyCache.ts` (vertex welding/grouping + adjacency + spatial lookup)
  - `smoothingAlgorithms.ts` (Laplacian / HC / Taubin)
  - `meshSmoothingEngine.ts` (stroke begin/apply/end orchestration)
  - `meshSmoothing.worker.ts` (single-worker smoothing compute)
  - `history.ts` (history action definition + handler registration)

(Exact names can change, but the split must remain: **settings in their own file** and **brush logic in its own file**.)

### Tool/Mode Model
Current prepare tool mode is represented by `TransformMode`.
- Extend it to include a third mode: **Smoothing**.
- The smoothing system should be active only when:
  - `scene.mode === 'prepare'`
  - AND the prepare tool is `smoothing`

### Data Model Requirements
Per active model (by `modelId`) maintain a cache:
- **Weld map**: groups vertices that should be treated as identical (STL often duplicates vertices per triangle)
- **Adjacency**: per welded-vertex group, list of neighbor groups
- **Spatial lookup**: accelerates “find vertices within radius”
- **Scratch buffers**: for per-stroke computations to reduce allocations

### Smoothing Algorithm Notes
- Laplacian smoothing is a baseline but shrinks with repeated application.
- HC or Taubin smoothing reduces shrinkage and is closer to what users expect for repeated brushing.
- Brush application should be incremental:
  - Use falloff-weighted blending toward the smoothed target, controlled by Intensity.

### Geometry Update Rules
- Update vertex positions in the active model’s `BufferGeometry` position attribute.
- Update normals:
  - End of stroke: full recompute
- BVH:
  - Keep raycasting correct after edits by rebuilding/refitting at least once at stroke end.

### Worker behavior (responsiveness contract)
- The UI thread must remain responsive while brushing.
- The worker processes only the latest dab (older queued work is dropped).
- Finalization (normals + BVH) happens only after the last worker result is applied.

### Undo/Redo Payload Shape
For each stroke:
- modelId
- affected vertex indices (or welded groups mapped to actual indices)
- before positions
- after positions

### Open Questions (to decide before implementation)
- Should smoothing permanently modify the exported mesh (STL export), or is it only for internal use?
- Typical mesh size targets (triangles): <500k vs 1–5M vs 10M+.
- Do we need additional brush modes later (inflate/deflate/relax), or only smoothing for now?
