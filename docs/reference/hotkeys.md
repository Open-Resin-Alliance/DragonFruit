# Hotkey System Specification

Centralized Zustand state store controls all key bindings.

## Architecture

- **Store**: `DragonFruit/src/hotkeys/hotkeyStore.ts`
- **Config**: `DragonFruit/src/hotkeys/hotkeyConfig.ts`
- **Listener Manager**: `DragonFruit/src/hotkeys/HotkeyRegistryManager.tsx`

## Developer Rules

1. **No direct listeners**: Never use `window.addEventListener('keydown' | 'keyup')` or `element.onkeydown`.
2. **Hook usage**: React components read key state via `useActionActive(category, action)`.
3. **Sync lookup**: Performance-critical loops (e.g. Three.js render frame) read key state via `isKeyPressedSync(key)`.
4. **Modifying bindings**: Update `DEFAULT_KEYBINDINGS` in `hotkeyConfig.ts`.

## API Reference

### `useActionActive(category: string, actionName: string): boolean`
React hook. Reactive to modifier changes. Excludes overlapping modifiers.

### `isKeyPressedSync(key: string): boolean`
Non-reactive getter. Direct Set lookup. Use in high-frequency requestAnimationFrame loops.
