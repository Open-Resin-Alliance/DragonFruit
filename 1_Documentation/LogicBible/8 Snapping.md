# 8 Snapping

## Purpose (plain language)
Use the same snapping and sliding behavior everywhere (not tied to any one element). Tools/elements (e.g., Knots, arrangement tools) call this logic instead of implementing their own.

The authoritative implementation lives in:
- `src/supports/interaction/SnappingManager.ts`
- `src/supports/interaction/useSnapping.ts`

## Scope
- Target types (element-agnostic):
  - **Path**: lines/segments/chains (e.g., shafts, grid lines, edges). Treated as continuous paths.
  - **Surface**: planes/mesh surfaces (e.g., plate/raft plane, model surfaces).
  - **Point**: sockets/landmarks/handles (e.g., feature points).
- Applies broadly: Knots today; can be reused for bed arrangement, gizmo handles, etc.
- Works with GPU picking so the visually top-most candidate wins.

Note: the code currently implements full behavior for **Path** (including Bezier segments) and **Point** targets. A `surface` target type exists in types, but distance + projection logic for surfaces is not implemented yet.

## Core behavior
1) Lock acquisition
- When the pointer is near a target (within snapDistance), we lock to that target.
- Selection priority is:
  - GPU picking hit first (visual truth) *only if* the picked `objectId` resolves to a valid `SnapTarget` via `getTargetCallback`.
  - Otherwise, fall back to spatial search over `potentialTargets` (distance from the camera ray to each target).

2) Sliding
- Path: project the pointer ray to the closest point on the target segment (line) or sampled Bezier curve; return that world point plus a segment parameter `t` in `[0..1]`.
- Point: snap position is the point itself.
- Surface: not implemented yet.

3) Target switching
- Stay on the current target while the pointer is within releaseDistance.
- Switching is gated by `switchDwellMs` (time since last switch). When a different candidate is detected:
  - switch immediately if the candidate is within `snapDistanceMm`, OR
  - switch if we are outside `releaseDistance` from the current target.
- This applies to any target type (path/surface/point).

4) Commit/Cancel
- Commit/cancel is handled by the calling tool/state machine (e.g., placement controllers). The snapping layer only reports the current snap state + snapped position.
- A caller can clear snap state via `resetSnapping()` / `SnappingManager.reset()`.

## Parameters (global tunables)
- `snapDistanceMm`: small magnetic radius used to acquire a lock. Current default: `1.0`.
- `unlockRatio`: release distance multiplier (`releaseDistance = snapDistanceMm × unlockRatio`). Current default: `1.5`.
- `switchDwellMs`: minimum time before switching to a new target (flicker prevention). Current default: `50`.

There is no explicit sampling-rate throttle inside `SnappingManager`. Update cadence is controlled by the caller (for example, placement controllers calling `updateSnapping()` inside `useFrame`).

These values are global and not owned by any element. Elements read them from this snapping logic. Values can be adjusted per tool/context via a central config if needed.

## State machine (simple)
- Idle → Seeking → Locked(target)
- Seeking → Locked: a candidate target is found (GPU-picked or proximity-found).
- Locked → Locked(new): a different candidate is found and the dwell/switch rules allow switching.
- Locked → Seeking: no candidate is found and the pointer ray is farther than `releaseDistance` from the current target.

## Target definition
- Path: a single segment target (line segment or Bezier segment) with a radius. Distance is measured from the pointer ray to the segment, minus radius.
- Surface: reserved for future work.
- Point: a world-space position.

## Integration
- GPU picking: this logic consumes the current pointer-hit to prefer the visually top-most candidate.
- Elements/tools provide current target candidates (paths/points) in world space.
- `useSnapping` provides the pointer ray (via R3F `raycaster`) and the current GPU pick hit (via `usePicking()`).
- Knots use this for along-shaft sliding; arrangement tools can use it for grid lines/plate plane; gizmos can use it for handle/axis snaps.

Note: GPU picking only participates when the picked `objectId` maps directly to a snap target ID. If a picked ID cannot be resolved, snapping falls back to spatial proximity.

## Performance notes
- Reuse GPU picking; do not run duplicate hit tests.
- `useSnapping` intentionally avoids publishing snap results to React state every frame; it only publishes when snap state/target identity changes (to reduce UI lag).

## Edge cases
- Dense supports: dwell + release hysteresis reduce flicker.
- Target disappears while locked: snapping force-unlocks back to `seeking`.
- No candidate under mouse: remains `seeking` (with a non-useful default `snappedPos` of `{0,0,0}` until locked).
