# Global Delete + Undo/Redo Plan

## Goals
- Provide a single history system that any domain (supports, STL mesh, future tools) can use for undo/redo.
- Expose general Delete, Undo, and Redo hotkeys so users do not need mode-specific shortcuts.
- Ensure domain modules remain responsible for executing their own actions, but share the same history and hotkey infrastructure.

## Proposed Architecture
1. **History Domain (`src/history/`)**
   - `historyTypes.ts`: Discriminated union of undoable actions, e.g. `delete-support`, `delete-mesh`, `load-mesh`, `add-support`, etc. Each action carries enough data to undo/redo itself.
   - `historyStore.ts`: Maintains `undoStack`, `redoStack`, exposes `pushHistory(action)`, `undo()`, `redo()`, `clearHistory()`, and a subscriber API for UI (e.g., disabling buttons when stacks are empty).
   - `applyHistoryAction(action, direction)` delegates to domain-specific restorers registered with the store (e.g., support module registers handlers for support actions).

2. **Domain Integration**
   - **Supports (`src/supports/state.ts`)**
     - Add `removeTrunkWithRoot(trunkId)` (and later branch/knot variants) that snapshots both trunk and root before deletion.
     - Register history handlers so undoing a support deletion re-inserts the snapshots, while redoing removes them again.
     - Ensure selection/hover state is cleared when an item is removed or restored.
   - **Scene Manager (`src/features/scene/useSceneManager.ts`)**
     - Expose `clearMesh()` that nulls out `fileUrl`, `fileName`, and dependent derived state, pushing a `delete-mesh` action containing previous file metadata.
     - Undo handler restores prior mesh (recreating the blob URL if needed) and reinitializes geometry; redo clears again.
   - **Future domains** follow the same pattern by registering their action handlers.

3. **Hotkeys (`src/features/hotkeys/`)**
   - `useGlobalDeleteHotkey()`
     - On `Delete`/`Backspace`, determine active context:
       1. If support mode & a support/joint is selected, call support deletion.
       2. Else if a mesh is loaded/selected, call `clearMesh()`.
       3. Allow future contexts (e.g., gizmos, island selections) via a simple priority registry.
     - Ignore events originating in input/textarea fields.
   - `useUndoRedoHotkeys()`
     - Attach `Ctrl/Cmd+Z` → `historyStore.undo()` and `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` → `historyStore.redo()`.
     - Hotkeys are global (mounted once in `page.tsx`).

4. **Registration Flow**
   - On app initialization, each domain calls `registerHistoryHandler('delete-support', handler)` (or similar).
   - `historyStore.undo()` pops an action and calls the registered handler with `direction = 'undo'`; same for redo.
   - Handlers return a boolean to indicate success; failed undo/redo can be logged and skipped.

5. **Data Requirements**
   - **Support deletion action payload**: `trunk`, `root`, optionally derived kids (segments, joints). Use existing builder output or store snapshot utilities.
   - **Mesh deletion payload**: `fileUrl`, `fileName`, perhaps serialized transform/layer state if those should revert as well.
   - Everything should be serializable to JSON to ease future persistence.

6. **Testing / Verification Checklist**
   - Place a trunk → Delete → Undo → Redo, ensuring selection and visuals update correctly.
   - Load STL → Delete (clears canvas) → Undo (mesh returns with same color/visibility) → Redo.
   - Confirm Delete hotkey respects focus and mode (no accidental deletions while typing).
   - Ensure undo/redo stacks clear when loading a new project (optional follow-up if needed).

## Next Steps
1. Scaffold `src/history/` with store + types + handler registry.
2. Wire supports domain into the history layer (snapshot helpers, deletion commands).
3. Add mesh deletion + history payloads in scene manager.
4. Implement global hotkey hooks and mount them in `page.tsx`.
5. Manual QA pass on both supports and mesh flows; add follow-up tasks for automated tests if desired.
