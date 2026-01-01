# Support Selection Refactor Plan (V2 Only)

## Goals
- Centralize **support selection and element selection** logic for V2 supports.
- Remove reliance on legacy support-selection paths.
- Make it easy for a new contributor to find and reason about selection behavior.

---

## Target Architecture

### 1. Central Interaction Module
- **Location:** `src/supports/interaction/SupportSelection.ts` (name can be adjusted)
- **Responsibilities:**
  - Own the *V2 support* selection semantics.
  - Provide a clear API around the existing store in `src/supports/state.ts`.
  - Stay UI‑agnostic (no React components; small hooks or pure functions only).

- **Likely exports:**
  - `selectSupport(id: string)`: select a trunk/branch/root/brace/knot by id.
  - `selectJoint(id: string)`: select a joint (infers category `joint`).
  - `clearSelection()`: clear any selected support/joint.
  - `useSupportSelection()`: optional hook that exposes
    - `selectedId`
    - `selectedCategory`
    - helper booleans like `isSelected(id)` when useful.

- **Implementation detail:**
  - These functions will wrap `setSelectedId`, `getSelectedId`, `getSelectedCategory`, etc., from `src/supports/state.ts` rather than duplicating logic.

### 2. Renderer Responsibilities (V2 Only)

Renderers should:
- Use the interaction module instead of calling `setSelectedId` directly.
- Remain responsible only for **raising events** and **visuals**.

Initial refactor targets:
- `src/supports/SupportTypes/Trunk/TrunkRenderer.tsx`
  - Replace direct `setSelectedId(trunk.id)` with `selectSupport(trunk.id)`.
- `src/supports/SupportPrimitives/Joint/JointRenderer.tsx`
  - Replace direct `setSelectedId(joint.id)` with `selectJoint(joint.id)`.
- `src/supports/SupportTypes/Branch/BranchRenderer.tsx`
  - Replace `setSelectedId(branch.id)` with `selectSupport(branch.id)` (or migrate fully away from legacy components over time).

Highlighting (`useHighlight`) remains separate and continues to depend on:
- `isSelected` from the store.
- Hover state from GPU picking + `PickingStateSyncer`.

### 3. SceneCanvas / Background Deselect

`src/components/scene/SceneCanvas.tsx` currently:
- Handles deselection for **legacy supports** via `onSupportSelect(null)` / `onJointSelect(null)`.
- Does **not** talk to the V2 support store directly.

Plan:
- Introduce a thin bridge that calls `clearSelection()` from the interaction module when the canvas background is clicked in **support mode** and no support/gizmo consumed the click.
- Keep model selection (`SelectionManager`, `SelectionProvider`) separate and untouched.
- Ensure gizmo-related suppression remains honored:
  - Respect `window.__gizmoDragEndedThisFrame` and `suppressNextCanvasClickRef` so joint selection is not unintentionally cleared after a drag.

Result:
- Clicking a V2 trunk or joint selects via `selectSupport` / `selectJoint`.
- Clicking empty canvas or the model in support mode clears V2 selection via `clearSelection()`.

---

## Legacy Selection Logic Strategy

### Principles
- **No new work** should depend on legacy supports.
- As we touch files, we should either:
  - Remove legacy selection paths outright, or
  - Quarantine them behind clearly marked legacy modules.

### Immediate actions (scoped to selection)
- Avoid using `supports_legacy` selection props or behavior when working on V2 logic.
- When adding V2 selection behavior in `SceneCanvas`, **do not** route through `supports_legacy` state.
- Prefer V2 store + `SupportSelection` module everywhere for:
  - What is selected.
  - How it is cleared.

Longer term (separate task):
- Remove or replace `supports_legacy` components once V2 feature parity is acceptable.

---

## Refactor Steps

1. **Create interaction module**
   - Add `src/supports/interaction/SupportSelection.ts`.
   - Implement `selectSupport`, `selectJoint`, `clearSelection`, and optionally `useSupportSelection` as wrappers around `supports/state.ts`.

2. **Wire V2 renderers to the module**
   - Update `TrunkRenderer`, `JointRenderer`, `BranchRenderer` to use the new functions instead of direct `setSelectedId`.
   - Verify no behavior change: selection should still work as today (minus deselection).

3. **Hook background deselect into V2**
   - In `SceneCanvas`, call `clearSelection()` from the new interaction module when the canvas background is clicked in support mode.
   - Make sure clicks that hit supports set a `supportClickedRef` (already present) so background logic does not fire.
   - Respect gizmo drag flags to avoid accidental deselection.

4. **Sanity check / cleanup**
   - Confirm selection/deselection behavior:
     - Click trunk → trunk selected.
     - Click joint → joint selected and gizmo appears.
     - Click background/model (support mode) → both trunk/joint deselected.
   - Remove any now-unused direct calls to `setSelectedId` in V2 code.
   - Add small comments in the new interaction module explaining its purpose and how to use it (without duplicating the architecture doc).

---

## Non‑Goals (for this pass)

- We are **not** refactoring model selection (`SelectionManager`, `SelectionProvider`).
- We are **not** fully removing legacy supports yet—only avoiding them and keeping V2 selection logic separate and discoverable.
- We are **not** changing the highlighting system beyond making sure it still consumes `isSelected` correctly.
