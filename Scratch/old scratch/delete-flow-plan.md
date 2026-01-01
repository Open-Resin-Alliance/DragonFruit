# Delete Flow Plan

## Objectives
- Centralize keyboard Delete handling while keeping the logic decoupled from undo/redo.
- Allow multiple domains (supports, STL mesh, future tools) to register delete handlers with priority/order.
- Ensure Delete respects current mode, selection state, and input focus.

## Proposed Approach
1. **Delete Context Registry**
   - Create a lightweight registry (e.g., `src/delete/deleteRegistry.ts`) exposing:
     - `registerDeleteHandler(getCanDelete, performDelete, priority)`
     - `getActiveDeleteHandler()` to determine which handler should run.
   - Each domain registers a handler that can tell whether it can currently delete and how to perform the delete.
   - Priority determines which handler wins when multiple contexts are valid (e.g., selected joint vs. background mesh).

2. **Domain Handlers**
   - **Supports**: handler checks `selectedCategory` (joint/support) in Support state. `performDelete` removes the relevant entity (e.g., trunk + root) and pushes domain history entry.
   - **Mesh/Scene**: handler verifies mesh is loaded and not already being deleted; `performDelete` clears the mesh (reset file URL/name, hide geometry).
   - **Future**: e.g., selection gizmo, island overlays can register their own handlers without changing the Delete hook.

3. **Global Delete Hook**
   - `useDeleteHotkey()` (mount in `page.tsx`) listens for `Delete`/`Backspace`.
   - Ignores key presses originating in text inputs/textarea or when modifier keys (Ctrl/Meta) are held.
   - Calls `getActiveDeleteHandler()`; if one exists, executes `performDelete` and prevents default event propagation.
   - Optional: expose imperative `triggerDelete()` so UI buttons can share the same flow.

4. **Selection & Feedback**
   - Each handler is responsible for clearing selection/hover state after deletion to avoid stale references.
   - Consider a toast/log entry summarizing what was deleted (optional nice-to-have).

5. **Testing Checklist**
   - Support mode: select trunk, press Delete → trunk removed, selection cleared.
   - Prepare/support mode: no support selected, mesh loaded, press Delete → mesh cleared.
   - Inputs focused (e.g., sidebar fields): Delete should edit text, not trigger removal.
   - Multiple contexts: ensure handler priority behaves correctly (e.g., selected joint takes precedence over general mesh delete).

## Next Steps
1. Implement delete registry utility.
2. Wire support deletion into registry (with selection awareness and history push).
3. Wire mesh deletion handler.
4. Add global Delete hotkey hook to `page.tsx`.
5. QA the scenarios listed above.
