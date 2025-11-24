# Snapping (Universal Logic) — Source of Truth

## Purpose (plain language)
Use the same snapping and sliding behavior everywhere (not tied to any one element). Tools/elements (e.g., Knots, arrangement tools) call this logic instead of implementing their own.

## Scope
- Target types (element-agnostic):
  - **Path**: lines/segments/chains (e.g., shafts, grid lines, edges). Treated as continuous paths.
  - **Surface**: planes/mesh surfaces (e.g., plate/raft plane, model surfaces).
  - **Point**: sockets/landmarks/handles (e.g., feature points).
- Applies broadly: Knots today; can be reused for bed arrangement, gizmo handles, etc.
- Works with GPU picking so the visually top-most candidate wins.

## Core behavior
1) Lock acquisition
- When the pointer is near a target (within snapDistance), we lock to that target.
- Selection priority: use what’s visually on top (GPU picking). If multiple qualify, prefer the closest by distance; break ties by keeping the current target.

2) Sliding
- Path: project to the closest point along the continuous path (whole chain) and constrain motion to that path only.
- Surface: project to the closest point on the surface with any context-specific constraints (e.g., plane lock).
- Point: snap to the point if within snapDistance.

3) Target switching
- Stay on the current target while the pointer is within releaseDistance.
- If the pointer leaves releaseDistance and enters snapDistance of another shaft, switch to the new shaft (optional small dwell to prevent flicker).
- This applies to any target type (path/surface/point).

4) Commit/Cancel
- On release: commit the snapped position.
- On cancel: restore the original position.

## Parameters (global tunables)
- snapDistanceMm: small magnetic radius used to acquire a lock. Sample default: 0.5 mm.
- unlockRatio: release distance multiplier (releaseDistance = snapDistanceMm × unlockRatio). Sample default: 1.5.
- switchDwellMs: minimum time over a new target before switching, to reduce flicker. Sample default: 50 ms.
- samplingRate: update cadence (60 Hz while dragging; 30 Hz hover). Reuse GPU picking results.

These values are global and not owned by any element. Elements read them from this snapping logic. Values can be adjusted per tool/context via a central config if needed.

## State machine (simple)
- Idle → Seeking → Locked(targetShaft) → Commit/Cancel
- Seeking → Locked: pointer enters snapDistance of a shaft.
- Locked → Locked(new): pointer leaves releaseDistance of current target and enters snapDistance of a different shaft (after dwell).
- Locked → Seeking: pointer leaves releaseDistance and is not near any other shaft.

## Target definition
- Path: an ordered chain of segments in world space. Closest-point search operates on the full path; return world point and a path parameter (t). Always query live geometry (no stale copies).
- Surface: a plane or mesh surface in world space. Use closest-point or ray projection consistent with the tool.
- Point: a world-space position (socket/landmark). Use nearest check within snapDistance.

## Integration
- GPU picking: this logic consumes the current pointer-hit to prefer the visually top-most candidate.
- Elements/tools provide current target candidates (paths/surfaces/points) in world space. This logic manages lock/slide/switch.
- Knots use this for along-shaft sliding; arrangement tools can use it for grid lines/plate plane; gizmos can use it for handle/axis snaps.

## Performance notes
- Reuse GPU picking; do not run duplicate hit tests.
- Update at 60 Hz during drag, 30 Hz hover; pause when idle.
- Avoid allocations per frame; reuse path/segment structures.

## Edge cases
- Dense supports: small snapDistance and dwell reduce flicker.
- Moving geometry: always use the current world-space path; the lock remains stable.
- No shaft under mouse: remain Seeking; do not place.
