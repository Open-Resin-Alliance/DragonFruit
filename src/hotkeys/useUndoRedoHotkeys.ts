import { useEffect } from 'react';
import { redo, undo } from '@/history/historyStore';
import { UNIVERSAL_HOTKEYS } from './hotkeyConfig';

function isTextInput(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (element.isContentEditable) return true;
  return false;
}

export function useUndoRedoHotkeys() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      const isMeta = event.metaKey || event.ctrlKey;
      if (!isMeta) return;
      const key = event.key.toLowerCase();

      // Windows/Linux-friendly redo shortcut.
      if (key === 'y') {
        event.preventDefault();
        redo();
        return;
      }

      if (key !== UNIVERSAL_HOTKEYS.UNDO.key) return;

      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
