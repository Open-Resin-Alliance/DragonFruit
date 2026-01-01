# Territory System Refactor & Visualization Plan

## 0. Architecture & UI Integration
**Objective**: Isolate the new scanning logic and provide a dedicated UI for inspection.
*   **Module Isolation**: The entire Territory System will be encapsulated as a standalone module, distinct from the main support generation pipeline until verified.
*   **UI Replacement**: We will repurpose/replace the existing "Physics Panel" with a new **"Scanning Panel"**.
    *   **Sanitization**: All previous experimental physics logic will be removed/archived.
    *   **Purpose**: This panel will serve as the "Debugging Console" for the Island Scanning and Territory algorithms.
    *   **Features**:
        *   Layer Slider (Z-Index control).
        *   **View Mode Selector**: Buttons to toggle between the 4 Visual Markers (Raw, Identity, Candidates, Final).
        *   Performance Metrics: Display scan time and memory usage.

## 1. Algorithmic Objective
To completely refactor the `TerritoryTracker` logic into discrete, verifiable phases.

## 2. Pipeline: The 4-Phase Logic

We will break the `processLayer` function into 4 specific helper stages.

### Phase 1: Raw Input (Validation)
*   **Goal**: Sanitize input.
*   **Input**: `RleLabels` (Raw Island IDs from Phase 1 Scanning).
*   **Action**: Validate RLE structure.
*   **Visual Marker**: "Raw Input" View. Shows the actual fragmented slice IDs (e.g., ID #25, #26, #27 stacking up).

### Phase 2: Identity Resolution ("Who is this really?")
*   **Goal**: Solve the "Fragmentation" issue.
*   **Logic**: Map every local Fragment ID to its **Ultimate Parent (Root)**.
    *   If `islandId` is a child, `sovereignId` = `island.parentId`.
    *   If `islandId` is a parent/independent, `sovereignId` = `island.id`.
*   **Critical Fix**: This ensures that a slice of a Leg is identified AS THE LEG, not as a separate entity.
*   **Visual Marker**: "Resolved Identity" View. Shows the Sovereign ID. A Leg made of 100 slices will appear as 1 solid color (The Leg ID).

### Phase 3: Candidate Selection ("Who is fighting?")
*   **Goal**: Identify all valid claimants for a pixel.
*   **Logic**:
    1.  **The Native**: The Sovereign ID of the pixel itself (from Phase 2).
    2.  **The Invaders**: Any Territory touching this pixel from:
        *   **Below** (Previous Layer Z-1).
        *   **Sides** (Current Layer Neighbors - Optional).
*   **Visual Marker**: "Candidate Count" Heatmap.
    *   **Blue (1)**: Uncontested (Stable Growth).
    *   **Red (>1)**: Battle Zone (Arbitration will occur).

### Phase 4: Arbitration ("Who wins?")
*   **Goal**: Assign the pixel to the best Territory.
*   **Logic**: **Pure Distance Field**.
    *   For every Candidate, calculate the 3D Distance from the pixel to the Candidate's **Terminal Centroid**.
    *   **Terminal Centroid**: The centroid of the Candidate's *last active layer*.
        *   *Contrast*: NOT the "Center of Mass".
    *   **Winner**: The Candidate with the **Minimum Distance**.
*   **Visual Marker**: "Final Territory" View. The actual assigned ID.

## 3. Data Structures & Types

We will update `TerritoryLayerResult` to support exporting these debug views.

```typescript
export interface DebugLayerData {
    rawInput: RleLabels;      // Phase 1
    resolvedIdentity: RleLabels; // Phase 2
    candidateCount: RleLabels;   // Phase 3 (Heatmap)
    finalOutput: RleLabels;      // Phase 4
}
```

## 4. Implementation Steps

### Step 1: UI & Module Setup
- Create/Rename `src/components/ScanningPanel.tsx`.
- Remove old Physics Logic.
- Hook up the `ScanningPanel` to the `ScanOrchestrator`.

### Step 2: Core Refactor
- Create `TerritoryTrackerRefactored.ts`.
- Implement the 4-phase pipeline (Resolution -> Candidates -> Arbitration).

### Step 3: Debug Mode Implementation
- Add `debug: boolean` flag to tracker.
- Return `DebugLayerData` structure.
- Wire up the "View Mode Selector" in the UI to render these different RLE maps.

## 5. Visual Markers Summary

| Phase | View Name | What it shows | Success Criteria |
| :--- | :--- | :--- | :--- |
| **1** | Raw Input | The physical islands from the scanner. | Correct geometry of slices. |
| **2** | Resolved ID | The logical entity (Parent) of each slice. | **Continuous vertical columns** (No banding). |
| **3** | Candidates | Areas of conflict. | Red lines only at boundaries. Blue internals. |
| **4** | Final Output | The assigned territory. | Smooth, organic Voronoi boundaries. |
