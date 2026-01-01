# Collision-Aware "Smart" Support Placement Plan

## Overview (Common Language)
When placing a support, the standard behavior is to drop a straight vertical line from the contact point on the model down to the floor. However, sometimes parts of the model get in the way (e.g., an overhang or a protruding feature below).

Currently, the system ignores these obstacles and draws the support straight through the model mesh. This is invalid for 3D printing.

**The Goal:**
Create a "Smart Placement" system that detects when a support is about to pass through the model and automatically "bends" the support to go around the obstacle.

**How it works:**
1.  **Look Before Leaping:** Before creating the support, we check if the straight vertical path hits anything.
2.  **The "Knee" Concept:** If the straight path is blocked, we treat the support like a leg with a knee. We identify where the collision happened and try to place a **Joint** (a knee) slightly away from the obstacle.
3.  **Pathfinding:** We then check if the path from the *Socket* to the *Knee*, and from the *Knee* to the *Floor*, is clear.
4.  **Limitations:** The support can't bend too much. If the angle required to go around the obstacle is too extreme (too horizontal), or if it requires too many joints (too zig-zaggy), we declare the spot impossible to support and show a red warning.

---

## Technical Implementation Outline

### 1. New Logic Module: `SmartPlacement.ts`
This will be a dedicated solver that runs *only* when the standard placement fails validation.

*   **Entry Point:** `calculateSmartPlacement(input: SmartPlacementInput): TrunkPlacementResult`
*   **Algorithm:** "Joint Injection" (Iterative/Recursive)

### 2. Collision Detection Utility (`CollisionUtils.ts`)
A reliable way to detect if a cylindrical shaft intersects with the mesh.

*   **Function:** `checkShaftCollision(start: Vec3, end: Vec3, radius: number, mesh: THREE.Mesh)`
*   **Mechanism:**
    *   **Whisker Raycasting:** Instead of a single ray, cast a bundle of rays (Center + 4 Perimeter) from `start` to `end`.
    *   **Return:** `CollisionResult { hit: boolean, point: Vec3, normal: Vec3, distance: number }`
*   **Optimization:** Use `THREE.Raycaster` against the specific model mesh.

### 3. The Smart Solver Logic
The solver attempts to find a valid path using the following steps:

**Step A: The "Straight Down" Check**
1.  Run `checkShaftCollision` from Socket to Floor (Z=0).
2.  If clear -> Return Standard Placement.
3.  If hit -> Proceed to Step B.

**Step B: Single Joint Solution ("The Knee")**
1.  **Identify Collision Point:** Get the point where the straight shaft hit the model.
2.  **Calculate Avoidance Vector:** Use the surface normal at the collision point.
3.  **Propose Joint Position:**
    *   `JointPos = CollisionPoint + (SurfaceNormal * SafeDistance)`
    *   *SafeDistance* ensures the joint itself isn't clipping.
4.  **Validate Angles:**
    *   Check angle of Segment A (Socket -> Joint).
    *   Check angle of Segment B (Joint -> Floor).
    *   *Constraint:* Angle must be < `MAX_BEND_ANGLE` (e.g., 45° from vertical).
5.  **Validate Path:**
    *   Run `checkShaftCollision` on Segment A.
    *   Run `checkShaftCollision` on Segment B.
6.  **Result:** If clear and valid -> Return Trunk with 1 Joint.

**Step C: Failure / Fallback**
*   If the Single Joint solution fails (still hits something or angles too steep), mark as `COLLISION_DETECTED` (Red Preview).
*   *Future Expansion:* We could loop Step B to add a second joint, but we will limit to **Max 1 Joint** for the MVP to keep complexity manageable.

### 4. Integration Points

**`trunkBuilder.ts`**
*   Currently calls `calculateStandardPlacement`.
*   **Update:**
    ```typescript
    let placement = calculateStandardPlacement(...);
    
    // New Validation Step
    const collision = checkShaftCollision(placement.socketPos, placement.basePos, ...);
    
    if (collision) {
        // switch to smart mode
        placement = calculateSmartPlacement(..., collision);
    }
    ```

**`SupportLimitations.ts`**
*   Add new Limitation Code: `'COLLISION_DETECTED'` (for when even Smart Placement fails).

### 5. Constants & Configuration
*   `MAX_SMART_JOINTS`: 1 (Start simple).
*   `MAX_BEND_ANGLE`: 45 degrees (Subject to fine-tuning).
*   `COLLISION_SAFE_DISTANCE`: 5mm (How far to push the knee away from the wall).
