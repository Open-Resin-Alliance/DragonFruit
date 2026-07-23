import { useEffect } from 'react';
import { redo, undo } from '@/history/historyStore';
import { hotkeyStore, isPrimaryModifierPressed } from './hotkeyStore';

export function useUndoRedoHotkeys({ disabled = false }: { disabled?: boolean } = {}) {
  useEffect(() => {
    if (disabled) return;

    let wasZPressed = false;
    let wasYPressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const hasPrimaryModifier = isPrimaryModifierPressed(active);
      const hasShift = active.has('shift');
      const hasZ = active.has('z');
      const hasY = active.has('y');

      const isZJustPressed = hasZ && !wasZPressed;
      const isYJustPressed = hasY && !wasYPressed;

      if (hasPrimaryModifier) {
        if (isYJustPressed) {
          redo();
        } else if (isZJustPressed) {
          if (hasShift) {
            redo();
          } else {
            undo();
          }
        }
      }

      wasZPressed = hasZ;
      wasYPressed = hasY;
    });

    return unsubscribe;
  }, [disabled]);
}
