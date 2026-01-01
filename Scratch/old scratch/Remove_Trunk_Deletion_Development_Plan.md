# Remove Trunk Deletion — Development Plan

## Goal
Implement trunk deletion in a way that **never leaves broken references** (dangling knots/branches/leaves/braces), and that can later be extended to support **Grid trunk promotion** (delete trunk → promote next-highest member at the grid node).

## Context (Current Data Model)
- A **Trunk** has `segments[]` and references a `rootId`.
- **Knots** attach to a host shaft segment via `knot.parentShaftId` (+ `t` + `pos`).
- **Branches/Leaves/Braces** attach via `parentKnotId` / `startKnotId` / `endKnotId`.
- `removeBranch()` already performs **cascade deletion** by removing:
  - the branch,
  - its `parentKnotId`,
  - knots on its segments,
  - and any dependent branches/leaves/braces recursively.
- `removeTrunk()` currently deletes only the trunk and its roots, which can leave:
  - knots whose `parentShaftId` references deleted trunk segments,
  - and dependent branches/leaves/braces referencing those knots.

## Desired Behavior (Non-Grid)
When deleting a trunk in the current system, the safe default behavior should be:

- Delete the trunk and its `Roots`.
- Delete all **dependent attachments** that cannot exist without the trunk:
  - Knots hosted on trunk segments
  - Any branches attached to those knots (and their downstream descendants)
  - Any leaves attached to those knots
  - Any braces using those knots

This ensures deletion does not corrupt the supports graph.

## Desired Behavior (Grid-Compatible)
Grid supports will require special behavior on trunk deletion:

- If the trunk is part of a **grid node**, deleting it may instead:
  - Promote a remaining member to become the new trunk, and
  - Reattach remaining members as branches.

Therefore, trunk deletion should be implemented so that:

- There is a single, well-defined internal step that gathers the “dependent set” for a trunk.
- That step can later be overridden or short-circuited for grid promotion.

## Implementation Strategy

### Phase 1 — Make trunk deletion safe (cascade delete)
**Files likely involved**
- `src/supports/state.ts` (authoritative mutation logic)
- `src/features/supports/useSupportInteractionManager.ts` (calls `removeTrunk` and pushes history)
- `src/supports/history/useSupportHistoryHandlers.ts` (undo/redo compatibility)

**Approach**
1) Add a helper that computes dependency sets for a trunk:
   - Collect trunk segment IDs
   - Find all knots where `knot.parentShaftId` is in trunk segment IDs
   - From those knots, derive:
     - Branches whose `parentKnotId` is one of those knots
     - Leaves whose `parentKnotId` is one of those knots
     - Braces whose `startKnotId` or `endKnotId` is one of those knots

2) Cascade deletion behavior
   - For each “directly attached” branch found in step (1), call the existing `removeBranch()` logic (or inline equivalent) so downstream trees are removed safely.
   - Remove directly attached leaves/braces tied to trunk-hosted knots.
   - Remove the trunk-hosted knots themselves.
   - Finally remove the trunk and its root.

3) Ensure selection clearing is correct
   - If selected item is trunk/root/any removed branch/brace/leaf/knot/segment/joint, clear selection.

4) History payload expectations
   - Current history action `SUPPORT_REMOVE_TRUNK` only stores `{ trunk, root }`.
   - After cascade deletion, this will no longer be sufficient to undo a trunk delete.

**Decide on history design now (recommended):**
- Extend `SUPPORT_REMOVE_TRUNK` payload to include removed dependents:
  - `branches`, `braces`, `leaves`, `knots` (at minimum)
  - Possibly also `twigs/sticks` if they can attach (currently they are mesh-to-mesh, so likely unaffected)

Then:
- Forward delete: `removeTrunkCascade(trunkId)`
- Undo: re-add root + trunk + all dependent entities

### Phase 2 — Add invariants / safety checks
Add internal assertions (or at least defensive cleanup) so after trunk deletion:
- No `knot.parentShaftId` references a missing segment
- No branch/leaf/brace references a missing knot

If any are found, delete them as part of the deletion pass.

### Phase 3 — Grid compatibility hook (design-only for now)
To support Grid promotion later, trunk deletion should be structured like:

- `removeTrunk(trunkId)`
  - If trunk is a grid trunk and grid promotion is enabled:
    - attempt promotion
    - if promotion succeeds: do not cascade-delete dependents
    - if promotion fails: fall back to cascade delete
  - Else:
    - cascade delete

This requires (later) a way to identify grid membership (e.g., `gridNodeKey` on trunks/branches or a `GridNode` record).

## Validation / Test Checklist
Manual regression tests after implementing safe trunk deletion:

1) **Delete trunk with no attachments**
- Trunk and root removed
- No other supports removed

2) **Delete trunk with one branch attached**
- Branch removed
- Branch’s parent knot removed
- Any child branches/leaves/braces downstream removed
- No dangling knots remain

3) **Delete trunk with braces attached via trunk-hosted knots**
- Brace removed
- Its knots removed (if they are trunk-hosted)
- No orphan braces remain

4) **Delete trunk with leaves attached**
- Leaves removed
- Their knots removed

5) **Undo/Redo**
- Undo restores trunk+root+all removed attachments
- Redo removes them again

6) **Selection**
- If selected item was deleted, selection becomes null
- No errors from renderers that expect existing ids

## Notes / Non-Goals (for this phase)
- Do not attempt to “reattach” branches/leaves/braces to other supports on trunk deletion (non-grid).
- Promotion behavior is deferred until Grid feature work, but this deletion implementation must be structured so promotion can later intercept it.
