# Territory Logic Architecture: Logical Volume Decomposition

**System Goal**: Decompose an arbitrary 3D mesh into distinct, logically consistent "Territories" (Volumes) that correspond to human-intuitive body parts (e.g., distinguishing "Left Leg" from "Right Leg" even after they merge into the "Hips").

**Purpose**: This spatial decomposition allows downstream systems (like Auto-Support generation) to apply context-aware logic. For example, knowing that a pixel belongs to the "Arm" vs. the "Torso" prevents supports from accidentally bridging a gap that should be kept clear, or allows for different support densities on different body parts.

---

## 1. The Architectural Philosophy: "The 3-Phase Pipeline"

To achieve robust identification, we cannot rely on a single algorithm. We break the problem into three phases:

### Phase 1: Discovery (The Island Scan)
*   **Objective**: Find the "Atomic Units" of the mesh.
*   **Method**: Connectivity Slicing.
*   **Interpretation**: If two parts are disconnected in specific slices, they start as separate entities (e.g., toes, fingers, separate legs).
*   **Result**: A "History" of islands merging into one another (e.g., Leg A + Leg B -> Hips).

### Phase 2: Consolidation (The Anchor Logic)
*   **Objective**: Define a stable "Identity" for each discovered atomic unit.
*   **Challenge**: As huge volumes merge (e.g., a massive boot connected to a skinny leg), the geometric center shifts wildly.
*   **Solution**: We use **Terminal Interface Centroids**. We capture the identity of a volume *at the moment it interacts with another*. The "Identity" of the Left Leg inside the Hips is defined by the *Top of the Femur* (where it entered the hips), not by the geometric average of the whole leg (which might be skewed by the boot).

### Phase 3: Propagation (The Territory Map)
*   **Objective**: Assign every voxel in the model to a specific Territory ID.
*   **Method**:
    1.  **Fast Path**: If Phase 1 says an island is physically separate (a Toe), we trust it 100%.
    2.  **Slow Path**: If Phase 1 says an island is merged (the Hips), we run a proximity vote based on the Anchors from Phase 2.
*   **Result**: A voxel map where the "Left Leg" territory extends continuously up into the hips, meeting the "Right Leg" territory at a clean, centered seam.

---

## 2. Resolving Key Inaccuracies (The Refactor)

Previous implementations failed to deliver on the system goal due to two specific logic flaws. This document outlines the correction.

### A. The "Eaten Toe" Failure
*   **Flaw**: The propagation phase ignored the Phase 1 discovery data, trying to re-calculate "closeness" from scratch.
*   **Outcome**: Small, distinct features (Toes) were "out-voted" by large nearby neighbors (Feet), erasing their identity.
*   **Correction**: **Respect Phase 1 Identity**. If the scanner sees a separated island, the Territory map must reflect that.

### B. The "Heavy Boot" Failure
*   **Flaw**: The consolidation phase used Global Centers of Mass.
*   **Outcome**: Large distal masses (Boots) pulled the "Identity Point" of the leg away from the hip joint. The territory boundaries in the crotch became skewed and illogical.
*   **Correction**: **Use Terminal Centroids**. By anchoring identity at the *merge interface*, we isolate the logic from irrelevant distal geometry.

---

## 3. Algorithm Detail: The "Terminal Centroid" Lifecycle

### Step 1: Scanning (IslandTracker)
*   For every layer of every island, calculate the **2D Centroid** of the slice.
*   When a Merge is detected (Island A + Island B -> Island C):
    *   **STOP**.
    *   Record the **Last Slice Centroid** of Island A and Island B.
    *   Save these as `A.terminalCentroid` and `B.terminalCentroid`.
    *   Proceed with the merge.

### Step 2: Mapping (TerritoryTracker)
*   Receive the Island Map (`islandLabels`) and the List of Islands (with `terminalCentroid` data).

### Step 3: Assignment (ProcessLayer)
For every solid pixel:
*   **Check ID**: Look up the Phase 1 Island ID.
*   **Leaf Check**: If the Island is a "Leaf" (unmerged), assign directly. **(Solves Eaten Toe)**
*   **Merge Check**: If the Island is a "Container" (merged):
    *   Calculate distance to the `terminalCentroid` of all contributing children.
    *   Assign to the closest child. **(Solves Heavy Boot)**
