# Stepwise Trunk Diameter With Constrained Joints — Development Plan

## Overview
This feature fixes the current “diameter swap / shrinking” behavior and replaces it with a predictable rule:

- A trunk can have **multiple shaft diameters along its height**.
- The trunk diameter is **piecewise constant** (no taper inside a segment).
- The trunk becomes thicker only where it needs to “support” thicker branches, and it can become thinner again above those points.

## Background / Handoff Context (Read This First)

This plan is being written as a handoff to the next agent.

### What we built immediately before this plan

We recently completed a set of Grid + trunk-graph behaviors that now work well and should be treated as stable baseline:

- **Grid trunk promotion (tallest contact wins)**
  - When Grid mode places a new contact at an existing grid node that is higher than the trunk’s current contact, we do a **trunk replacement** instead of placing a branch.

- **TrunkReplacement module (planner + apply)**
  - The authoritative logic lives under `src/supports/SupportTypes/Trunk/TrunkReplacement/`.
  - It rehosts dependents onto the new trunk before removing the old trunk, preventing cascade-delete side effects.
  - Undo/Redo is handled as a **single atomic step** using before/after snapshots.

- **Trunk deletion promotion (delete trunk -> promote next-highest branch)**
  - When deleting a trunk, we attempt to promote the highest-contact **direct child branch** into a new trunk.
  - If no eligible direct child branch exists, we fall back to safe cascade trunk deletion.
  - This also uses the same snapshot-based trunk replacement flow for undo/redo.

Backups were taken after these milestones (most recently `v96`).

### What problem remains (the diameter behavior is broken)

Right now, when placing Grid supports of different diameters on the same connected trunk/tree, users see inconsistent results:

- Placing a **small** support then placing a **larger** one can cause the small one to grow but the new larger one to shrink.
- Doing it in the opposite order can produce the inverse behavior.
- The result looks like diameters are **swapping** rather than converging on a correct outcome.
- In addition, the **contact cone / socket area** can become visually mismatched after diameter changes ("messy" cone/shaft transitions).

These symptoms indicate we currently do not have a coherent, height-aware model for how trunk diameter should behave when multiple branches of different diameters attach at different heights.

### How to reproduce the bug (current behavior)

The easiest repro is in **Grid mode**, using two placements on the same trunk/tree with different shaft diameters:

- Repro A (small then large)
  - Place a Grid support with a **smaller** shaft diameter low on the model.
  - Place a second Grid support higher on the model with a **larger** shaft diameter.
  - Current result (broken): the first (small) support grows, but the new large one can shrink; looks like they swapped.

- Repro B (large then small)
  - Place a Grid support with a **larger** diameter first.
  - Place a second Grid support higher with a **smaller** diameter.
  - Current result (broken): the second (small) often becomes correct, but the original (large) can become wrong; contact cone/socket visuals can look mismatched.

This order-dependence is a strong signal that we are computing/applying diameter changes off the wrong snapshot, the wrong owner, or without recomputing dependent primitives consistently.

### Where we are “picking up from” in the code (entry points)

The next agent should start investigation and implementation from these flows:

- Grid placement decisions and commit:
  - `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`
    - `decision.kind === 'place_branch'` currently:
      - adds knot + branch
      - then computes a max diameter and applies it to the host trunk
    - `decision.kind === 'replace_trunk'` currently:
      - materializes a promoted branch
      - uses the TrunkReplacement planner+apply flow

- Trunk replacement apply (also where a trunk diameter is being applied today):
  - `src/supports/SupportTypes/Trunk/TrunkReplacement/applyTrunkReplacement.ts`
    - currently computes a max connected diameter and applies it to the new trunk
    - this is a prime location where “wrong snapshot / wrong diameter source” can cause the swap behavior

The new approach (stepwise profile) will ultimately replace the “apply one max diameter” behavior in these paths.

### Why we are changing the model (what “correct” means)

The correct behavior is not “one max diameter for the whole connected tree.”

Instead:

- A trunk should be thick only where it needs to carry thicker attachments.
- The trunk may become thinner again above a heavy attachment, so the upper trunk matches the style/diameter of what it is supporting above.

This requires a **stepwise trunk diameter profile** (piecewise-constant trunk segments), where step boundaries occur at meaningful heights.

### Demand source of truth

When we say “heavy/medium/light,” those are stand-ins for **larger or smaller branch shaft diameters**.
The source of truth for “demand” is:

- **Branch demand diameter = the branch shaft diameter** (effectively `max(segment.diameter)` on that branch).

### Confirmed trunk diameter profile rules (user-approved)

