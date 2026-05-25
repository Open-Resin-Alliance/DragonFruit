# Branch Supports

Branch supports attach to existing supports instead of the build plate. They are the tree-like extension mechanism for growing support networks from trunks or other branches.

## What they are

- A support that starts from a knot on a parent shaft.
- A support that still ends in a model contact cone.
- A first-class support type for branching structures, not a special case of trunk placement.

## Core behavior

- The contact cone touches the model surface.
- The base knot snaps to a parent trunk or branch shaft.
- Branches can chain recursively, so branch-on-branch trees are valid.

## Geometry and editing

- Branches use the same general support anatomy as trunks, minus Roots.
- Their branch joint must stay constrained to the parent shaft.
- When the parent geometry changes, descendant branches need to update with it.

## Placement summary

- The user enters the Alt placement family.
- A model-first click enters the branch flow.
- The branch is only finalized once the base knot is snapped to a valid support shaft.

## Constraints

- Branches do not start on the plate or raft.
- They should not form phantom geometry beyond the actual parent shaft.
- Recursive updates must remain undo-safe.

## Related

- [Support Placement](../workflows/support-placement.md)
- [Grid and Branching](grid-and-branching.md)
- [Support System](support-system.md)

