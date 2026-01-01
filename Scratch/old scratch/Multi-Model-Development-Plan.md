# Multi-Model Scene Development Plan

## 1. Goals & UX Expectations
- Allow multiple STL models on the build plate simultaneously, each independently selectable, transformable, hideable, and removable.
- Provide a per-model stats card that updates whenever a model is selected; when no model is active, the card shows a neutral “no model selected” state.
- Introduce a modular Model Manager panel that can live anywhere (sidebar, floating card, etc.) without layout coupling, listing all loaded models with key controls (select, hide/show, delete, rename).
- Limit island scanning to the currently selected model to keep operations fast and scoped.
- Preserve existing support placement, history, and hotkey expectations while scaling to multiple models.

## 2. User Flow Overview (Plain Language)
1. The user uploads one or more STL files via the existing Load button (accept multi-select). Each file appears in the Model Manager panel with its name, visibility toggle, and a select button.
2. Clicking a model entry sets it as the active model. The stats card updates to show polygon count, height, orientation, and island scan info for that selection. Transform controls, slicing sliders, and support tools latch onto this active model.
3. If the user hides a model, it disappears from the scene but stays in the list; deleting removes it entirely and frees memory/object URLs.
4. Running an island scan only processes the active model; scan progress, overlays, and island lists are tied to that model. Switching models swaps the displayed scan data.
5. If no model is selected, interactions that require a target (transform, supports, scan) are disabled or prompt the user to select one first, while the stats card shows blanks.

## 3. State Model & Data Flow
### Plain Language
- Replace the single `fileUrl/geom` pair with a collection of `models[]`, each holding metadata (id, name), STL blob URL, parsed geometry, per-model transform, visibility flag, and scan results.
- Track `activeModelId`. All features that previously relied on the lone `scene.geom` receive the `activeModel` object instead.
- Maintain derived lists/metrics in memoized selectors so the UI can read polygon counts, heights, and scan status quickly.

### Technical Notes
- New hook `useSceneCollectionManager` exposing: `models`, `activeModelId`, `setActiveModel`, `loadFiles(FileList)`, `updateModelTransform(id, transform)`, `setVisibility`, `renameModel`, `deleteModel`, `getModelStats(id)`.
- Each model entry stores `geom: GeometryWithBounds`, `transform: ModelTransform`, `meshColor`, `meshVisible`, `scanData`, `scanStatus`.
- Object URLs revoked in `deleteModel` + on unmount; limit total simultaneous loads (e.g., cap to 5 models, show warning otherwise).
- Provide context/provider so nested hooks (supports, slicing, islands) can subscribe to `activeModel` changes via `useActiveModel()`.

## 4. Loading & File Handling
### Plain Language
- Update the Load STL input to accept multiple files and queue them; each file begins loading immediately and appears in the Model Manager when ready.
- Show transient loading state per file (e.g., “Processing…”) until geometry prep finishes.
- Reset the input after each selection so the same file can be re-imported.

### Technical Notes
- Change `<input type="file">` to `multiple` and pass the entire `FileList` to `scene.loadFiles`.
- Use `Promise.allSettled` or sequential `for..of` to avoid saturating memory; optionally throttle BVH acceleration to one file at a time.
- When a file finishes loading, auto-select it (if no active model) and push a history entry `scene:add-model` for undo/redo.

## 5. Rendering & Selection
### Plain Language
- `SceneCanvas` renders one `<StlMesh>` per model. Each mesh integrates with the selection system so clicking it highlights the matching Model Manager entry and updates the stats card.
- Only the active model exposes transform gizmos and accepts support placement; other models stay static unless selected.
- The selection outline/spotlight effect should wrap whichever model is active and in prepare mode.

### Technical Notes
- Replace single `meshRef` with dictionary keyed by model id; pass `modelId` into `StlMesh` props for picking events.
- Update `SelectionProvider` to handle multiple IDs; fire events like `window.dispatchEvent(new CustomEvent('model-clicked',{detail:{modelId}}))` per mesh.
- Transform toolbar uses `activeModel.transform`; when gizmo moves, call `updateModelTransform(activeModelId, newTransform)`.
- Support renderer & placement hooks receive `activeModel.transform` for world-to-model calculations; guard when no model selected.

