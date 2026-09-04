---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: decision
---

# ADR-0028: Potential gradient support pathfinding (replacing A* Smart V2)

## Context

Smart V2 used grid-based A* (`GridAStar.ts`) over a discretized SDF to route
support shafts around model geometry. A* produced optimal-cost discrete paths
but suffered three problems at scale:

1. **Overhang pockets.** Under deep overhangs the discrete lattice ran out of
   expansion budget before finding an exit. Swim-Walk medium transitions and
   vertical pruning improved this but didn't eliminate the budget ceiling.
2. **Clearance creep.** The discrete cost function's clearance penalty drove
   paths close to model walls lower down the trunk — acceptable for the search
   region near the socket but wrong for the open-air vertical descent.
3. **Preview latency.** A* with 2000 expansions on a 0.5mm lattice added
   visible jank on hover preview. Warm-start partially covered it, but
   cold-start placements on complex geometry were still perceptible.

## Decision

Two continuous potential-field solvers replace A* for shaft routing. Both
integrate a virtual particle from the socket position downward to `goalZ`,
steered by the SDF gradient, and share the same SDF cache infrastructure.

### PotentialFieldSolver (first-generation, exploratory)

Greedy downward integration with three force components:

- **Gravity.** Constant downward velocity `vz = -1.0`.
- **Barrier repulsion.** Asymptotic potential `k · (M / (d - C) - 1.0)` that
  diverges as the particle approaches the clearance boundary `C`. Strength
  defaults to 8.0 with a 2.5mm safety margin. Inside the clearance zone
  repulsion scales aggressively to prevent penetration.
- **Tangential swirling.** Horizontal tangent force `t = ±(g × k)` (sign
  chosen to point outward from the starting socket) with weight 0.5. Guides
  the particle around obstacles and out of pockets that pure repulsion alone
  would stagnate in.

Lateral escape under overhangs transfers vertical repulsion energy into the
horizontal gradient direction (`lateralSlideWeight = grad.z * 0.90`).
Stagnation is detected via a 15-step circular displacement history — if the
particle moves less than `1.5 × stepMm` over the window, search terminates.

### FieldDeterministicSolver (production default)

Deterministic gradient-flow marcher with angle-capped steps:

- **Blended march vector.** The step direction is `(1−w)·(0,0,−1) + w·grad`
  where `w` is a linear blend: `w=1.0` at or below clearance distance,
  `w=0.0` at clearance + margin, linearly interpolated between. This produces
  pure gradient steering near obstacles and pure vertical descent in open
  space.
- **Per-step angle cap.** Every step is clamped to the same length-aware max
  angle from vertical that the final chain validator enforces. Steps within
  the socket-elbow window use the steeper elbow allowance. This guarantees
  the raw march path already satisfies the chain validator, avoiding
  simplification rejections.
- **Trilinear collision projection.** After each step, if the next position
  is inside `clearance + stepMm/2 + 0.01` (the acceptance threshold), the
  position is pushed outward along the local SDF gradient by the deficit.
  The half-step margin exploits the SDF's 1-Lipschitz property: keeping
  every path *point* at `clearance + step/2` guarantees the segment
  *interior* between adjacent points never dips below clearance.
- **Early vertical escape.** Before each march step, if the particle is
  already outside the clearance zone and the straight line to `goalZ` is
  unblocked, the path is completed immediately. Skips redundant integration
  in open space.

### Gradient socket nudging

When the socket position itself is inside the model clearance zone (common
for overhang-facing contact points), an iterative gradient march nudges the
socket outward along the SDF gradient before routing begins. This finds a
feasible start position without the combinatorial socket-rescue search that
A* required.

### SDF cache optimisations

- **`maxDistance` early-out.** `distanceAndGradientAt` accepts a `maxDistance`
  parameter. Queries in open space (outside the expanded world bounds) return
  immediately at maximum distance, bypassing BVH lookups and finite-difference
  gradient computation. Yields 4× routing speedup.
- **Trilinear interpolation.** `distanceAtTrilinear` performs 3D trilinear
  interpolation of cell-corner SDF values, giving continuous (C⁰) distance
  estimates for sphere-tracing. The `segmentBlocked` check uses this for
  Lipschitz-compliant swept-capsule queries.
- **Exact signed distance.** `exactSignedDistanceAt` bypasses the grid
  entirely for contact-cone collision checks where the grid's quantisation
  error (~cellSize·√3/2) exceeds the safety margin.

### Path simplification

Solved paths are simplified in two passes:

1. **Z-monotone filter.** Drops any waypoint where Z increases (the particle
   temporarily ascended under overhang repulsion).
2. **Greedy line-of-sight collapse.** Starting from the socket, extends each
   chord as far as the SDF `segmentBlocked` check allows, with angle
   validation on each collapsed chord (first segment gets socket-elbow
   allowance, rest get length-aware max-angle rule).

### Integration with existing placement chain

Both solvers plug into `SmartPlacementV2.ts` as an alternative to
`gridAStar()`. The strategy selection logic, socket rescue, roots-disk
validation, contact-cone collision, and base resolution remain unchanged.
A DevTools panel (toggled in Settings) selects between A*, Potential, and
Deterministic solvers at runtime with tunable parameters.

## Consequences

- The A* `GridAStar.ts` is retained but no longer the default routing
  backend. It serves as a fallback for the DevTools solver comparison.
- Stagnation (lateral limit exceeded or displacement history plateau) replaces
  A*'s `exhaustedBudget` flag — callers handle both the same way (fall back
  to V1 or straight placement).
- The clearance-creep problem is structurally eliminated: the blended march
  vector transitions to pure vertical descent outside the margin zone, so
  support shafts are straight once clear of geometry.
- The 0.48mm global standoff (`COLLISION_AVOIDANCE_MM`) and roots-volume
  sweep are unchanged and still enforced by `SmartPlacementV2`.

## References

- Source: `src/supports/PlacementLogic/Pathfinding/PotentialFieldSolver.ts`,
  `FieldDeterministicSolver.ts`, `SmartPlacementV2.ts`, `SDFCache.ts`
- Tests: `potentialFieldSolver.test.ts`, `fieldDeterministicSolver.test.ts`,
  `sdfCache.test.ts`
- Related: ADR-0017 (strategy
  chain — addendum notes this successor)
- Key commits: `761a251c` (PoC potential solver), `2c90c649` (barrier
  potential + swirling), `3a12f703` (deterministic solver), `542bad49`
  (SDF cache optimisation), `e1c0fe99` (gradient socket nudging)
