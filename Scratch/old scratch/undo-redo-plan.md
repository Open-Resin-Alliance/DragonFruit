# Undo / Redo History Plan

## Purpose
- Provide a reusable history system that any domain (supports, STL mesh, future features) can use to track reversible actions.
- Keep the history mechanism independent of how actions are triggered (Delete key, buttons, scripts, etc.).
- Support global Undo/Redo hotkeys and optional UI buttons.

## Key Components
1. **History Types**
   - `src/history/historyTypes.ts` defines a discriminated union of actions (`delete-support`, `delete-mesh`, `add-support`, `update-transform`, etc.).
   - Each type includes the data necessary to both undo *and* redo the action (e.g., a full snapshot of the entity before/after change).

2. **History Store** (`src/history/historyStore.ts`)
   - Maintains `undoStack`, `redoStack` (arrays of actions).
   - Public API:
     - `pushHistory(action)` – pushes onto undo stack, clears redo stack.
     - `undo()` / `redo()` – pops from appropriate stack and dispatches to registered handlers.
     - `clearHistory()` – resets stacks (e.g., when loading a new project).
     - Optional subscription for UI to enable/disable undo/redo buttons.
   - Uses a handler registry: `registerHistoryHandler(type, handler)` where `handler(action, direction)` performs the actual domain change. `direction` is `'undo'` or `'redo'`.

3. **Domain Handlers**
   - **Supports**: snapshot trunk/root/etc. on mutations; handlers reinsert/remove/replace data in `supports/state.ts`.
   - **Scene/Mesh**: handler restores previous mesh file URL/name, or clears it when redoing delete.
   - Future domains register their handlers without touching core history logic.

4. **Integration Pattern**
   - When a domain performs a reversible action, it executes the action *and* calls `pushHistory(...)` with the payload needed to reverse it.
   - `undo()` pops an action, invokes handler with `'undo'`, and pushes the action onto `redoStack`. Redo mirrors the process.
   - Handlers should return a boolean so the store can skip pushing to opposite stack when undo fails.

5. **Hotkeys / UI**
   - A separate hook (e.g., `useUndoRedoHotkeys`) listens for `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (or `Ctrl/Cmd+Y`) and calls `historyStore.undo/redo`.
   - UI buttons can simply call the same store methods.

6. **Data Integrity**
   - Prefer deep snapshots (e.g., `JSON.stringify/parse`) when storing actions to avoid accidental mutation.
   - Consider size limits or compression if actions become large; for now, prioritize correctness.

7. **Testing Checklist**
   - Add/remove support then undo/redo; verify selection/hover states update accordingly.
   - Clear mesh, undo, redo; ensure geometry and metadata restore correctly.
   - Confirm redo stack clears after new action following an undo.
   - Clear history when loading new scene/project to avoid stale references.

## Next Steps
1. Scaffold `src/history/` folder with store + types + handler registry.
2. Implement support-domain handlers and wire pushHistory into support mutations.
3. Implement mesh-domain handers.
4. Add global undo/redo hotkeys and optionally UI controls.
5. Manual QA per checklist; plan automated tests later if needed.
