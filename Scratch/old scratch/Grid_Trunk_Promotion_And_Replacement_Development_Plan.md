# Grid Trunk Promotion + Trunk Deletion Replacement — Development Plan

## Overview
In Grid Support mode, multiple supports can “belong to” the same grid node (same snapped XY). Today, if a trunk already exists at a node, new placements at that node always become branches.

The goal of this work is to restore the legacy rule:

- The **trunk** at a grid node is always the member with the **highest model contact** (highest Z), based on the **raw model contact point** (the contact primitive’s `pos.z`).
- The trunk’s shaft diameter is the **largest diameter used by any member** in that node’s connected group (“heavy support diameter applies to the trunk”).

Additionally, when deleting a trunk that has dependents (branches/leaves/etc.), we do **not** want to cascade-delete dependents in certain scenarios. Instead, we want to:

- **Promote the next-highest branch** in the tree into the new trunk.
- **Reconnect the remaining tree** onto that new trunk.

A critical requirement is **compartmentalization**:

- The “promotion / rehost dependents” logic must be isolated so it can be reused:
  - when grid placement needs to promote a new trunk (tallest-wins replacement)
  - when trunk deletion needs to replace a trunk (delete trunk → promote next-highest)
- Grid placement code should not “own” deletion behavior, and deletion behavior should not “live inside” grid mode.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: Define shared domain boundaries (reusable trunk rehosting)**
  - [x] Decide and document the shared module location under the **Trunk** domain (not under Grid).
  - [x] Define the public API for:
    - [x] “promote new trunk at node and rehost tree” (grid)
    - [x] “delete trunk and replace using next-highest branch” (deletion)
  - [x] Confirm the metric for “tallest contact” is the raw model contact point Z (`contactCone.pos.z`).

- [ ] **Phase 2: Implement trunk rehost planning (pure decision layer)**
  - [ ] Implement a pure “planner” that:
    - [x] Finds all dependents hosted on a trunk (branches, leaves, braces, knots)
    - [x] Determines the highest-contact candidate for trunk promotion
    - [x] Produces a deterministic plan of:
      - [x] what to remove
      - [x] what to add
      - [x] what to update/reconnect
  - [x] Add tie-breaker rules for deterministic selection when Z is equal.

- [ ] **Phase 3: Implement trunk rehost execution (state mutation layer)**
  - [x] Implement an “apply” function that executes the plan via `src/supports/state.ts` mutations.
  - [ ] Ensure no broken references remain:
    - [ ] no branches/leaves/braces referencing missing knots
    - [ ] no knots referencing missing segments
  - [x] Decide how history should record this multi-entity change (so undo/redo works).

- [ ] **Phase 4: Grid placement integration (tallest-wins trunk replacement)**
  - [ ] Update grid placement decision so it can detect when the candidate contact is higher than the current host trunk contact at the node.
  - [ ] On click, execute trunk promotion instead of placing a branch.
  - [ ] Ensure the old trunk contact becomes a branch attached to the new trunk (same node).

- [ ] **Phase 5: Max-diameter propagation (thickest member wins)**
  - [ ] Define what “member diameter” means in V2 (likely `settings.shaft.diameterMm` used at creation time).
  - [ ] Compute max diameter for the node’s connected group and apply to trunk segments.
  - [ ] Ensure updates propagate to knots/attachments as needed (using existing `updateTrunk` behavior).

- [ ] **Phase 6: Trunk deletion replacement integration (non-grid reusable)**
  - [ ] Add a deletion path that uses the shared trunk replacement logic (delete trunk → promote next-highest branch).
  - [ ] Keep the existing cascade-delete path available for cases where replacement is not desired/possible.

- [ ] **Phase 7: Manual validation scenarios**
  - [ ] **Grid promotion**: place trunk, then place a higher support at same node → new trunk replaces old.
  - [ ] **Diameter**: place a heavy-diameter member in the node → trunk diameter increases.
  - [ ] **Deletion replacement**: delete trunk with multiple branches → next-highest becomes trunk, others reconnect.
  - [ ] **Undo/Redo**: verify multi-entity promotions and deletions restore correctly.

## Technical Details

### Relevant Existing Files
- Grid placement decision (current):
  - `src/supports/PlacementLogic/Grid/gridPlacement.ts` (`decideGridPlacement`)
- Trunk placement hook (current):
  - `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts` (`useTrunkPlacementV2`)
- Trunk/branch builders:
  - `src/supports/SupportTypes/Trunk/trunkBuilder.ts`
  - `src/supports/SupportTypes/Branch/branchBuilder.ts`
- Authoritative state mutations:
  - `src/supports/state.ts`
  - Note: `removeTrunk(...)` currently cascade-deletes dependents.

### Shared Module (Proposed)
Create a new Trunk-domain feature folder (reusable by grid + non-grid deletion):

- `src/supports/SupportTypes/Trunk/TrunkReplacement/`
  - `index.ts` (public API)
  - `types.ts` (plan/result types)
  - `planTrunkReplacement.ts` (pure planner)
  - `applyTrunkReplacement.ts` (executes plan using `state.ts`)

Rationale:
- This is trunk-specific behavior that affects the trunk’s dependent graph.
- Grid mode should call into this module rather than owning the mutation rules.

### Key Rules to Encode
- **Tallest contact wins trunk**
  - Use raw model contact point Z:
    - `Trunk.contactCone.pos.z`
    - `Branch.contactCone.pos.z`
    - (If a future type lacks contactCone, define fallback rules explicitly.)

- **Thickest member wins diameter**
  - Determine a single “member diameter” metric used for trunk sizing.
  - Apply max to trunk segment `diameter` (and any related primitives if required).

- **Deletion replacement**
  - When deleting trunk, if replacement is enabled/desired and eligible candidates exist:
    - Promote next-highest branch contact into a new trunk.
    - Reattach remaining dependents.
  - If no candidate exists, fall back to cascade delete.

### Integration Points
- **Grid promotion path**
  - Extend `decideGridPlacement` to detect “candidate higher than host trunk” at a node.
  - The placement commit (in `useTrunkPlacementV2`) should execute a “replace trunk” operation instead of `addBranch`.

- **Deletion path**
  - Introduce an alternate trunk deletion handler that uses trunk replacement.
  - Keep the cascade-delete path intact for non-replacement scenarios.

### Notes / Open Decisions (defer until implementation)
- **Braces during rehost**
  - Decide whether to preserve braces by reattaching endpoints or remove braces connected to the replaced trunk’s knots.
- **ID stability**
  - Decide whether promoted trunk keeps the original branch id (unlikely, since entity type changes) or whether new ids are created and history is used to preserve undo/redo stability.