- A trunk becomes thicker **only because of branches that attach to the trunk**.
- A branch must attach where the trunk is already thick enough for that branch.
- The trunk diameter at the **exact attachment point** (the knot height) must be thick enough for that branch.
- If a branch needs a thicker trunk, that thickness extends **up to that branch’s attachment height**, and the trunk may become thinner again above it if the branches above do not require the thicker diameter.
- Step boundaries are anchored at the **branch attachment point on the trunk** (the trunk-hosted knot).
- At a step boundary (a joint where diameter changes), the **joint matches the thicker side**.
- If an attachment occurs exactly at a step boundary, associate it to the **thicker side** (the side it needs).

### Definition of Done (for the next agent)

This project is done when the following are true:

- The order-dependent diameter swap bug is gone.
- Trunks can have multiple diameter “steps” by height, based on attached branch shaft diameters.
- Steps occur at meaningful heights via constrained trunk joints (or an agreed minimal alternative).
- Visual consistency is preserved:
  - trunk segments and joints look consistent
  - trunk contact cone/socket does not look mismatched after diameter changes
- Undo/Redo works as a single coherent operation for:
  - Grid branch placement
  - trunk replacement
  - trunk joint creation/deletion affecting diameter steps

---

### What the user will experience
When you place supports on the same trunk (especially in Grid mode), the trunk will adapt:

- If you add a branch with a larger shaft diameter, the trunk below that branch becomes thicker.
- If you add a smaller branch higher up, the trunk above the “heavy” branch can become smaller again.
- Diameters will not appear to “swap” between supports.
- Contact pieces (joints and contact cones) will remain visually consistent with the segment diameters.

### Key design decision
We will not invent a brand-new “hybrid joint/knot” primitive. Instead, we will introduce the concept of a **constrained trunk joint**:

- It is a normal trunk joint/segment boundary.
- It may be created automatically at certain heights.
- When edited, it follows constraints (ex: can move only along the trunk axis, or its position is snapped/clamped to an intended boundary height).

This retains compatibility with:

- Existing joint rendering and history
- Curved trunk segments (Bezier)
- Existing segment-level editing workflows

---

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 0: Stabilize the current diameter bug (stop the swapping behavior)**
    - [x] Identify the root cause of “diameter swaps” after Grid placements / trunk replacement (wrong snapshot timing, wrong target trunk, inconsistent cone/joint updates, etc.)
    - [ ] Add minimal diagnostics (logs) if needed to confirm the failing path
    - [x] Fix the bug so diameter changes are at least monotonic and applied to the intended support
    - [x] Verify with the two reported placement orders (small-then-large and large-then-small)

- [x] **Phase 1: Define the stepwise trunk diameter rules (the new contract)**
    - [x] Define how we interpret “demand” (source of truth = **branch shaft diameter**; also include trunk contact diameter as a demand)
    - [x] Define propagation: trunk diameter at a height must be >= max demand of attachments above that height
    - [x] Define where step boundaries occur by height (use the **attachment point on the trunk**: the trunk-hosted knot position, not the support tip/contact point)
    - [x] Define how deletion interacts with the system:
        - [x] Deleting a diameter-boundary joint is allowed; trunk is recomputed and may become “coarser” (thicker across a merged span)
    - [x] Define curved-segment policy for splitting (initially: implement correct Bezier splitting or apply a safe fallback)

- [ ] **Phase 2: Compute and apply a trunk “diameter profile”**
    - [ ] Create a single function that computes a per-height profile for a trunk (a set of boundary heights and required diameters)
    - [ ] Apply the profile to the trunk by:
        - [ ] Ensuring trunk has segment boundaries at the required heights (insert joints as needed)
        - [ ] Assigning each trunk segment a single diameter value
        - [ ] Updating joint diameters to match adjacent segments (consistent visual + picking radius)
        - [ ] Updating trunk contact cone socket/joint/contact rendering parameters so the tip doesn’t look mismatched

- [ ] **Phase 3: Constrained trunk joints (behavior + UX constraints)**
    - [ ] Add metadata to trunk joints/segments indicating “diameter-boundary / constrained”
    - [ ] Update joint selection/gizmo rules:
        - [ ] If constrained: movement is restricted (axis-only, or height-snapped)
        - [ ] Optional: if constrained joints are intended to be non-selectable, suppress them in picking/selection
    - [ ] Ensure undo/redo works for:
        - [ ] auto-joint insertions
        - [ ] diameter updates
        - [ ] joint deletion merges

- [ ] **Phase 4: Integration points (make it run automatically when needed)**
    - [ ] After Grid branch placement (and standard branch placement): recompute trunk diameter profile for the host trunk
    - [ ] After trunk replacement (promote): recompute diameter profile on the resulting trunk
    - [ ] After joint creation/deletion on trunk: recompute diameter profile on that trunk
    - [ ] After knot movement (if trunk-hosted knots can slide): recompute affected trunk

