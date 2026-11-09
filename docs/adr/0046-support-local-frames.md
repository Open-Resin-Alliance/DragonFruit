---
issue: support-local-frames
date: 2026-10-28
kind: decision
---

# ADR-0046: Store supports in model-local frames

## Status

Accepted. In progress on `feat/renderer-speedup`; the merged Prepare layer is
already baked model-local.

## Context

Support coordinates are stored in world space. A model move therefore rewrites
every support entity that belongs to it: roots, trunks, knots, segments, joints,
contacts, braces, kickstands and curves. `transformSupportsForModel` is that
rewrite, and it is on the pointer-up path of every XY drag. Measured on the
Prepare scene, the rewrite is ~356 ms and the support-derived scene commit that
follows is ~677 ms; the renderer itself is ~1 ms.

The world-space choice leaks into the rest of the system:

- merged Prepare geometry needed a baked `sourceInverse` to cancel the model
  group and a special case to skip a rebuild after a transform;
- the attached Support-mode layer applies the inverse committed model transform
  for the same reason;
- history snapshots carry a cloned support graph for a pure move;
- paste and import apply a delta transform to world coordinates even when the
  source and target model share a frame.

XY movement is a rigid translation of the support graph with its model. It is
the common case and should be O(1). Z movement is not rigid: roots are
plate-anchored, so the support must extend or retract. Rotation and scale move
the model contacts relative to the plate, so the supported graph must be
re-solved rather than rigidly transformed.

## Decision

Support coordinates become **model-local**.

- Every support entity already names its owning `modelId`. All coordinates
  nested in that entity (root transform, knot and joint positions, segment
  endpoints and Bézier controls, contact positions and normals, curve controls)
  are stored in the owning model's local frame.
- Roots are model-local too. A pure XY move changes only the model frame. A Z
  move adjusts the roots of that model so their world Z stays on the plate, and
  re-solves the trunk spans that touch them. Rotation and scale re-solve the
  affected roots and spans; they are not rigid vertex transforms.
- There is no per-entity matrix. The frame is the owning model's transform. A
  cross-model brace or grafted kickstand stores its own fields in its owning
  model's frame and resolves the other endpoint through that endpoint's owner.
  If either frame changes non-rigidly, the derived geometry is re-solved.
- Renderers are mounted under per-model groups, so a model move is a group
  matrix update. Picking returns world points from three; interaction converts a
  hit once, at the pointer boundary, before writing local coordinates.
- The wire format stays world-space. Import converts world to local per model;
  export and slicing convert local to world. Old files keep loading unchanged.
- History snapshots store local support data. The model transforms are already
  in the same scene snapshot, so undo/redo restores a consistent frame.

## Migration

1. **Merged Prepare layer** — done: `mergedSupportGeometry` bakes the merge into
   the model frame and `PrepareMergedSupportMesh` no longer applies an inverse.
2. **Support store and Support mode** — write local coordinates at the store
   boundary, render under per-model groups, and remove the attached-layer
   inverse.
3. **Interaction and placement** — convert raycast hits to local before writing;
   keep world-space solvers behind a conversion at their call sites.
4. **Export, slicing, import** — convert at the boundary; keep the wire format.
5. **Delete the world rewrite** — `transformSupportsForModel` and
   `transformAllSupportsForSingleModel` become no-ops for XY, then disappear.

## Trade-offs

- Every world-space consumer must either compose the frame or receive converted
  data. The store's transforms stop being a general geometry utility and become
  a frame/re-solve API.
- Z, rotation and scale still need work, but the work is scoped to the roots and
  spans that actually touch the plate rather than every support entity.
- Import/export and clipboard are boundaries where the frame must be explicit.
  Getting one wrong moves a whole support graph, so each gets parity tests.
