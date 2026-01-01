# Shaft Angle Constraint Implementation Plan

## Goal
Prevent users from manually manipulating support joints into invalid angles (too horizontal or inverted).
- **Metric**: Angle from Vertical (Z-Up).
- **Limit**: Max 80° deviation from vertical (keeps support at least 10° away from horizontal).
- **Behavior**: Silent clamping during drag, with visual feedback (tooltip).

## terminology
- **0°**: Perfectly Vertical (Up).
- **90°**: Perfectly Horizontal.
- **>90°**: Pointing Down (Inverted).

## Implementation Steps

### 1. Logic Utility (Completed)
**File**: `src/supports/PlacementLogic/ShaftAngleConstraint.ts`
- Export `MAX_SHAFT_ANGLE_FROM_VERTICAL = 80`.
- Export `clampShaftAngle(start, end, limit, axis)` function.
- Logic: If vector `(End - Start)` exceeds angle limit relative to `Axis`, project it back onto the cone of validity.

### 2. Limitations & Feedback Definitions
**File**: `src/supports/PlacementLogic/SupportLimitations.tsx`
- Add `SHAFT_ANGLE_TOO_FLAT` to `WarningCode` type.
- Add warning message: "Support angle is too flat (must be >10° from horizontal)."
- Ensure `SupportLimitationFeedback` handles this code.

### 3. Global State for Interaction Feedback
**File**: `src/supports/state.ts`
- Add `interactionWarning: WarningCode | null` to the store.
- Add `setInteractionWarning(code)` action.
- Rationale: Allows `useJointInteraction` (deep in React tree) to communicate with `SceneCanvas` (UI layer) without complex prop drilling or return type changes.

### 4. Joint Movement Logic
**File**: `src/supports/SupportPrimitives/Joint/jointUtils.ts`
- Import `clampShaftAngle`.
- Modify `moveJoint` to enforce constraints:
    - Identify connected segments (Below and Above the moving joint).
    - **Constraint 1 (Bottom Segment)**: `clampShaftAngle(PrevJoint, NewPos, 80, Up)`.
    - **Constraint 2 (Top Segment)**: `clampShaftAngle(NextJoint, NewPos, 80, Down)`.
    - Apply clamping to `newPos` before updating the trunk/branch.

### 5. Interaction Hook
**File**: `src/supports/SupportPrimitives/Joint/useJointInteraction.ts`
- Monitor the result of `moveJoint`.
- Calculate `expectedPos` (mouse drag position).
- Compare with `actualPos` (result in trunk).
- If `distance(expected, actual) > epsilon`:
    - `setInteractionWarning('SHAFT_ANGLE_TOO_FLAT')`.
- Else:
    - `setInteractionWarning(null)`.
- On drag end: Clear warning.

### 6. UI Rendering
**File**: `src/components/scene/SceneCanvas.tsx` (or `IslandOverlay.tsx`)
- Subscribe to `useStore((s) => s.interactionWarning)`.
- Render `<SupportLimitationFeedback warning={interactionWarning} />`.
- Ensure it is rendered in the DOM layer (outside Canvas or inside `<Html>`).

## Future Considerations
- Apply similar logic to **Branch Creation** (when snapping the ghost branch).
- Apply to **Knot Sliding** (ensure branch doesn't become too flat when sliding base).
