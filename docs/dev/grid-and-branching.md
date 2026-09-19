# Grid and Branching

Grid support logic ensures deterministic trunk ownership and efficient branch reuse.

## Grid placement policy

0. Build the candidate through the router, like every other mode. Grid mode used to
   build it with no mesh, i.e. a straight pillar, which could not reach a tip under an
   overhang at all: the pillar pierced the model, the collision gate refused the node,
   and the tip went unsupported.
1. Route to a node, not just to a clear column. Grid mode's search walks the lattice
   nearest-first and derives the joint from the node it accepts, so the drop lands on
   that node and the load-bearing leg is exactly vertical. The base never walks outward
   to a different node: if the node under the joint cannot take the base, the answer is
   a different joint, not a longer lean.
2. If a trunk already stands on that node, join that tree: attach as a branch or leaf.
3. A trunk on the node is never replaced, whatever the new contact's height. A taller
   contact becomes a branch on the existing pillar so the pillar keeps serving every
   contact it already carries.
4. Search alternate nodes only when no same-node trunk ownership applies.
5. The grid is dropped when it cannot be met at 45° or steeper. A contact low to the
   plate beside a node a couple of millimetres out has no height left for the trunk
   diagonal, so a base held to that node is not a straight drop any more: the builder
   draws a vertical leg plus a short closing member, and that closing member comes out
   near-horizontal (measured at 74° from vertical on a 6mm contact). The router
   resolves the placement with the grid out instead (`TrunkPlacementResult.gridIgnored`,
   carried onto the route), the base lands under the contact's own column, and the drop
   stays vertical or a proper 45° diagonal. The decision never snaps such a route back
   onto a node, and it never invents one: the flag is the signal.
6. A node that already holds a trunk is an occupied point, even when the map misses it.
   Each trunk is indexed by both ends it has: where the pillar stands (its root) and the
   point it serves (its contact). A root-only index goes wrong twice over — a root
   sitting between nodes (hand placed, or placed before the spacing changed) is keyed to
   a neighbour, and a base routed off the grid (policy 5) stands a shaft height away
   from its own contact, so the point that trunk serves looks free and the next contact
   there gets offered a second pillar overlapping the first. Within half a step of the
   node centre, measured to whichever end is nearer, the trunk standing there takes the
   merge (branch or leaf); grid mode never replaces a trunk, and a second pillar beside
   the first is a preview that gets refused rather than a placement. A short graft into
   a trunk on an occupied node may lean like a socket elbow (≤3mm, ≤75° from vertical) —
   the bound the rest of the system gives a short member under a contact — because
   refusing it leaves the tip unplaced with no second pillar to fall back to.

## Branch support contract

- Branches attach to host shafts instead of the build plate.
- Branches may chain recursively from trunk to branch to branch.
- Branch joints must be reprojected whenever parent shaft geometry changes.

## Node ownership contract

- A grid node is owned by the trunk standing on it. A new candidate that snaps to an
  occupied node attaches to that trunk; it never removes or rebuilds it.
- Placement resolves to the nearest legal node when the preferred one cannot take the
  attachment, and only then.
- This used to be a promote path that tore the host trunk out and rebuilt the node
  around the new contact. The code for it is gone: rehosting dependents onto a
  replacement pillar was more ways to lose supports than the shape it bought.

## Known risk areas

- Front-most vs nearest snapping ambiguity in dense overlap scenes
- Segment ID collisions causing incorrect preview endpoint resolution
- Joint snapping instability under rapid topology edits

## Related

- [Support System](support-system.md)
- [Architecture Overview](architecture-overview.md)
- [Support Placement](../workflows/support-placement.md)

Reference issues are tracked in historical docs and issue tracker; keep this page focused on invariant behavior.
