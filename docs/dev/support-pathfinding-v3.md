# Support Pathfinding V3

How a support trunk gets from a contact point on the model to the build plate.
The trunk router is `src/supports/PlacementLogicV3/SmartPlacementV3.ts`, reached
from `trunkBuilder.buildTrunkData`.

## The shape

```
contact cone ──► one diagonal ──► joint ──► straight drop to the plate
```

One diagonal, one joint, and a vertical load-bearing span. That is the whole
vocabulary: the router cannot emit a multi-joint chain, so nothing downstream
has to simplify one back down and no two code paths can disagree about what a
valid route looks like.

The shape is not an aesthetic choice. A support is strongest as a vertical
pillar, so the router's only job is to find the earliest point where vertical
becomes possible and get there in one move.

## The search

`EscapeJointSearch` is the entire route search. For each candidate direction, in
order:

1. Walk outward from the socket along a 45° ray, in `WALK_STEP_MM` (0.5) steps.
2. At each step the leg increment must be clear, then the column below the point
   must be clear down to `rootTopZ` **and** the roots volume must fit at that XY.
3. Stop at the first point that satisfies both. That is the joint.

The direction search is the only optimisation, and its objective is to keep the
joint as close as possible to the socket's own column, because everything below
the joint is vertical. `buildDirectionFan` orders the directions from the
surface normal's outward direction, alternating either side of it, so the way
off the surface the tip is attached to is tried first.

Why 45° rather than "as steep as it can get": for a given lateral offset the 45°
point is the highest joint the lean ceiling allows (the ceiling is
`drop >= lateral`), so it ends the diagonal soonest, starts the vertical
earliest, and has the shortest diagonal of any legal leg to that column.

The lean then escalates — 45°, then 60°, then 75° — **only** when no 45° leg
reaches a clear column. A tip sitting just above a wide obstacle has no 45° leg
at all (measured: one such fixture grazes the clearance by 0.01 mm), and a
slightly shallower diagonal still ends in a single joint and a vertical drop.

The walk is bounded three ways: by the lateral envelope
(`min(72, max(48, verticalSpan × 2.5))` mm), by the height available above the
root, and by `MAX_PROBES` (900). The probe count comes back with the result, so
callers and tests can hold a placement to a bound instead of trusting a comment.

## Judging a candidate

`resolveBase` decides where the root lands and therefore where the vertical leg
ends. With the grid on it snaps to the nearest legal node within
`MAX_BASE_SEARCH_RINGS` (4): legal means the roots volume fits and the leg from
the joint reaches it without clipping, and among legal nodes the one nearest
directly under the joint wins, so the last leg stays as vertical as the grid
allows. With the grid off the joint's XY is continuous and is used as is.

The committed chain is then checked as a whole:

- The diagonal against its own lean plus a float-noise epsilon. It is the one
  segment exempt from the length-aware tightening, and the exemption reaches
  exactly as far as the angle the search chose.
- The vertical leg (joint to root) against the length-aware rule with the
  configured routed-trunk angle (`max(15, 90 - grid.minRoutedTrunkAngleDeg)`) as
  its floor and the routing detour slack on top. This is the span that carries
  the load, so it is the one held to the configured angle.

## The socket and the cone are one decision

`resolveConeSocketAndAxis` resolves them together, because the builder renders
the cone along the direction from the cone start to the socket. With a joint to
aim at, the socket moves onto the line toward that joint, so the cone and the
first shaft segment form one line; the move is clamped to
`MAX_CONE_AXIS_DEVIATION_FROM_SURFACE_NORMAL_DEG` because the contact disk is
oriented along the surface normal. With no joint the socket stands and the axis
follows it.

Reporting a shaft-aligned axis while leaving the socket on the pre-routing axis
is what the previous engine did, and the builder then silently replaced the axis
with its own derivation. There is now one authority for the pair.

## Shared geometry rules

These still apply and are shared with the manual placement paths.

### Shaft clearance

The clearance passed to every collision query is
`shaft diameter / 2 + COLLISION_AVOIDANCE_MM` (0.48).

### Roots volume

The root is a disk plus a cone. Each height slice is sampled as the circle the
root actually occupies at that height, with the whole circle tested against the
same 0.48 mm safety margin, plus the bounding-ball early-out the 1-Lipschitz SDF
allows (if the slice centre is further out than the slice radius plus the
margin, no perimeter point can be blocked).

### Segment angle gates

A segment's allowance is length-aware: up to 3 mm a segment may sit at 60° from
vertical, from 3 to 5 mm it tapers back to the base angle, and longer spans
tighten further at 3° per mm, floored at the angle the app configures for routed
trunks. The first segment below the socket additionally gets the socket-elbow
allowance.

### Cone axis policy

`resolveConeAxisPolicy` (`ConeAxisPolicy.ts`, shared) derives the pre-routing
cone axis from the surface normal and `tip.coneAngleMode`. Under the default
`adaptive` mode the axis is rotated toward vertical and clamped to a 30°
deviation from the normal, so at a wall or a steep shoulder it can point into
the surface the cone is stuck to. It is a cone policy and an input to nothing
route-related: the shaft leaves along the surface normal, and the router's
resolved axis wins for the rendered cone.

## Debug

`SmartPlacementV3` is the only publisher of the pathfinding debug snapshot
(`pathfindingDebugState.ts`), which `SupportPathfindingDebugOverlay` and the HUD
render. It publishes the resolved socket, the chain, the base, and an outcome of
`straight`, `routed` or `blocked` with a reason string naming what stopped it
(`no joint reached a clear column`, `no committed base under the joint`, or the
rejected-chain case). `passes` is empty: there is no lattice search left to
visualise. `useTrunkPlacement` clears the snapshot when hover ends.

## Implementation references

- `src/supports/PlacementLogicV3/SmartPlacementV3.ts` — the entry point
- `src/supports/PlacementLogicV3/EscapeJointSearch.ts` — the route search
- `src/supports/PlacementLogic/Pathfinding/SDFCache.ts` and `SDFCachePool.ts` — the collision oracle
- `src/supports/PlacementLogic/StandardPlacement.ts` — the socket/cone baseline the router starts from
- `src/supports/PlacementLogic/smartPlacementSearchUtils.ts` — the angle gates
- `src/components/scene/SupportPathfindingDebugOverlay.tsx` — the debug view

## What was removed, and why it should not come back

The trunk router used to be a chain of engines: a discrete A* over an SDF
lattice, a potential-field integration, a deterministic gradient march, and a
rescue candidate sweep, each with its own caches, budgets, tuning profiles and
idea of a valid route. They disagreed often enough that the same contact could
come back as one diagonal or as a five-joint contour hug, and the machinery to
reconcile them (warm starts, stagnation caches, joint-minimisation passes, fold
reshaping) cost more than the answer.

Rules that follow from this:

- **One route shape.** No multi-joint chains, no lattice searches, no
  contour-following, no per-placement expansion budgets, no warm starts or
  stagnation caches.
- **One collision oracle.** Everything asks `SDFCache`; `CollisionAvoidance`
  shares the same pool, so routing and manual placement cannot disagree about
  the geometry.
- **Bounded, reported cost.** Any new step needs a cap and a way to show what it
  spent. An unbounded search is how the previous system became unpredictable.
