# Renderer smoothing plan (working, private)

Working plan for the interaction-performance pass on `feat/renderer-speedup`.
Delete or fold into `docs/dev/` when the phases land. Not published.

## Goal

Remove React and per-primitive bookkeeping from the frame/interaction path.
Targets are interaction latency, not fit-all throughput: the fitted plate already
holds 165 fps with ~404 calls and 14.2M triangles.

## Status

- Phase 1.8a/b landed behind `PREPARE_MERGED_SUPPORTS`: every visible model's
  Prepare supports are one merged mesh inside its own model group.
  `src/supports/prepare/mergedSupportCache.ts` does one `collectProxyPrimitives`
  walk per support-collection key (element identity, hover-safe), then merges one
  model per idle slice (`requestIdleCallback`, 200 ms timeout, `setTimeout`
  fallback), keeping each model's previous entry drawn until its replacement
  lands and disposing the replaced geometry. Entries carry the committed inverse
  they were baked under, so stale geometry follows the model rigidly; the
  profile's tip-offset-driven nib depth is part of the build key. The merged mesh
  is non-raycast: the model mesh answers selection, hover and drag start. The
  world support proxy hides the models whose merge is ready through a
  supports-only exclusion (rafts stay in the world layers). Pending (1.8c/d):
  out-of-bounds stripe on the merged mesh, ghost/duplicate/arrange previews on
  the cache, cross-section sources for non-active models, unscoped export,
  hide-during-gesture for Z/rotate/scale, and deleting the Prepare proxy path.
- Phase 1 active-model slice landed and visually checked: builder + mesh +
  active-model integration behind the flag. Superseded by 1.8a/b above, which
  mounts the same builder for every model and removes the active-only mount.
- Phase 2 wave 1 landed: slot records, flag codec, capacity-managed batch core,
  and a joints-only integration map.
- Phase 2 wave 2 landed: joint slots from `sceneBatchedJointGroups`, per-instance
  colour on the batch core, and the joints-only `InstancedJointBatch` behind
  `SUPPORT_INSTANCED_JOINTS` (on for testing). One draw for all unselected
  joints, capacity growth without remount, index raycast at tolerance 0, hover
  and marquee as colour + matrix writes, legacy overlays skipped in that branch.
  Pending: visual/pointer parity check on the supported scene, then shafts,
  cones/roots, and the drag writer.

- Phase 2 wave 3 landed behind `SUPPORT_INSTANCED_SHAFTS` (on for testing): shaft
  slots from the producer's own groups, one capacity batch for straight shafts
  plus one per quantized taper ratio, curved shafts kept as one merged tube per
  colour, hover/marquee as colour + matrix writes, index raycast at tolerance 0.
  The Support-mode producer now carries tapered twigs/kickstands/straight braces
  into the batch (`diameter` + `diameterEnd`): they were per-segment detail meshes
  with their own pick shells, and now draw as cone instances with the instanced
  hover palette. The simple views keep the legacy drop, having no batch.
  Pending: visual/pointer parity check on the supported scene, then cones/roots,
  and the drag writer.

- Phase 2 wave 4 landed behind `SUPPORT_INSTANCED_CONES` / `SUPPORT_INSTANCED_ROOTS`
  (on for testing): cone/root slots from the producer's own groups, one capacity
  batch per quantized shape ratio plus a tip and nib batch (cones) and a disk and
  top-ball batch (roots), hover/marquee as colour-only writes, index raycast at
  tolerance 0 with the legacy asymmetry (cone body covers the whole silhouette,
  root disk is the only pickable root primitive), cone/root overlays dropped for
  the supports the batch owns. Pending: visual/pointer parity check on the
  supported scene, then the drag writer.

- Phase 2 wave 5 landed behind `SUPPORT_INSTANCED_DRAG` (on for testing): the
  joint drag's preview is a private instanced batch instead of a React preview
  event. `useJointInteraction` / `JointGizmo` open a session with
  `beginJointDrag` (null for a twig, brace, stump, leaf or any bezier segment —
  those keep the 25 ms detail preview byte for byte), and the writer moves the
  dragged support's joints (resolved diameter, blue/grey), its adjacent segments
  (16-segment, per-taper-ratio buckets), its cones (body/tip/nib) and the leaf
  host-knot balls that ride its own segments through the SHARED scene joint batch.
  The detail `JointRenderer` visual mesh, `ShaftRenderer` visual mesh and
  `ContactConeRenderer` group are hidden with `visible={false}` from the
  drag-suppression store — never unmounted, so their pick registrations and ids
  survive the gesture — and `endJointDrag` clears the suppression in the same
  handler as the store write. Both commits read `getLastJointDragPreview()`.
  Per gesture: 2 React commits instead of two `flushSync` per 25 ms frame, and no
  producer or batch re-layout for the rest of the scene.
  Pending: A/B the drag's visual parity (cone aim against the disk solve, disk
  profile contact drawn by the batch nib rather than `ContactDiskRenderer`, the
  gizmo following the batch imperatively) and record draw calls per drag frame.

- Phase 2 wave 6 landed behind `SUPPORT_INSTANCED_CONE_DRAG` (on for testing):
  the contact-disk (tip) drag's preview is a private instanced cone batch instead
  of one React commit per pointer frame. `useContactDiskDragSession` begins a
  `beginConeDrag` session when the start options carry `contact` AND the type's
  descriptor declares `tipDragRebuildsGeometry: false` with a `cone` field — so
  trunk, leaf, stump and stick are instanced, while branch and twig pass no
  `contact` at all and keep the legacy `setTick` path byte for byte. The writer
  draws body, tip and (disk profiles) nib from `fillConeBatchSlot` +
  `writeConeBodyMatrix/Tip/DiskMatrix`, one flush per frame, no drop offset.
  Exactly the grabbed cone hides, through the asker's context (`coneIds` union,
  `supportId: null`); the support's shafts, joints and any sibling cone stay on
  their detail renderers. Commit order is unchanged: `endConeDrag` → store write
  → history push → guide cleared → `clearConeDragSessionAfterFrame`. Known
  delta: the moving HUD ring is inside the hidden cone group, so it stops
  following the tip for the gesture (the cone body/tip/nib still move and the
  pointer stays captured). Pending: A/B screenshots at three zooms, React commit
  count per gesture (expect 0 per hit), draw calls (3 vs 3), and the HUD-ring
  follow-up (move the HUD imperatively from the session, or draw a non-pickable
  ring in the batch).

**Correction from the joint map:** Support mode does not consume
`collectProxyPrimitives`. `SupportRenderer` resolves its own batches
(`sceneBatchedJointGroups` and siblings) with Support-specific filters, diameter
blends and drop offsets. Phase 2 slot records for Support mode must be built
from those resolved outputs, not the proxy collector; the collector stays the
Prepare/merged/static source.

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
   (world space), with group 0 = bodies, group 1 = contact disks (polygon offset),
   and group 2 = tip spheres and root plate disks (disc colour, no offset).
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
  - Output `MergedSupportGeometry { geometry, triangles, modelId? }` with the
  three groups above.
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
