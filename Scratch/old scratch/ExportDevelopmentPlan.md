# Export System Development Plan

## Objective
Implement a dedicated **Export Mode** that allows users to generate and download an STL file containing the model, supports, and raft. The generation process must be **offline** (detached from the main render loop) to ensure it does not degrade performance during the "Prepare" or "Support" modes.

## Core Architecture

### 1. The "Detached Scene" Strategy
To keep the application fast, we will not attempt to "capture" what is currently on the screen. Instead, we will rebuild the scene mathematically in an invisible, temporary Three.js container specifically for the export.

*   **Live Viewport**: Optimized for 60FPS, uses React components, handles interactions (hover/click).
*   **Export Pipeline**: Optimized for geometry accuracy, uses pure TypeScript functions, runs once on demand.

### 2. Self-Contained Component Structure
All export logic will be encapsulated within a dedicated feature folder (`src/features/export/`) to avoid polluting the main support logic.

## Implementation Steps

### Phase 1: State & UI Scaffolding
1.  **Mode State**: Update `useSceneCollectionManager` to include an `'export'` mode.
2.  **Top Bar**: Add an "Export" button to the top navigation that switches the mode.
3.  **Sidebar Panel**: Create an `ExportPanel` component that only appears when in Export mode.
    *   *Controls*: Filename input, "Export Binary" toggle.
    *   *Action*: "Download STL" button.

### Phase 2: The Support Geometry Generator
We need a "pure math" version of our renderers. Currently, `SupportBuilder.tsx` creates visual meshes. We need a TypeScript class that creates **exportable** meshes.

*   **File**: `src/features/export/logic/SupportGeometryGenerator.ts`
*   **Responsibilities**:
    *   Take `SupportData` (roots, segments, joints, cones) as input.
    *   Return a merged `THREE.Mesh` or `THREE.Group` representing that support.
    *   *Crucial*: Must exactly match the visual appearance of the live supports (same diameters, positions).

### Phase 3: The Export Manager
This is the brain of the operation.

*   **File**: `src/features/export/logic/ExportManager.ts`
*   **Workflow**:
    1.  Create a temporary `new THREE.Scene()`.
    2.  **Model**: Clone the original model geometry and add to scene.
    3.  **Supports**: Iterate through the `historyStore` (or `supportStore`), pass data to `SupportGeometryGenerator`, add results to scene.
    4.  **Raft**: Call `RaftGeometry` utils (already exist) to generate the raft mesh and add to scene.
    5.  **Export**: Use `STLExporter` (from `three-stdlib`) to traverse the temporary scene and generate the binary data.
    6.  **Cleanup**: Dispose of the temporary scene to free memory.

### Phase 4: Wiring & Integration
1.  Install `three-stdlib` for the `STLExporter`.
2.  Connect the `ExportPanel` button to the `ExportManager`.
3.  Handle the browser download trigger (Blob -> URL -> `<a>` click).

## Directory Structure (Proposed)

```text
src/
  features/
    export/
      components/
        ExportPanel.tsx        <-- UI for the sidebar
      logic/
        ExportManager.ts       <-- Orchestrator
        SupportGeometryGenerator.ts <-- The math engine
      index.ts
```

## Dependencies
- `three-stdlib`: For `STLExporter`.
