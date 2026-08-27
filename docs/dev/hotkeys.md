# Hotkey System Developer Guide

The hotkey system's architecture and public API are documented in
[`../reference/hotkeys.md`](../reference/hotkeys.md); this page covers the rules
for working with it.

## Developer Rules

1. **No direct listeners**: Never use `window.addEventListener('keydown' | 'keyup')` or `element.onkeydown`.
   The system **monkey-patches `EventTarget.prototype.addEventListener`** (in
   `HotkeyRegistryManager.tsx`) to `console.error` any non-registry keydown/keyup
   listener registered on `window`/`document` — a direct listener is a lint failure at runtime.
2. **Hook usage**: React components read key state via `useActionActive(category, action)`.
3. **Sync lookup**: Performance-critical loops (e.g. Three.js render frame) read key state via `isKeyPressedSync(key)`.
4. **Modifying bindings**: Update `DEFAULT_KEYBINDINGS` in `hotkeyConfig.ts`.
5. **Toggles fire on the press edge**: `useActionActive` reports the binding as HELD, not
   as pressed. A toggle must compare against the previous value (see
   `useInteriorViewHotkey`, `useOrganicCutPreviewHotkey`) or it re-fires for as long as
   the key is down.
6. **Specificity suppression**: `isActionActiveSync(category, action)` suppresses a
   less-specific binding that is a strict subset of a held one — e.g. `GLOBAL.REDO`
   (Ctrl+Shift+Z) suppresses `GLOBAL.UNDO` (Ctrl+Z) while Shift is held. When reading
   both, check the more specific one first.
7. **Escape in a modal goes through `useEscapeToClose`**: dialogs do not wire
   their own `app-hotkey-keydown` listener. `useEscapeToClose(open, onClose)`
   (`src/hotkeys/useEscapeToClose.ts`) registers the dialog while it is open;
   only the most recently registered one reacts, and it consumes the press, so
   a nested dialog closes before its parent and one press never closes two.
   Pass no handler for a dialog that must not be dismissed by Escape (a
   blocking progress overlay, a decision the user has to make): it then
   swallows the key instead of letting it through to the scene. Dialogs built
   on `StructuredDialogModal` get this for free.
8. **The delete hotkey goes through the delete registry**: `useDeleteHotkey` calls
   `triggerDelete()` (`src/features/delete/deleteRegistry.ts`), not a direct handler —
   see `registration-seams.md`.

## Raw events

`setupHotkeyListeners()` (`HotkeyRegistryManager.tsx`) installs capture-phase
`keydown`/`keyup` listeners that push into the store and re-dispatch a
`CustomEvent('app-hotkey-keydown'` / `'app-hotkey-keyup')` whose `detail` is
`{ key, code, repeat, ctrlKey, metaKey, shiftKey, altKey }`. Prefer the store
API over listening to these events directly.

`suspendHotkeyDispatch()` / `resumeHotkeyDispatch()` (from `HotkeyRegistryManager.tsx`)
temporarily suspend dispatch — used while the settings key-recorder is capturing
so the binding being recorded doesn't also fire its action.
