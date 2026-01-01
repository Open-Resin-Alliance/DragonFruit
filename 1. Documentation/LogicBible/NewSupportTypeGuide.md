# Dragonfruit Support Implementation Guide

## Overview
This document serves as the **Master Guide** for implementing new support types in the Dragonfruit ecosystem. It consolidates requirements for data structure, interaction logic, rendering, and system integration (Undo/Redo, Deletion, Validation).

Any new support type (e.g., Branch, Brace, Tree) **MUST** follow these patterns to ensure compatibility with the Lychee Importer and the application's lifecycle management.

---

## 1. The "Support Entity" Contract
Every support object in the system must adhere to the `SupportEntity` base interface. This is critical for the **SupportModelLinker** to function (cascading deletion).

### Required Interface (`src/supports/types.ts`)
```typescript
export interface SupportEntity {
    id: string;
    modelId: string; // CRITICAL: Links support to the active model
}

// Example: A new "Tree" support type
export interface Tree extends SupportEntity {
    rootId: string;
    segments: Segment[];
    // ... specific properties
}
```

---

## 2. The "Builder" Pattern
We do **not** create support geometry inside the React components or hooks. We use a **Pure Function Builder**.

### Why?
1.  **Reusability**: The same logic is used for the **Placement Preview** (hover) and the **Actual Creation** (click).
2.  **Import Compatibility**: The Lychee Importer can call the builder to generate valid data structures without needing a UI.

### Implementation (`[Type]Builder.ts`)
Create a file like `src/supports/SupportTypes/[Type]/[type]Builder.ts`.

It must accept a context object and return a result containing the data and validation status.

```typescript
// Input DTO
export interface TreeBuildInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string; // MUST be passed in from the interaction layer
}

// Output DTO
export interface TreeBuildResult {
    tree: Tree;
    roots: Roots; // If applicable
    supportData: SupportData; // For the generic renderer
    error?: LimitationCode; // For validation feedback
    warning?: WarningCode;
}

export function buildTreeData(input: TreeBuildInput): TreeBuildResult {
    // 1. Calculate Geometry (using PlacementUtils)
    // 2. Generate UUIDs
    // 3. Construct Data Objects (Tree, Roots, Segments)
    // 4. Run Limitation Checks
    // 5. Return Result
}
```

---

## 3. Interaction & Placement Hook
The hook manages the user input (Hover/Click) and bridges the gap between the **Scene** (Raycasting) and the **Store**.

### Implementation (`use[Type]Placement.ts`)
1.  **Raycast**: Get `hit.point` and `hit.face.normal`.
2.  **Model ID**: Extract `hit.object.userData.modelId`.
3.  **Smoothing**: Call `calculateSmoothedNormal(hit)` (Required for curved surfaces).
4.  **Build**: Call `build[Type]Data(...)`.
5.  **Preview**: Set state for the renderer.
6.  **Commit**: On click, push to **Store** and **History**.

```typescript
// Extracting the Model ID is mandatory
const modelId = hit.object.userData.modelId || 'unknown';
```

---

## 4. Lifecycle & Integration

### A. Deletion (SupportModelLinker)
You must register the new support type in `src/supports/PlacementLogic/SupportModelLinker.ts`.
*   Update `getSupportsForModel` to scan your new collection.
*   Update `deleteSupportsForModel` to call your remove action.

### B. History (Undo/Redo)
1.  Define a new Action Type in `src/supports/history/actionTypes.ts`.
2.  Create a handler in `src/supports/history/useSupportHistoryHandlers.ts`.
3.  Ensure your creation hook pushes a `type: SUPPORT_ADD_[TYPE]` history entry.

### C. Validation (Limitations)
Use `src/supports/PlacementLogic/SupportLimitations.tsx`.
*   Your Builder should check angles/overhangs.
*   Return `LimitationCode` in the builder result.
*   The `SupportLimitationFeedback` component handles the UI tooltip automatically if you pass the error code.

### D. System Integration Requirements
1.  **Raycasting Data**: Ensure your Mesh component passes `userData={{ modelId }}` to the Three.js mesh. Without this, `hit.object.userData.modelId` will be undefined.
2.  **Clean Deletion**: Your removal function (e.g. `removeTree`) MUST check if the deleted object (or its sub-parts like joints) is currently selected. If so, it must set `selectedId` to `null` in the store to prevent invalid state.

---

## 5. Rendering
Use the **Composite Renderer** pattern. Do not write a monolith renderer.

*   **Primitives**: Reuse `ShaftRenderer`, `JointRenderer`, `RootsRenderer`, `ContactConeRenderer`.
*   **Renderer**: Create `[Type]Renderer.tsx` that maps your data structure to these primitives.

---

## 6. Lychee Mapping Compliance
Refer to `Lychee_to_Dragonfruit_Mapping.md`.
Your data structure **MUST** be graph-compatible:
*   **Nodes**: Roots, Knots, Joints, ContactCones.
*   **Edges**: Shafts (Segments).

If your new support type introduces a new node type (e.g., "ScaffoldAnchor"), it must be defined in `types.ts` and mapped in the Importer.

### Coordinate System
*   **Internal**: World Space (Three.js standard).
*   **Lychee Import**: Requires `Object Center + Relative Pos` conversion. Your builder handles World Space; the Importer handles the conversion before calling the builder.

---

## 7. Export System Integration
The STL Export system runs in an "Offline Scene" (detached from React). It does not use your Renderers. Instead, it uses a pure-logic generator.

### Files to Update
1.  **`src/features/export/logic/ExportManager.ts`**:
    *   Add a loop to iterate over your new support collection (e.g., `supportState.trees`).
    *   Construct a `SupportData` object that represents the structure (segments, roots, joints).
    *   Pass it to `SupportGeometryGenerator.generateSupportGroup()`.

2.  **`src/features/export/logic/SupportGeometryGenerator.ts`**:
    *   **Usually No Change Needed**: If your support type is just a combination of Shafts, Joints, Roots, and Cones, the existing generator will handle it automatically.
    *   **Change Needed Only If**: You introduce a brand new primitive geometry (e.g., a "Cube Anchor" or "Helix Shaft"). In that case, add a `generate[Primitive]Mesh` function.

### Data Consistency
*   The export generator assumes `SupportData` contains fully resolved `startPos` and `endPos` logic (or linked Nodes).
*   Ensure your `ExportManager` loop correctly resolves the starting position (e.g., for a Branch, find the parent Knot's world position).

---

## Checklist for New Support Types
1.  [ ] **Interface**: Defined in `types.ts`, extends `SupportEntity`.
2.  [ ] **Builder**: `[type]Builder.ts` created, accepts `modelId`.
3.  [ ] **Store**: Added to `SupportState` in `state.ts`.
4.  [ ] **Linker**: Added to `SupportModelLinker.ts` for deletion.
5.  [ ] **Renderer**: `[Type]Renderer.tsx` composing primitives.
6.  [ ] **Hook**: `use[Type]Placement.ts` handling Raycast -> Builder -> Store.
7.  [ ] **History**: Undo/Redo actions wired up.
8.  [ ] **Export**: Added traversal loop to `ExportManager.ts`.
