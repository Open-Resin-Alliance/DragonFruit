import { useEffect } from 'react';
import { redo, undo } from '@/history/historyStore';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';

export function useUndoRedoHotkeys({ disabled = false }: { disabled?: boolean } = {}) {
  useEffect(() => {
    if (disabled) return;

    let wasUndoActive = false;
    let wasRedoActive = false;

    const unsubscribe = hotkeyStore.subscribe(() => {
      // Undo/Redo are user-configurable via GLOBAL.UNDO / GLOBAL.REDO. Redo is a
      // strict superset of Undo (adds Shift by default), so it is checked first;
      // isActionActiveSync also suppresses Undo whenever Redo is the active match.
      const isUndoActive = isActionActiveSync('GLOBAL', 'UNDO');
      const isRedoActive = isActionActiveSync('GLOBAL', 'REDO');

      if (isRedoActive && !wasRedoActive) {
        redo();
      } else if (isUndoActive && !wasUndoActive) {
        undo();
      }

      wasUndoActive = isUndoActive;
      wasRedoActive = isRedoActive;
    });

    return unsubscribe;
  }, [disabled]);
}
