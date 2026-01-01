# Territory Merging Logic: Two-Pass "Volume-Aware" Architecture
**Status**: Active Development
**Last Updated**: 2025-12-09

## The Core Concept
To solve the "Infinite Leg Paradox" (legs extending infinitely up into the torso), we separate the process into three phases.

### Phase 1: The Geometry Scan (Discovery)
*   **Goal**: Uncover physical topology and island hierarchy.
*   **Process**: Standard slicing and island detection.
*   **Outcome**: We know where every island exists, their bounding boxes, and their parent-child merge relationships (Accessory Graph).

### Phase 2: Volume & Centroid Calculation (Consolidation)
*   **Goal**: Establish "Capital Cities" for each territory.
*   **Process**: We calculate the weighted **Centroid** (Center of Mass) for every distinct island volume.
*   **Outcome**: A set of 3D coordinates representing the "Heart" of each body part (Left Foot, Right Foot, Torso, Head).

### Phase 3: Voxel Territory Assignment (Propogation)
*   **Goal**: Assign every solid voxel to a specific Territory.
*   **Process**: For every voxel, we determine allegiance based on **Connectivity** and **Proximity**.

---

## Current Logic Implementation

The `TerritoryTracker` now supports two distinct modes of operation, controlled by a user toggle.

### 1. Internal Volume Mode (Default / Surface Priority OFF)
*   **Philosophy**: "The insides matter most."
*   **Logic**:
    1.  **Vertical Connectivity**: Checks 5x5 neighborhood in the layer below.
    2.  **Proximity Vote**: If a voxel is connected to multiple parents, it votes for the one whose **Centroid** is closest in 3D space.
*   **Pros**: Excellent for large, spherical volumes like torsos.
*   **Cons**: Can cause "Tunneling" where a surface pixel is assigned to an internal volume (e.g., a pixel on the chest skin assigned to the 'Lung' volume inside, if it existed).

### 2. Surface Priority Mode (NEW / Toggle ON)
*   **Philosophy**: "The skin must be smooth."
*   **Logic**:
    1.  **Vertical Connectivity**: Checks 5x5 neighborhood in layer below.
    2.  **Horizontal Connectivity**: **Crucial Addition**. Checks immediate Left and Top neighbors in the *current* layer.
    3.  **Majority Rule**: Instead of pure distance, a voxel adopts the ID of the **Majority** of its neighbors.
*   **Pros**: Eliminates "Jagged Strips" and vertical artifacts. Ensures contiguous surface patches.
*   **Cons**: Can be slightly slower due to extra checks.

### 3. The "Wide Search" Fallback (Overhangs)
*   **Problem**: Sudden overhangs (Chin, Buttocks, Elbows) appear in empty air, having no vertical connection to the pixel *directly* below them.
*   **Solution**: If no neighbor is found in the 5x5 vertical grid, we perform a **Wide Search** (Radius = 15px / ~1.5mm) in the layer below.
*   **Result**: The chin "finds" the neck nearby and attaches to it, rather than spawning as a new orphan territory.

---

## Current Active Issues (Bug Tracking)

### 1. "Missing Islands" / The "Eaten Toe" Regression
**Symptom**: In Territory View, small islands (like individual toes) are not receiving their own unique colors. They appear to be immediately consumed by the parent volume (Foot) or are invisible.
*   **Observation**: The Island View shows them correctly as distinct IDs.
*   **Hypothesis**:
    *   **Centroid Initialization Failure**: The `TerritoryTracker` might be receiving islands with `(0,0,0)` centroids if the RLE centroid calculation in `islandTracker.ts` or `rle.ts` is failing for small areas.
    *   If a Centroid is invalid (or filtered out implicitly), the `TerritoryTracker` cannot spawn a "Kingdom" for it.
    *   The voxels then default to the nearest valid kingdom (the Foot), effectively erasing the Toe's identity.

**Resolution (Applied)**:
*   Patched `IslandTracker.ts` to robustly handle missing centroid data from components.
*   Added warnings if centroid sums are missing to aid future debugging.
*   Implemented final `centroid` calculation in `getIslands()` to ensure coordinates are correct before handoff.

### 2. "Cycle Detected" Crash (Recursive Merge Failure)
**Symptom**: Application crashes with `Cycle detected in placeholder chain for island [ID]`.
*   **Cause**: `IslandTracker` was allowing "Child" islands (islands that had already been merged into a parent) to participate in **new** merges as if they were independent roots.
*   **Mechanism**: If a child island `C` (merged into `P`) overlapped with `P` again in a later layer, the tracker might try to make `P` a child of `C`, creating a `C -> P -> C` cycle.
*   **Resolution (Applied)**:
    *   Implemented deep recursive `resolveParent(id)` logic in `processLayer`.
    *   Ensures all merge candidates are resolved to their **Ultimate Root Parent** before any new merge is created.
    *   Guarantees the hierarchy remains a strict Directed Acyclic Graph (DAG).
