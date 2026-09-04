---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0026: Organic cut and registration tenon system

## Context

DragonFruit needed a way to split a 3D-printed model into pieces for assembly —
contoured cuts that follow the model's surface, not just flat planes. Each cut
also needs a registration tenon (a shaped peg on one half, matching mortise on
the other) so the halves align when glued back together. The system shipped in
PR #485 with ~30 follow-up commits refining the tenon placement, gizmo, and
preview pipeline.

## Decision

### Architecture: self-contained feature module

The entire organic cut lives in `src/features/organicCut/`, self-contained with
its own types, Tauri IPC bridge, history actions, panel, tool, gizmo, and
session hook. The host app (`page.tsx`) touches only three lines: an import, a
hook call, and two JSX mounts. This isolation means the cut tool's complexity
doesn't leak into the main editor.

### Two cut modes

- **Contour** (`mode: 'contour'`): the user draws waypoints on the model's
  surface; a Rust geodesic engine computes a surface-following loop through
  them; a soap-film membrane is spanned over the loop as the cutter. Multi-loop
  cuts are supported — several loops are union'd into one cutter to free a part
  attached at multiple points.
- **Plane** (`mode: 'plane'`): the user places 2+ points; the frontend derives
  a cutting plane from `cutPlaneFromPoints()` and sends the exact plane to
  Rust. The seam is the plane ∩ mesh curve, computed locally (no Rust
  round-trip). 2 points → plane containing the line and world up; 3+ → PCA
  best-fit.

`cutPlaneFromPoints()` is the single source of truth for the plane: both the
preview quad and the plane sent to Rust flow from it.

### Tenon placement and lean

Each cut loop independently carries its own registration tenon settings
(`LoopTenonSettings`). The tenon is built STRAIGHT in Rust and the aim
(lean + roll) is applied client-side in `tenonLeanTransform.ts`, so dragging
the gizmo never costs a Rust round-trip.

**Frozen-basis roll.** The tenon's lean and roll use a two-rotation
decomposition: lean about the body's own +y (the hinge), then roll about +z
(the tenon's axis). The lean in the tenon's own frame *welds the lean plane to
the body*, so the roll turns the two as one. An earlier approach used
frame-carried roll (an azimuth that was a second number for the same freedom as
the roll), which caused roll drift — the tenon would slowly rotate as the user
adjusted the lean. Replaced in commit `4486b978`.

**One lean axis.** A second independent lean axis (X-lean) was added
(`6d913fa6`) then removed (`420a84ed`), settling on one welded lean + roll.
Two lean axes complicated the gizmo and made the control surface confusing
without adding meaningful placement capability.

**Build frame invariant.** The lean matrix is computed in the Rust BUILD frame
(`frame_extruding_toward_part_b`) — the natural frame with the axis negated and
u/v swapped. Leaning in the natural frame instead would mirror the result
because the swap flips handedness. `tenonLeanTransform.ts` matches
`LeanXform::apply` in `tenon.rs` exactly — sign mismatches are invisible on
screen until they are gross.

**Lean clamping.** The tilt is clamped to the room the part leaves around the
tenon (`maxTiltRad` from Rust), never past the hard ceiling of π/4. Clamping is
a soft boundary — the gizmo ring turns, the tenon doesn't — so a cap that falls
to 0 near an edge still lets the user interact.

### Preview caching

The membrane/tenon preview is a heavy Rust round-trip. An 8-entry FIFO cache
(`PREVIEW_CACHE_MAX = 8`) maps the exact preview inputs (loop, geodesic,
settings) to the result. Revisiting the same state (switch between models and
come back) hits the cache instead of rebuilding. The cache is keyed by a
JSON-serialized snapshot of all preview-affecting state.

Preview is suppressed during waypoint drags (`isDraggingPoint`) and rebuilt once
on release, with an 80ms settle timer (`PREVIEW_SETTLE_MS`) so the
just-finished drag's debounced geodesic lands first. Tenon gizmo drags
(`isDraggingTenon`) keep the preview visible — the aim is carried client-side
for the whole gesture.

### Terminology: tenon/mortise

An early implementation used "key/keyway" labels; these were renamed to
"tenon/mortise" (`424a1a1e`) for consistency with woodworking terminology and
the Rust backend's field names.

### Tenon gizmo design

The in-viewport aim gizmo (`OrganicCutTenonGizmo.tsx`) uses the app's standard
`ScreenSpaceGizmo` (rotate-only) but with two rings instead of three
(`LEAN_AND_ROLL_RINGS = ['y', 'z']`): the lean (green ring) and the roll. A
third ring was removed (`6d276741`) because the tenon has no azimuth freedom
separate from the roll.

The gizmo handles are fixed-relative and always visible (`4bdc76ac`): they
don't hide when the camera faces them edge-on, which would make a 2-ring gizmo
unusable. The gizmo must be mounted inside the scene's `PickingProviderWrapper`
(not inside `OrganicCutTool`) — its handles use GPU picking, so mounting outside
the provider makes them un-grabbable.

### Undo/redo integration

All cut edits flow through `commitLoops()`, which records before/after
snapshots for the app's undo history. Rapid edits of the same kind (number
field steps, gizmo drags per frame) are coalesced within a 500ms window
(`EDIT_COALESCE_WINDOW_MS`), and whole pointer drags collapse into a single
undo step. Cut-wide settings (kerf, smoothing, resolution) ride with the
snapshot so undo restores them too.

### Session persistence

Per-model loop persistence: the cut path (all loops + which is active) is
retained for the model it was drawn on in a session-only Map, so deselecting
and reselecting restores the in-progress loops. Cut paths are NOT written to
the scene file. An undo-restore Map tracks loops against the pre-cut geometry
reference, so undoing a cut brings the seam back.

## Consequences

- The self-contained feature module pattern should be followed for future
  feature-sized additions — it keeps the app shell stable.
- The frozen-basis lean + roll decomposition must match `LeanXform::apply` in
  Rust exactly; `tenonLeanTransform.test.ts` exists to catch sign drift.
- Preview caching means the preview inputs must be fully captured in the cache
  key; adding a new tenon parameter requires adding it to the JSON key.
- The two-ring gizmo means any future tenon freedom (e.g. azimuth for non-
  symmetric shapes) would need a third ring added back.

## References

- Source: `src/features/organicCut/` (types, session hook, Rust bridge, gizmo,
  panel, tool, lean transform, cut plane, snap-to-edges, history actions)
- Test: `src/features/organicCut/__tests__/tenonLeanTransform.test.ts`
- Key commits: `e6d9076e` (PR #485 initial), `4486b978` (frozen basis),
  `420a84ed` (drop second lean), `6d276741` (remove third ring),
  `424a1a1e` (tenon/mortise rename), `bc24d2ae` (preview cache)