- [ ] **Phase 5: Validation scenarios (manual)**
    - [ ] Small diameter low, large diameter high: trunk becomes large below the high branch; nothing shrinks incorrectly
    - [ ] Large diameter low, small diameter high: trunk large below the low branch; trunk may be smaller above it
    - [ ] Multiple mixed diameters at multiple heights: trunk shows multiple step sections
    - [ ] Delete a diameter-boundary joint: trunk recomputes cleanly (no broken references, no wild diameters)
    - [ ] Curved trunk segments: splitting preserves curve or uses the agreed fallback without corrupting geometry
    - [ ] Undo/Redo: all above scenarios return to previous state exactly

---

## Technical Details

### Relevant files (current state)
- Trunk placement + Grid replacement commit:
  - `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`
- Trunk replacement module:
  - `src/supports/SupportTypes/Trunk/TrunkReplacement/planTrunkReplacement.ts`
  - `src/supports/SupportTypes/Trunk/TrunkReplacement/applyTrunkReplacement.ts`
- Existing “max diameter” helpers (to be replaced/extended):
  - `src/supports/SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter.ts`
- Joint creation/deletion (trunk) and history:
  - `src/supports/SupportPrimitives/Joint/useJointCreation.ts`
  - `src/features/supports/useSupportInteractionManager.ts`
  - `src/supports/state.ts`
  - `src/supports/history/useSupportHistoryHandlers.ts`

### Proposed new logic (high level)

#### 1) Diameter demand collection
For a given trunk:

- Gather all trunk-hosted knots.
- For each trunk-hosted knot, gather any attached branches.
- Step boundary height uses the trunk-hosted knot position (attachment point) rather than the support tip contact.
- For each attachment, compute a “demand diameter”:
  - **Branch demand**: `max(segment.diameter)` of that branch (or a chosen representative shaft diameter).
- Include the trunk’s own contact requirement (trunk tip segment/contact diameter) as a demand at the top.

#### 2) Convert demands to a step profile
Represent the profile as ordered boundaries:

- Boundary = a height `z` where the required diameter changes.
- Between two boundaries, diameter is constant.

A simple interpretation:

- Sort demands by `z`.
- For each height, required diameter below that height is the max of all demands at or above that height.

#### 3) Enforce boundaries via real joints
To make steps occur at exact heights:

- If a trunk segment spans a boundary height, split it by inserting a new trunk joint at that boundary.
- For straight segments: split at the correct `t`.
- For Bezier segments: either split the curve correctly (preferred) or use the agreed fallback.

#### 4) Apply diameters and update dependent geometry
- Assign diameters to the resulting segments based on the profile.
- Ensure joint diameters are consistent.
- Ensure trunk contact cone/socket visuals remain consistent (no “messy mismatch”).

### Constrained joint definition
We will use normal trunk joints with added constraints:

- Metadata tag: indicates the joint is used as a diameter boundary.
- Gizmo constraint: restrict joint movement.
- Deletion policy: deletion allowed; after deletion, trunk profile is recomputed and may merge steps.

### History / Undo strategy
Prefer atomic actions that store before/after snapshots (similar to `SUPPORT_REPLACE_TRUNK`) when auto-splitting + multi-object updates happen, to avoid partial undo states.

## Current Session Handover Notes (Dec 2025)

### Confirmed code behavior that affects the design

- **`updateTrunk(trunk)` recomputes trunk-hosted knots**
  - It finds all knots whose `parentShaftId` matches any trunk segment id.
  - It recomputes knot `pos` using `knot.t` + `calculateKnotPositionOnSegmentFromT(...)`.
  - It recomputes knot `diameter` as `seg.diameter + 0.1`.
  - Therefore, trunk profile application must focus on:
    - correct segment diameters
    - correct knot hosting (`parentShaftId`) and `t`
    - then let `updateTrunk` recompute positions/diameters.

- **`splitShaft(...)` exists and preserves Bezier geometry if given `splitT` and `root`**
  - API: `splitShaft(trunk, segmentId, splitPoint, splitT?, root?)`.
  - For Bezier segments with `splitT`+`root`, it subdivides the curve exactly.
  - It creates a new joint whose initial `diameter` is `getJointDiameter(originalSegment.diameter)`.
  - After splitting, we still must reassign joint/segment diameters based on the trunk profile rules.

### Concrete Phase 2 implementation plan (hand-over ready)

