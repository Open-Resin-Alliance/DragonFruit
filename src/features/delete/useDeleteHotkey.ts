import { useEffect } from 'react';
import { triggerDelete } from './deleteRegistry';
import { UNIVERSAL_HOTKEYS } from '@/hotkeys/hotkeyConfig';

function isTextInput(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (element.isContentEditable) return true;
  return false;
}

export function useDeleteHotkey() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey) return;
      const key = event.key;
      // Check against universal delete keys (Delete, Backspace)
      // Type assertion needed because config keys are readonly
      if (!(UNIVERSAL_HOTKEYS.DELETE.keys as readonly string[]).includes(key)) return;
      if (isTextInput(event.target)) return;

      const handled = triggerDelete();
      if (!handled) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
