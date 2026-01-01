# Grid Supports (Self-Contained) — Development Plan

## Overview
Grid Supports are a *behavior layer* that changes what happens when you place or delete supports **at the build-plate level**.

In plain terms:

- When Grid is **off**, placing a support works normally.
- When Grid is **on**, the support’s *base location* is snapped to an XY grid.
- If you try to place a support on a grid location that already has a support “owning” that grid node, the newly placed support should **not** create a new independent trunk. Instead, it should become a **branch** connected to the existing trunk for that node.
- If the trunk that owns a grid node is deleted, Grid logic can (optionally) **promote** another member at that node into the new trunk, and reconnect the rest.

The critical requirement is that **Grid logic must be self-contained**. That means:

- All grid snapping, node membership, merge rules, and promotion rules live in a dedicated Grid module.
- Other systems (Trunk placement, delete flow, history) should call a small set of Grid module functions and not contain “grid rules” directly.

This plan builds Grid in a way that:

- Works with your current supports architecture (Roots/Trunk/Branch/Knot…)
- Reuses existing placement/collision utilities where appropriate
- Keeps all Grid-specific decision-making in one place

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 1: Define the Grid module boundaries (self-contained API)**
  - [ ] Create a feature folder: `src/supports/PlacementLogic/Grid/`
  - [ ] Add a single public entry file (barrel) that exposes a minimal API (no callers reaching into internal files)
  - [ ] Decide what data Grid needs as input (settings + current support state + the “candidate” placement)

- [ ] **Phase 2: Grid snapping + node identity**
  - [ ] Implement grid snapping helpers (snap x/y to spacing)
  - [ ] Define a stable `GridNodeKey` representation (string or integer pair)
  - [ ] Define tolerance rules (or avoid tolerances by using index-based keys)

- [ ] **Phase 3: Placement integration (merge rules)**
  - [ ] Implement `GridPlacementDecision` return type:
    - new trunk
    - new branch attached to an existing trunk
    - rejected (with a reason)
  - [ ] Implement Grid logic to detect if a node is “occupied” and identify the owning trunk
  - [ ] Implement branch attach decision (where on the trunk to attach) using Grid-owned rules + settings

- [ ] **Phase 4: Collision/validation compliance (no special cases outside Grid module)**
  - [ ] Add a “validate candidate branch path” step inside Grid module (reusing collision utils)
  - [ ] If invalid, Grid module searches alternative attachment points (up/down the trunk) until valid or fails

- [ ] **Phase 5: Commit wiring (small integration points only)**
  - [ ] In trunk placement commit: call Grid module, then execute returned decision
  - [ ] Ensure history payloads reflect what actually happened (trunk add vs branch add)

- [ ] **Phase 6: Deletion integration (promotion vs cascade)**
  - [ ] Add a Grid deletion hook: when deleting a trunk, allow Grid module to intercept
  - [ ] Implement optional promotion behavior:
    - choose next “best” member at the node
    - rebuild it into a trunk
    - reconnect remaining members as branches
  - [ ] If promotion fails, fall back to your existing safe cascade deletion

- [ ] **Phase 7: Settings + UX**
  - [ ] Extend Grid settings beyond spacing (only in settings types + Grid settings UI):
    - min attach height
    - attach search range
    - min branch angle (if needed)
    - delete behavior toggle (cascade vs promote)
  - [ ] Confirm defaults are conservative (Grid off by default)

- [ ] **Phase 8: Regression checks**
  - [ ] Grid off: trunk/branch/leaf/brace/twig/stick placement unchanged
  - [ ] Grid on: repeated placements on same node create branches instead of new trunks
  - [ ] Delete trunk (grid off): cascade deletion still correct
  - [ ] Delete trunk (grid on, promotion enabled): promotion produces a valid graph and undo/redo restores it

## Technical Details

### Relevant Existing Files (Callers)
These are the files that should *call into* Grid logic, but should not implement Grid rules themselves:

- Trunk placement commit:
  - `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`
- Delete flow:
  - `src/features/supports/useSupportInteractionManager.ts`
- Store mutations (authoritative state changes):
  - `src/supports/state.ts`
- History payloads:
  - `src/supports/history/actionTypes.ts`
  - `src/supports/history/useSupportHistoryHandlers.ts`
- Settings store + UI:
  - `src/supports/Settings/types.ts`
  - `src/supports/Settings/defaults.ts`
  - `src/supports/Settings/components/GridSettingsCard.tsx`

### Proposed Folder Structure (Self-Contained)
Create a dedicated feature folder (domain-appropriate; not a generic utils bucket):

- `src/supports/PlacementLogic/Grid/`
  - `index.ts` (public API)
  - `types.ts` (Grid-only types)
  - `gridMath.ts` (snap + key helpers)
  - `gridPlacement.ts` (merge decision)
  - `gridAttachment.ts` (pick knot position on trunk + validation)
  - `gridPromotion.ts` (delete-time promotion behavior)

Only `index.ts` should be imported by non-Grid code.

### Proposed Public API
(Names can change; the key is keeping the interface small.)

- `decideGridPlacement(args) -> GridPlacementDecision`
  - Input:
    - `settings` (grid settings + relevant support settings)
    - `supportStateSnapshot` (current trunks/roots/branches/knots)
    - `candidateTrunkBuildResult` (the trunk you would have placed normally)
    - `mesh` (optional, for collision checks)
  - Output:
    - `place_trunk` (possibly with snapped root)
    - `place_branch` (knot + branch payload)
    - `reject` (with reason)

- `tryPromoteOnTrunkDelete(args) -> GridPromotionResult | null`
  - Input:
    - `settings` (including delete-mode toggle)
    - `supportStateSnapshot`
    - `trunkIdToDelete`
  - Output:
    - `null` meaning “Grid did not handle it; do normal cascade delete”
    - or a payload describing:
      - what to remove
      - what to add
      - what to reconnect

### Node Identity
Avoid tolerance-based matching if possible.

- Use integer indices:
  - `gx = round(x / spacing)`
  - `gy = round(y / spacing)`
  - Key: `${gx},${gy}`
- To reconstruct snapped coords:
  - `x = gx * spacing`
  - `y = gy * spacing`

This makes membership stable and deterministic.

### Attachment (Branch Creation)
Grid module should own how a new member attaches to the trunk:

- Start with a policy like:
  - attach near base but above a minimum height
  - if collision/invalid, scan upward/downward along trunk segments
- Represent the attachment as a `Knot` with:
  - `parentShaftId` (segment id)
  - `t` (0–1 along that segment)
  - `pos` computed from endpoints

### Collision/Validation
Grid module should reuse your existing collision checks (do not duplicate):

- `src/supports/PlacementLogic/CollisionUtils.ts`
- Potentially bezier collision checks if needed

Validation should happen before returning a `place_branch` decision.

### History Expectations
Grid placement can result in either:

- `SUPPORT_ADD_TRUNK` (normal trunk placement)
- `SUPPORT_ADD_BRANCH` (grid merge placement)

So the trunk placement caller should:

- call Grid module
- then push the history action corresponding to the decision

### Promotion Expectations (Delete)
Promotion is optional and can be added after basic placement merge works.

If implemented:

- On delete trunk:
  - Grid module identifies node members
  - choose replacement candidate (e.g., highest attachment / highest tip)
  - rebuild as trunk
  - reconnect other members as branches

If promotion is disabled or fails:

- fall back to existing safe cascade delete
