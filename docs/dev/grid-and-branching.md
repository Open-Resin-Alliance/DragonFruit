# Grid and Branching

Grid support logic ensures deterministic trunk ownership and efficient branch reuse.

## Grid placement policy

1. Resolve candidate to preferred snapped grid node.
2. If same-node trunk exists, join that tree.
3. Compare contact heights for trunk replacement vs new branch behavior.
4. Search alternate nodes only when no same-node trunk ownership applies.

## Trunk replacement contract

When a new candidate at the same node is higher than current trunk contact:

- replacement planning and execution should occur in trunk replacement modules
- dependents are rehosted before old trunk removal
- history records single coherent action

## Branch support contract

Branches attach to host shafts and may chain recursively (branch-on-branch).
Branch joints constrained to host shaft geometry must be reprojected when parent geometry changes.

## Known risk areas

- Front-most vs nearest snapping ambiguity in dense overlap scenes
- Segment ID collisions causing incorrect preview endpoint resolution
- Joint snapping instability under rapid topology edits

Reference issues are tracked in historical docs and issue tracker; keep this page focused on invariant behavior.
