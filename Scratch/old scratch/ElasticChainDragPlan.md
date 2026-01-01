# Elastic Chain Drag - Development Plan

## Objective
Implement an "Elastic Chain Drag" behavior for Knots. 
When a Knot is dragged UP a trunk (or parent shaft) and causes an attached branch to exceed the critical angle limit (e.g., leaving only 10° slope), instead of blocking the Knot, the system should **push** the connected joints upwards to maintain the minimum slope.

This effect should propagate up the entire branch chain ("Chain Reaction") and be **elastic** (reversible during the drag operation), returning joints to their original positions if the Knot is dragged back down.

## visual Behavior
1.  **Drag Up**: Knot moves up. Branch segment 1 hits the critical angle (e.g. max 80° from vertical, min 10° from horizontal). Joint 1 starts moving up on Z-axis to keep segment 1 at the limit. Joint 1 moving up eventually causes Segment 2 to hit the limit. Joint 2 starts moving up. (Stacking effect).
2.  **Drag Down**: Knot moves down. Branch segment 1 angle relaxes (becomes steeper/more vertical). Joint 1 stays at its *original* position (does not move down below its starting point).
3.  **Locks**: If the chain pushes the tip (Contact Cone) to an invalid position (e.g. into the mesh or off-limits), the whole chain locks and the Knot cannot move further up.

## Core Logic

### 1. State Management (`useKnotInteraction.ts`)
We need to capture the **Initial State** of the entire connected branch when the drag starts.
- **InitialKnotPos**: Starting position of the knot.
- **InitialBranchState**: A snapshot of all joints in the attached branch.
    - `Map<JointID, InitialPosition>`
    - Ordered list of segments/joints from Knot -> Tip.

### 2. Chain Solver (`solveElasticChain`)
A new pure function in `PlacementLogic` that calculates current positions based on `InitialState` + `TargetKnotPos`.

**Algorithm (`solveElasticChain`):**
Inputs: `TargetKnotPos` (Start), `InitialPositions[]`, `MaxAngleDeg` (from vertical).

1.  **Iterate** from Base (Parent Shaft) to Tip.
2.  **Segment 1**: Connects `TargetKnotPos` to `Joint1`.
    *   Calculate vector from `TargetKnotPos` to `Joint1_InitialPos`.
    *   Check Angle from Vertical (Reference Axis: Up or Down depending on branch direction).
    *   **If Angle is Safe** (e.g. < 80°): 
        *   `Joint1_CurrentPos` = `Joint1_InitialPos`. (No push needed).
    *   **If Angle is Critical** (e.g. > 80°):
        *   We must raise `Joint1` to satisfy the angle.
        *   Keep `Joint1.x`, `Joint1.y` constant (vertical movement only).
        *   Calculate `MinZ` such that the angle is exactly 80°.
        *   Math: `HeightDiff = HorizontalDist / tan(MaxAngle)`. 
        *   `MinZ = TargetKnotPos.z + HeightDiff` (if going Up).
        *   `Joint1_CurrentPos` = `(Joint1_InitialPos.x, Joint1_InitialPos.y, Math.max(Joint1_InitialPos.z, MinZ))`.
3.  **Segment 2**: Connects `Joint1_CurrentPos` to `Joint2`.
    *   Repeat logic using `Joint1_CurrentPos` as the start.
    *   If `Joint1` moved up, it might force `Joint2` to move up to maintain the angle for Segment 2.
4.  **Repeat** for all segments up to the Tip (Contact Cone).

### 3. Reversibility
Because we recalculate from `InitialState` every frame using `TargetKnotPos`:
- If `TargetKnotPos` is high, `Joint1` is pushed up.
- If `TargetKnotPos` drops back down, the algorithm sees that `Joint1_InitialPos` with the lower Knot is SAFE, so it returns `Joint1_CurrentPos` = `Joint1_InitialPos`.
- **Zero Drift**: No cumulative error.

