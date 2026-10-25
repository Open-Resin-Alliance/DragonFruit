# Renderer smoothing plan (working, private)

Working plan for the interaction-performance pass on `feat/renderer-speedup`.
Delete or fold into `docs/dev/` when the phases land. Not published.

## Goal

Remove React and per-primitive bookkeeping from the frame/interaction path.
Targets are interaction latency, not fit-all throughput: the fitted plate already
holds 165 fps with ~404 calls and 14.2M triangles.

## What is already landed

- Orbit fold removed; picking readback no longer recycles an unread PBO and
  skips instead of a synchronous read.
- Support proxy is one tiled batch set (plate/selection changes no longer
  re-lay it out).
- Duplicates adopt the source chunk instead of re-encoding.
- Edge overlay disabled behind `MODEL_EDGE_OVERLAY_ENABLED`.
- Profiler: events, LoAF/long-task/idle-task labels, hot frames, fixed height,
  finished-recording reports.
- Hover derivations take a non-hover snapshot; hover writes coalesce; drags
  suppress hover and throttle support previews.
- Demand rendering tried and reverted (wake frame + idle clock delta).

## Phase 1 — Prepare: one merged support mesh per model

Prepare's interaction unit is the model. Lychee does exactly this: merges each
object's supports into one geometry parented to the object for Prepare, and
swaps to editable instanced supports in the Support menu.

1. Build one merged `BufferGeometry` per model from `collectProxyPrimitives`
   (world space), with group 0 = bodies and group 1 = contact disks.
2. Parent it to the model group behind the inverse committed transform (the
   matrix the attached proxy already uses). XY moves are then a parent matrix.
3. Per-model material tint: base orange, selected cyan, hover blend, scenery
   dim, ghost opacity, clipping. Disk group keeps its own shade.
4. Out-of-bounds: reuse the merged geometry with the existing stripe material
   as a second mesh (the test is per model, not per instance).
5. Model-level picking: the merged mesh selects its model, or is non-raycast
   and the model mesh answers. No per-support picking in Prepare.
6. Mode swap: merged in Prepare, editable in Support. Build once per support
   edit, lazily, with the existing "finalizing" indicator.
7. Transform rules: XY keeps supports; Z translate, tilt, scale and mirror hide
   them for the gesture and rebuild on release.
8. Extend from the active model to every model, then delete the Prepare-side
   proxy layer: attached proxy batch, live/scenery split, tiles, per-instance
   hover index where unused.

Acceptance: attached support layer ~124 calls → 2–3; supported-model drag shows
no support work in a profile; full-plate calls in the tens; visuals unchanged.

### Slice contracts (first wave)

- `src/supports/prepare/types.ts` (parent-owned, read-only): shared types.
- Merged-support geometry module under `src/supports/prepare/` (agent A): pure builder.
  - Input `ProxyModelGeometry` (type-only import from `SupportProxyMeshLayer`).
  - Output `MergedSupportGeometry { geometry, triangles, modelId? }`.
  - Same proxy fidelity: straight/tapered shafts, curved bezier tubes, roots
    (disk/cone/sphere), joints (sphere), contact cones (disk/body/tip, profile
    disk/sphere/legacy), world space, two groups.
  - No React, no R3F, no edits to existing files.
- Prepare support mesh component under `src/supports/prepare/` (agent B).
  - Takes merged geometry + final body/disk colors, opacity, clipping, visible,
    optional out-of-bounds material, optional model-level handlers.
  - Renders one mesh per material group (or one mesh with `material` array),
    plus the overlay mesh.
  - No integration edits.
- Integration files reserved for the parent: `SceneCanvas.tsx`,
  `ModelAttachedSupportLayer.tsx`, `StlMesh.tsx`, `page.tsx`.

## Phase 2 — Support editing: instanced primitives

Replace per-support React detail meshes with instanced batches per kind/shape:

- per-instance endpoints/radii and packed flags (selected, hover, preselected,
  visible, colliding, interior);
- shader-shaped taper/caps from those attributes; merged tubes for bezier;
- drag writes instance attributes directly, commits state once on release;
- React left with support data, panels, the selected primitive's gizmo/HUD.

Target: zero React commits in a joint/segment drag preview; attribute writes
instead.

## Phase 3 — Picking

- Keep the async GPU ID pass as visual truth; never fall back to synchronous
  `readPixels`.
- Encode hit distance and normal in the same pick pixel (Lychee's trick), so one
  readback yields id/type/point/normal.
- CPU BVH/analytic raycast only for model contacts and drag plane math.
- Delete the per-support hover index and cone bucket machinery once phases 1–2
  retire the representation they serve.

## Phase 4 — Deletions and measurement

- Delete the Prepare proxy path after phase 1.8.
- Delete superseded detail renderers except gizmos/HUD/special types.
- Keep the profiler captures as gates: supported-model drag, joint drag, hover
  sweep, plate switch, duplicate, first Support open.
- Do not reintroduce demand rendering without a low-rate heartbeat and a first
  frame delta clamp.

## Non-goals

- Fit-all fps: already 165.
- Raft merging: 10,340 triangles for the plate, not worth per-model picking
  identity loss.
- Re-enabling the edge overlay until it builds off the main thread.
