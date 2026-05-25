# Raft Geometry

DragonFruit raft generation produces a sacrificial base derived from support roots.

## Geometry pipeline

1. Compute footprint from support-root circles (convex hull + margin).
2. Generate chamfered base plate.
3. Optionally generate perimeter wall (crenelated behavior where configured).

## Design intent

- Improve adhesion and support network stability.
- Ease removal via chamfer profile.
- Reduce suction issues with perimeter gap strategy.
- Keep the raft material-efficient while still forming a stable base.

## Implementation notes

- The raft footprint is derived from support-root circles, then regenerated when rooted support topology changes.
- Manual geometry construction is preferred where triangulation artifacts become visible.
- The export pipeline includes raft geometry when enabled.

## Validation

- No NaN vertices.
- Correct winding and normals.
- Watertight output for export paths.