#### 1) Profile boundaries (where steps occur)
- Step boundaries are at **trunk-hosted knot heights that have attached branches**.
- A trunk-hosted knot is any `knot` whose `parentShaftId` matches one of the trunk segment ids.
- “Has attached branches” means at least one branch exists where `branch.parentKnotId === knot.id`.
- Also include a top “demand” for the trunk tip/contact cone:
  - Demand = `max(trunk.contactCone.profile.bodyDiameterMm, trunk.contactCone.profile.contactDiameterMm, trunk top segment diameter)`.

#### 2) Diameter demand and propagation rule
- **Branch demand diameter** (per user-approved contract): `max(branch.segments[].diameter)`.
- **Propagation**: at any height, trunk diameter must be the max of all demands at or above that height.
- This yields a piecewise-constant diameter per interval between boundaries.

#### 3) Applying the profile requires real segment splits + knot rehosting
- For each boundary knot:
  - Find its hosting trunk segment + its `t`.
  - If the knot is effectively at segment endpoints (`t ~ 0` or `t ~ 1`), avoid splitting and (if needed) rehost to the adjacent segment.
  - Otherwise, split that segment at the knot location:
    - Compute `splitPoint = knot.pos`.
    - Compute `splitT = knot.t` (or derive a safe fallback if missing).
    - Call `splitShaft(nextTrunk, seg.id, splitPoint, splitT, root)`.

- **Knot rehosting & `t` rescaling (critical)**
  - When splitting a segment at `splitT`:
    - The bottom segment keeps the original segment id (per `splitShaft`).
    - The new top segment gets a new id.
  - For every trunk-hosted knot that was on the original segment:
    - If `t < splitT`: keep on bottom segment, set `t' = t / splitT`.
    - If `t > splitT`: move to top segment, set `t' = (t - splitT) / (1 - splitT)`.
    - If `t == splitT` (within epsilon): treat as attaching to the **thicker side** and set:
      - `parentShaftId = bottom segment id`
      - `t = 1`
  - After these updates, call `updateTrunk(nextTrunk)` to recompute knot geometry.

#### 4) Joint diameter rule at boundaries
- After assigning segment diameters from the profile, assign each boundary joint diameter to **match the thicker adjacent segment**.
- If “thicker side” is consistently the segment below the boundary (typical with the propagation rule), boundary joint diameter should match the lower segment.

### Integration points to replace the current "one max diameter" logic

- **Grid branch placement**
  - File: `src/supports/SupportTypes/Trunk/useTrunkPlacement.ts`
  - Current: after `addKnot` + `addBranch`, it computes `computeMaxConnectedDiameterFromTrunk(...)` and then `applyDiameterToTrunk(...)`.
  - Replace this with: compute/apply trunk diameter profile for the host trunk.

- **Trunk replacement apply**
  - File: `src/supports/SupportTypes/Trunk/TrunkReplacement/applyTrunkReplacement.ts`
  - Current: after building/alignment it does:
    - `const maxConnectedDiameterMm = computeMaxConnectedDiameterFromTrunk(snapshot, plan.trunkToRemoveId);`
    - `applyDiameterToTrunk(alignedBase.trunk, maxConnectedDiameterMm)`
  - Replace this with: apply the trunk diameter profile to the new trunk after dependents are rehosted/added.

### History / Undo/Redo risk (must be addressed)

- Applying the profile will typically change:
  - trunk segments (splits, diameters)
  - trunk joints (new joint ids, joint diameters)
  - multiple knots (`parentShaftId` and `t` changes)
- The existing Grid add-branch history payload stores only `{ trunkUpdate: { before, after } }`.
- **If knots are modified without history coverage, undo/redo will desync.**
- Recommended solutions (pick one):
  - **Option A (preferred)**: extend the `SUPPORT_ADD_BRANCH` history payload to include `knotUpdates: { before, after }[]` and apply them in the history handler.
  - **Option B**: treat “add branch + apply trunk profile” as a snapshot-based action (store `before` and `after` snapshots like trunk replacement) and use `setSnapshot` in undo/redo.

### Work completed in code in this session (so far)

- File: `src/supports/SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter.ts`
  - Added imports needed for the upcoming profile logic:
    - `splitShaft`, `getTrunkSegmentEndpoints`, plus `Branch/Knot/Roots` types.
  - Added small helper functions/types (no call sites wired yet):
    - `branchDemandDiameterMm(...)`
    - `trunkContactDemandDiameterMm(...)`
    - `computeLinearT(...)`
    - `TrunkKnotUpdate` type
  - **No behavior was changed yet** (these are scaffolding only).

---

## Open Questions (to answer before implementation)
- Should constrained diameter-boundary joints be selectable?
- What is the initial policy for splitting Bezier segments?
- If a knot lies extremely close to an existing joint (floating point / tolerance), do we snap to the joint or still split?
