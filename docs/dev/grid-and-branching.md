# Grid and Branching

Grid support logic ensures deterministic trunk ownership and efficient branch reuse.

## Grid placement policy

1. Resolve candidate to preferred snapped grid node.
2. If same-node trunk exists, join that tree.
3. Compare contact heights for trunk replacement vs new branch behavior.
4. Search alternate nodes only when no same-node trunk ownership applies.

## Branch support contract

- Branches attach to host shafts instead of the build plate.
- Branches may chain recursively from trunk to branch to branch.
- Branch joints must be reprojected whenever parent shaft geometry changes.

## Trunk replacement contract

- When a new candidate at the same node is higher than the current trunk contact, trunk replacement should be planned and applied as one coherent action.
- Dependents should be rehosted before the old trunk is removed.
- Undo and redo should treat the replacement as a single history event.

## Known risk areas

- Front-most vs nearest snapping ambiguity in dense overlap scenes
- Segment ID collisions causing incorrect preview endpoint resolution
- Joint snapping instability under rapid topology edits

## Related

- [Support System](support-system.md)
- [Architecture and Handoff](architecture-and-handoff.md)
- [Support Placement](../workflows/support-placement.md)

Reference issues are tracked in historical docs and issue tracker; keep this page focused on invariant behavior.
