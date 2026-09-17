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
