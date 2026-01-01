# Island Volume Analysis - Brainstorming Session

> [!IMPORTANT]
> This document serves as a raw, comprehensive log of the user's brainstorming session.
> **DO NOT SUMMARIZE.** Capture every detail, thought, edge case, and requirement mentioned by the user.

## Global UI Requirement
- **Workflow Control Panel:**
  - Must have a dedicated UI specifically for this workflow.
  - **Sequential Controls:** Distinct buttons for each step (e.g., "Run Step 1", "Run Step 2").
  - **Purpose:** To provide a logical, visual interface where the user can manually trigger and observe each step in isolation.

## Step 1: Voxel Filling
- **Action:** Fill the *entire* volume of the model with voxels.
- **Implementation Strategy:**
  - **Instancing:** Generate a single voxel geometry and use **instanced rendering** to duplicate it throughout the volume.
- **Parameters:** Must have a method to define/identify the **size of the voxels** in a UI element.
- **Scope:** The *entire* model volume is filled.
- **Standard Verification:** (Implicit) Visual confirmation that the mesh is correctly and completely filled with voxels.

## Step 2: Basic Island Scan
- **Core Philosophy:**
  - **Strict Isolation:** This new workflow must be *completely isolated* from current tools/workflows.
  - **Step-by-Step Verification:** Every single step requires visual identifiers.
    - **Process:** Execute Step -> Verify Visually -> Confirm Accuracy -> Move to Next Step.
    - **Goal:** Problems must be identifiable immediately by the user, not guessed by AI.
- **Action:** Analyze the **Voxel Grid** from Step 1 to identify distinct islands.
  - Instead of re-scanning the mesh, we use the voxel data we just generated.
  - **Logic:** Group connected voxels into distinct sets (Islands).
- **Immediate Goal:** Generate a list of all islands, specifically identifying the **lowest point** of each island.
- **Output:** A confirmed list of island start points (lowest Z voxels).
- **Verification:** Visual confirmation of these lowest points before proceeding to volume analysis.

## Step 3: Volume Tracing & Coloring
- **Concept: The "Stool Leg" Model**
  - **Initial State:** The entire voxel body conceptually belongs to **ID 1 (The Body)**.
  - **Process:** Scan upwards.
  - **Start Condition:** A **New ID** is generated *only* at the **Lowest Point** of an island (an overhang not connected to anything below).
  - **Growth:** This ID propagates upwards layer by layer.
  - **Stop Condition (Merge):**
    - If an island connects with *any* other portion of the model (another island OR the main body):
    - The Island ID **STOPS**.
    - The volume becomes **ID 1 (The Body)**.
- **Rules:**
  1. No Connection below -> New ID.
  2. Single Connection to specific Island ID -> Propagate ID.
  3. Connection to Multiple IDs (Merge) -> Become ID 1.
  4. Connection to ID 1 -> Become ID 1.
- **Visual Result:** Distinct colorful islands rising from their lowest points until they merge into the neutral body.

## Step 4: Identify Primary Volume (Leftovers)
- **Logic:** Identify all voxels *not* assigned an Island ID during Step 3.
- **Action:** Combine all these unassigned voxels into a single group.
- **Designation:** Label this group as the **Primary Volume**.
    - **Special Status:** This volume is distinct from "Island" volumes but must be trackable.
    - **ID Requirement:** Assign a specific, unique ID to this Primary Volume (e.g., `PV_01` or similar).
- **Purpose:** These voxels represent the main body/core of the model (not distinct islands) and are required for later logic.
- **Visual:** Differentiate this "Primary Volume" from the Island Volumes (maybe a distinct neutral color).

## Step 5: Identify Internal Center
- **Scope:** Apply this step to **ALL** identified volumes:
    - All Island Volumes (from Step 3).
    - **AND** The Primary Volume (from Step 4).
- **Concept:** "Center of the volume of the mesh" but distinct from center of mass.
- **Critical Constraint:** The point **MUST** be located within the internal volume of the mesh. (Centroids can fall outside for concave shapes; this point cannot).
- **Calculation Logic (User Description):**
  - "Look at the furthest length of the mesh in all directions and find the center of that."
  - *Interpretation Reference:* This sounds like the **Pole of Inaccessibility** or **Chebyshev Center** (the center of the largest strictly inscribed sphere, or the point with the maximum distance to the nearest boundary).
- **ID Requirement (Critical):**
  - Each determined Center Point **must have a unique ID**.
  - **Purpose:** Voxels will reference these IDs in later steps.
- **Visual:** A visual indicator marking this specific center point for every identified island volume.

## Step 6: Initial Voxel Assignment (Seed Voxels)
- **Action:** Iterate through valid voxels (from Step 2).
- **Logic:** Check if a voxel (or multiple) "overlaps" the **Center Point** of an island (from Step 4).
  - *Technical Interpretation:* This likely means checking if the Center Point coordinates fall within the bounds of a specific voxel.
- **State Change:**
  - If a voxel overlaps a Center Point -> That voxel becomes a **member** of that Center Point (associated with that Island's ID).
  - These become the "Seed" voxels for the specific island.
- **Visual:** Differentiate these "Member/Seed" voxels visually from the unassigned rest.

## Step 7: Iterative Voxel Expansion (The "Basin Fill")
- **Action:** Process voxels directly adjacent to currently "assigned" voxels.
- **Selection Logic (Competition):**
  - A neutral voxel looks at its defined/assigned neighbors.
  - It identifies the **Island IDs** of those neighbors.
  - **Condition:** It calculates the distance from **itself** to the **Central Point** associated with each candidate Island ID.
  - **Assignment:** It joins the Island ID whose Central Point is **nearest**.
  - *Constraint:* Must have a direct connection (adjacency) to join.
- **Result:** Voxels "choose" to become members of island volumes they are connected to and closest to.
- **Visual:** Step-by-step visualization of this expansion (crawling effect).
  - **Live Mode Requirement:** The user must be able to watch this happen in real-time.
  - **Visibility Logic:** Unassigned voxels should be hidden. Voxels become visible *only* when they are assigned.
  - **Effect:** User sees the islands "grow" or "crystallize" from the seeds outwards to fill the volume.

## Step 8: Experimental Volumetric Smoothing
- **Status:** Experimental.
- **Goal:** Smooth the boundaries between different voxel volumes (e.g., where Island A meets Primary Volume, or Island A meets Island B).
- **Problem:** The raw "collision" or meeting point of competing voxel sets can be noisy/chaotic.
- **Desired Result:** A clean, distinct separation line/surface between volumes.
- **Method options (Brainstorming):**
  - Morphological operations (Erosion/Dilation)?
  - Gaussian blur on the "influence" field before hardening?
  - Cellular Automata smoothing?
- **Visual:** Toggleable view to see "Raw" vs "Smoothed" boundaries.