## 6. Model Manager Panel
### Plain Language
- Create a self-contained card component (e.g., `ModelManagerPanel`) listing models with controls:
  - Select button / row click to set active model.
  - Eye icon to toggle visibility.
  - Trash or contextual menu to delete.
  - Optional rename inline.
- Display quick stats (polygons, height) under each entry for context.
- Keep the component position-agnostic; export it so callers can place it in the sidebar or floating area.

### Technical Notes
- Component props: `models`, `activeModelId`, `onSelect`, `onToggleVisibility`, `onDelete`, `onRename`.
- Use React Portal or absolute positioning wrapper if we want to float it temporarily.
- Ensure keyboard accessibility (focusable buttons, ARIA labels).

## 7. Stats Card & Info Overlay
### Plain Language
- Update the existing bottom-left stats card to read from `activeModel`. Show placeholder text when none selected.
- Include orientation (Euler angles), scale, polygon count, height, and latest island count (if scan done). Possibly show last scan timestamp.

### Technical Notes
- Replace direct references to `scene.geom` and `slicing.*` with conditional logic: `activeModel ? activeModel.geom : null`.
- Hook slicing height and layer slider to the active model’s transform/geometry; disable slider if no model selected.
- Format island counts from `activeModel.scanData`; when absent, show “—”.

## 8. Island Scanning Workflow
### Plain Language
- Scan buttons operate only when a model is selected. Progress bars and island lists show data for that model alone.
- Switching models swaps the overlay markers and voxel controls to the corresponding dataset; unsaved scans stay tied to their model.

### Technical Notes
- Refactor `useIslandManager` to accept `{ geom, transform, modelId }`. Maintain a per-model cache of scan results keyed by ID.
- Provide APIs `setScanData(modelId, data)` and `getScanData(modelId)`; when active model changes, `SceneCanvas` receives the appropriate overlays.
- Ensure scan history entries record the model ID for undo.

## 9. Supports & Interaction Modes
### Plain Language
- Support placement and joint editing should apply to supports associated with the active model. If no model is selected, entering support mode should prompt the user to pick one.
- Deleting a model also removes its supports (with undo snapshots).

### Technical Notes
- Extend supports store to namespace supports by `modelId` (e.g., `supportsByModelId`); `useSupportInteractionManager` accesses the slice for the active model.
- History actions include `{ modelId }` to differentiate sequences.
- When active model changes, update selection/highlight state to avoid referencing stale supports.

## 10. Delete & Undo Integration
### Plain Language
- Pressing Delete should remove the selected model when in Prepare mode (higher priority than scene fallback), revoking its object URL and clearing scans/supports.
- Undo/redo needs to restore model entries, transforms, scans, and supports.

### Technical Notes
- Register delete handler per active model, e.g., `delete:model`. On delete, push history payload containing serialized model info + attachments (supports, scans, settings).
- Implement `scene:add-model` and `scene:remove-model` actions in `historyStore`.

## 11. Implementation Phases
1. **State & Loader Foundation**: Introduce multi-model state, multi-file loader, active selection context. Ensure single-model UX still works.
2. **Rendering & Transform Refactor**: Update `SceneCanvas`, transform toolbar, and selection logic to operate on active model.
3. **Model Manager & Stats Card**: Build the modular panel, wire stats card to active model, add blank state handling.
4. **Island Scan & Support Scoping**: Refactor slicing/island/support domains to reference `activeModel`; enforce per-model scans.
5. **Delete/Undo Enhancements**: Hook multi-model actions into history and delete registry.
6. **Polish & QA**: Validate interactions (load multiple STLs, switch models, scan per model, delete/undo) and track any performance regressions.

## 12. Testing & Validation
- Unit tests (where practical) for new hooks managing model collections.
- Manual scenarios:
  1. Load two STLs, switch selection, verify stats card updates.
  2. Hide/show models and confirm transforms persist.
  3. Run island scan on model A, switch to model B (no scan), ensure overlays update correctly.
  4. Place supports on model A, switch to model B and ensure supports stay scoped.
  5. Delete model A, undo, verify geometry/supports/scan data return.
- Performance watchpoints: BVH construction when loading many files, GPU picking with multiple meshes, memory cleanup when deleting.
