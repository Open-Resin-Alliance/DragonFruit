# Hotkey System Reference

Centralized Zustand state store controls all key bindings.

## Architecture

- **Store**: `src/hotkeys/hotkeyStore.ts`
- **Config**: `src/hotkeys/hotkeyConfig.ts`
- **Listener Manager**: `src/hotkeys/HotkeyRegistryManager.tsx`

Rules for working with the system — listener hygiene, press-edge toggles,
specificity suppression, the delete registry, and the raw keydown/keyup event
contract — live in the [Hotkey System Developer Guide](../dev/hotkeys.md).

## API Reference

### `useActionActive(category: string, actionName: string): boolean`
React hook. Reactive to modifier changes. Excludes overlapping modifiers.

### `isKeyPressedSync(key: string): boolean`
Non-reactive getter. Direct Set lookup. Use in high-frequency requestAnimationFrame loops.

### `useEscapeToClose(open: boolean, onClose?: () => void): void`
React hook. Registers a dialog as the Escape target while `open`. Only the
most recently registered dialog reacts, and it consumes the press. Omit
`onClose` to swallow Escape (non-dismissible dialog). Non-React callers use
`registerEscapeHandler(handler)`, which returns its unregister function.
