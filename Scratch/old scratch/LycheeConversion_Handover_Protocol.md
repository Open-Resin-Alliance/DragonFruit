# Lychee Slicer Conversion - Handover Protocol & Status

**Date:** December 3, 2025
**Status:** ✅ Reverse Engineering Complete (Coordinate System & Visual Hierarchy Verified)
**Next Phase:** App Integration

---

## 1. The Breakthrough: Coordinate System Solved
We have successfully reverse-engineered how Lychee Slicer stores support coordinates in its JSON (`scene.decrypted.json`). It uses a **Mixed Coordinate Space** system that is non-intuitive.

### A. The Tip (Contact Point)
*   **Reference**: Local Object Space (Scaled).
*   **Formula**: `World = (Local + Center) * Scale + Position`.
*   **Verification**: 
    *   JSON Tip Z: `16.76`
    *   Object Center Z: `20`
    *   Scale: `0.25`
    *   Position Z: `5` (Lift)
    *   Calculation: `(16.76 + 20) * 0.25 + 5 = 14.19mm`.
    *   **Observed**: Matches the model rim height perfectly (14.17mm).

### B. The Base (Pillar Root X/Y)
*   **Reference**: World Space relative to Object Position (Unscaled).
*   **Formula**: `World = Local + Position` (No Scale applied to X/Y).
*   **Verification**:
    *   JSON Base X: `8.6`
    *   Scaled Model Radius: `6.75`
    *   If Scaled: `8.6 * 0.25 = 2.15` (Inside model - WRONG).
    *   If Unscaled: `8.6` (Outside model - CORRECT).
    *   **Conclusion**: Base X/Y defines the pillar position in world mm (relative to object pivot).

### C. The Joint Geometry (Resolved)
*   **Structure**: Lychee visuals imply a "Root Joint" (Ball) at the base and a "Socket Joint" (Ball) at the top of the shaft.
*   **Root Joint**: Located at the top of the Base Pad assembly (Cylinder + Cone).
    *   **Height Formula**: `BaseLength (0.2) + JoinLength (0.5) + PillarRadius`.
*   **Socket Joint**: Located at the top of the shaft, where the contact cone begins.
    *   **Height Formula**: Calculated by intersecting the vertical pillar line with the sphere of radius `TipLength` around the Tip.
*   **Cone Orientation**: Points from Tip -> Socket (Downwards/Inwards).

---

## 2. Topology Structure (The "Simple Pillar")
To match Lychee's visual representation for standard supports, we settled on a **3-Component Structure**:

1.  **Roots (Pad)**:
    *   Anchored to the floor/raft.
    *   **Explicit Height**: Must be set to `BaseLength + JoinLength` (e.g., 0.7mm) so the visualizer renders the full base height and doesn't swallow the joint.
    
2.  **Root Joint (Ball)**:
    *   **Position**: `[BaseX, BaseY, TotalBaseHeight + Radius]`.
    *   **Purpose**: Visual anchor point sitting *on top* of the base pad.

3.  **Segments**:
    *   **Phantom Base**: Root -> Lower Joint (Length ~0, but necessary to link the Trunk to the Root entity).
    *   **Pillar**: Lower Joint -> Socket Joint (The main vertical shaft).
    *   *Note*: We removed the "Elbow/Arm" segment logic for standard supports as it caused overlapping geometry errors.

4.  **Contact Cone**:
    *   Attached to `Socket Joint`.
    *   **Orientation**: Vector from `Tip` to `Socket`.

---

## 3. Current Code State
*   **Converter Logic**: `src/features/lys-conversion/LysConverter.ts`
    *   Contains the exact `transformFull` (Tip) and `transformBase` (Base) functions.
    *   Implements the correct "2-Joint, 2-Segment (1 Phantom)" topology.
    *   Correctly handles dimensions (`padDiameter`, `pillarDiameter`, `tipSettings`).
*   **Visualizer**: `src/features/lys-ghost/GhostOverlay.tsx`
    *   Currently renders the output of `LysConverter`.

---

## 4. The Plan (Next Steps)

### Goal: Full Integration
Move from "Ghost Viewer" (visual only) to "Real Supports" (editable in app).

### Step 1: Store Integration
*   Create a Redux/Zustand action (e.g., `loadSupportsFromLychee`) in `useSceneCollectionManager` or `useSupportInteractionManager`.
*   This action must:
    1.  Accept the raw JSON.
    2.  Call `LysConverter.convert(json)`.
    3.  Iterate through the resulting `knots` and `segments`.
    4.  **Dispatch** actions to add these to the `historyStore` (using your `addSupport` or batch addition logic).

### Step 2: Verification
*   Load the file again.
*   Confirm supports appear as **Real Geometry** (Orange/Blue tubes).
*   Confirm they are **Selectable** and **Editable**.
*   **CRITICAL CHECK**: Verify the "Root Joint" ball is visible sitting on top of the green pad.

### Step 3: Cleanup
*   Delete `src/features/lys-ghost/`.
*   Remove `GhostOverlay` from `SceneCanvas`.
*   Revert `IslandScanCard` button to use the new Store Action instead of the Ghost Loader.

---

## 5. Critical Warnings for Next Agent
*   **DO NOT TOUCH THE CONVERTER MATH**. It has been painstakingly verified against visual references.
*   **Root Height Matters**: If you change how `Roots` are rendered, ensure you update the `height` property in the converter, or the joint will disappear inside the mesh.
*   **Phantom Segment**: Do not remove the "Phantom Base" segment. It is required to structurally link the visible "Pillar" segment to the "Root" anchor.
*   **Cone Normal**: The normal `Tip -> Socket` is correct for our renderer. Do not flip it back.