## Implementation Steps

### Phase 1: Logic Implementation
- [ ] Create `src/supports/PlacementLogic/ElasticChainSolver.ts`.
- [ ] Implement `solveElasticChain` taking `KnotPos`, `BranchTopology`, `InitialPositions`, `MaxAngle`.
- [ ] Ensure math correctly handles "Vertical Z-Only" movement restriction.

### Phase 2: Interaction Integration
- [ ] Modify `useKnotInteraction.ts`.
- [ ] `onDragStart`: 
    - Identify attached branches.
    - Traverse branches to capture `initialPositions` of all joints and the `contactCone`.
    - Store mapping in `ref`.
- [ ] `useFrame` (Dragging Loop):
    - Get projected Knot Position (on parent shaft).
    - Call `solveElasticChain`.
    - **Check Validity**: If the solver pushes the Tip (Contact Cone), does that invalidate the support?
        - *Correction*: User didn't say the tip can't move. User said "move the knot... joints move...". 
        - If the tip moves, `ContactCone` moves. We need to update `ContactCone.pos`.
        - **Constraint**: If the Tip hits an obstacle (or we define a limit), we must stop the Knot. For now, assume Tip *can* move freely unless implicit limits exist.
    - Update **Knot** in State.
    - Update **All Affected Branch Joints** in State.
    - Update **Contact Cone** in State (if moved).

### Phase 3: Limits (Stop the Knot)
- [ ] We need to determine the "Max Knot Z" allowed.
- [ ] If strict limits exist (e.g. Tip cannot go higher than Mesh Surface - wait, Tip connects TO surface. If we move Tip Z, we might detach it? Or slide it?)
    - **Assumption**: For now, we slide the Tip vertically. The user might want the Tip to stay fixed?
    - **Re-reading User Request**: "I can no longer move the knot ... once all the shafts of the branch have hit the limit". AND "I want the joint ... to also move higher".
    - This implies the whole chain moves. Eventually it must become straight (all at critical angle).
    - Limitation is likely: "When the chain is fully fully stretched at 10 deg limit".
    - But stretched against *what*?
    - If the Tip is *fixed* to the model, we can't move the Tip.
    - If the Tip is free floating, we can move forever.
    - **Likely Scenario**: The **Tip (Contact Cone)** is fixed to the model surface. We cannot move the Tip Z without sliding it on the model (complex).
    - **Alternate Interpretation**: The Tip *stays fixed*. The joints bunch up. When the last segment hits the limit against the *Fixed Tip*, the whole chain is locked.
    - Implementation Plan will verify: **Is Tip Fixed?**
        - If Tip is Fixed: `solveElasticChain` needs to check if the computed position for the last Joint violates the angle to the *Fixed Tip*.
        - If it does, `solveElasticChain` reports "Invalid/Locked".
        - We clamp the Knot Z to the maximum value that satisfies the chain-to-fixed-tip constraint.

## Refined Algorithm (Fixed Tip Assumption)
1.  Calculate Chain positions based on Knot Z.
2.  Check Last Segment (Last Joint -> Fixed Tip).
3.  If Last Segment violates Angle:
    - The Knot has gone too high.
    - We need to Find Max Knot Z that allows the chain to fit between Knot and Fixed Tip with all segments at Max Angle.
    - This is effectively `Sum(HorizontalOffsets) / tan(MaxAngle)`.
    - `MaxHeightDiff = TotalHorizontalDistance / tan(10°)`.
    - `MaxKnotZ = FixedTip.z - MaxHeightDiff`.
    - Clamp Knot Z to `MaxKnotZ`.

If this "Fixed Tip" assumption is wrong (and the Tip should move), the user will correct us. But standard supports usually anchor to the model.

## Action Items
1.  **Create Solver**: `src/supports/PlacementLogic/ElasticChainSolver.ts`.
2.  **Integrate**: `useKnotInteraction.ts`.
