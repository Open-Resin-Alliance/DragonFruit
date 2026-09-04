---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0029: Voxel hollowing architecture

## Context

DragonFruit's hollowing subsystem lets the user shell a solid model, optionally
fill the interior with lattice or pillar infill, and punch drain holes — then
slice the modified mesh. The feature spans three layers: a Rust voxelization
engine behind Tauri IPC, a TS mesh-modifier persistence layer, and a R3F
preview renderer. Each layer had independently-discovered failure modes that
shaped the current design.

## Decision

### 1. Rust-side voxelization via staged binary mesh

The hollowing engine lives in Rust (`mesh_repair.rs`). TS sends geometry as a
binary triangle soup via `stage_mesh_binary_set` (Tauri IPC), then invokes
`mesh_hollow` / `mesh_hollow_preview` / `mesh_hollow_apply`. The engine
voxelizes the model, classifies shell vs. interior voxels, computes cavity
surfaces, and returns results as binary Float32Array/Uint32Array buffers read
back via dedicated `_read_positions` / `_read_cavity_positions` commands.

Three modes: `cavity` (hollow the interior), `infill` (lattice or pillar fill),
and `shell_open_face` (remove one face of the bounding box for mold-style
prints). A `rotationQuat` parameter orients the voxel grid to the model's scene
rotation so pillar infills align with the build direction; the output mesh is
inverse-rotated back to the model's unrotated frame.

### 2. Externalized mesh modifier store

Mesh modifiers (hollowing state, hole-punch placements, source geometry
snapshots) are stored in a module-level `Map<modelId, ModelMeshModifiers>`
rather than on model objects in React state. This prevents React's state
reconciliation from churning on large payloads (hollowing `sourcePositionsBase64`
can be tens of MB for LYS imports) during selection, copy, paste, and duplicate.

**Critical invariant:** Model objects in React state carry
`meshModifiers: undefined` by design. Any code that serializes models (VOXL
save, autosave, scene export) or applies modifiers at output time (slicing) must
resolve through `resolveModelMeshModifiers()` — never read `model.meshModifiers`
directly. Violating this silently persists nothing; this exact bug shipped in the
June 2026 externalization refactor.

### 3. GPU-instanced voxel preview with resource-aware caps

Voxel previews render through two R3F components:

- `HollowVoxelPreview` — the cavity/shell preview during parameter adjustment.
  Renders removed-voxel centers as translucent cyan cubes.
- `HollowVoxelEditOverlay` — the blocker-editing mode. Voxels are
  yellow (blocked) or cyan (unblocked), individually toggleable.

Both use GPU instancing: a shared `InstancedMesh` for cube bodies (64
bytes/voxel for the 4×4 instance matrix) and a GPU-instanced `LineSegments`
wireframe that reuses the same matrix buffer (zero additional per-voxel memory).
The earlier non-instanced wireframe allocated 288 bytes/voxel (24 vertices × 3
floats) — on fine voxel sizes this could reach millions of voxels and throw
`RangeError: Array buffer allocation failed`.

The instanced-edge shader (`instancedEdgeShader.ts`) uses a custom
`instanceTransform` attribute rather than three.js's reserved `instanceMatrix`,
because `LineSegments` never has `isInstancedMesh === true` and three.js only
auto-injects instance handling for actual InstancedMesh objects. The draw
machinery (vertexAttribDivisor, mat4-attribute location splitting) is keyed on
`InstancedBufferGeometry` / `InstancedBufferAttribute`, not the object type.

Resource caps scale with the runtime: the budget is 12% of
`performance.memory.jsHeapSizeLimit` (Chromium/WebView2), falling back to 150 MB
on engines without the API. A `tryAllocateFloat32Array` wrapper returns `null`
instead of throwing as defense-in-depth.

### 4. Blocker integrity across rotation

Blocked voxel indices address a rotation-aligned grid. When the user rotates the
model after committing blockers, the grid changes and the linear indices become
meaningless. A rotation quaternion stamp (`blockedVoxelRotationQuat`) is
captured at commit time. On re-entry:

- `'valid'` — rotation matches the stamp; blockers are safe.
- `'stamp-legacy'` — blockers predate the stamp feature; adopt the current
  rotation rather than destroying the user's selection.
- `'stale'` — rotation changed since commit; indices must be cleared.

Quaternion comparison uses `|dot| >= 1 − ε` (not componentwise) because q and
−q encode the same rotation (double cover). Cache signatures use sign-canonical
quantized quaternions (`1e-5` rounding) so float round-trip drift (measured at
~1e-5 mm) cannot thrash keys.

### 5. Async lasso selection in Rust

Blocker selection by lasso polygon was moved from TS to Rust
(`selectRemovedVoxelsInPolygon`). The request mirrors the camera's
view-projection matrix and container-pixel-space polygon so the per-voxel
projection runs in native code. The TS side sends `viewProj` (column-major
16-float camera matrix), lasso polygon coordinates, and the full `HollowOptions`
so Rust can reconstruct the voxel grid without re-staging geometry.

### 6. Cavity centering for VOXL persistence

When a VOXL is saved, the model STL is exported re-centered
(`mesh.position = −geometry.center` baked into vertices). The cavity mesh
(`cavityPositionsBase64`) is persisted verbatim. `centerCavityPositions()`
translates the cavity by the same `−center` offset, producing a new
Float32Array without mutating the in-session cavity (which stays in the raw
uncentered frame for live preview).

### 7. Preview caching and debounce

Hollowing preview is debounced at 90 ms with a 0.2 mm shell-thickness quantum
to avoid Rust round-trips on every slider tick. Preview sources are staged once
and cached by a geometry-version key; `hollowingPreviewCache.ts` manages entry
lifecycle with explicit `dispose` calls. Blocked-voxel cache keys use FNV-1a
hashing over the index array (not JSON.stringify, which would produce multi-MB
key strings for large lasso selections).

## Consequences

- The externalized modifier store requires every persistence boundary to call
  `resolveModelMeshModifiers()`. Missing a call site silently drops hollowing
  data on save.
- GPU-instanced voxel rendering is zero-copy for edges (shared matrix buffer)
  but still O(n) for the cube InstancedMesh matrices. Very fine voxel sizes on
  large models still hit the resource cap, which truncates the preview with a
  console warning.
- Rotation changes after blocker commit are destructive — the user loses their
  blocker selection. The UI must warn before rotating a model with committed
  blockers.
- Lasso selection in Rust means the viewport transform must be faithfully
  forwarded across IPC. A mismatch between the JS camera state and the Rust
  projection produces invisible mis-selections (the lasso selects wrong voxels
  without any visible error).

## References

- Source: `src/features/hollowing/useHollowingManager.ts` (orchestrator),
  `src/features/mesh-modifiers/meshModifierStore.ts` (externalized store),
  `src/features/mesh-modifiers/hollowingGrid.ts` (rotation integrity),
  `src/utils/meshHollowing.ts` (Tauri IPC bridge)
- Renderers: `src/components/scene/HollowVoxelPreview.tsx`,
  `src/components/scene/HollowVoxelEditOverlay.tsx`
- Resource limits: `src/components/scene/hollowVoxelPreviewLimits.ts`
- Shader: `src/components/scene/instancedEdgeShader.ts`
- Rust engine: `src-tauri/src/mesh_repair.rs`
- Related: `ADR-0016` (Tauri IPC boundary), `ADR-0019` (memory-aware
  concurrency)
