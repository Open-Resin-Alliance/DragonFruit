import { useEffect } from 'react';
import { triggerDelete } from './deleteRegistry';
import { UNIVERSAL_HOTKEYS } from '@/hotkeys/hotkeyConfig';

export function useDeleteHotkey() {
  useEffect(() => {
    const handleKeyDown = (event: CustomEvent) => {
      const { key, ctrlKey, metaKey, repeat } = event.detail;
      if (repeat || ctrlKey || metaKey) return;
      if (!(UNIVERSAL_HOTKEYS.DELETE.keys as readonly string[]).includes(key)) return;
      triggerDelete();
    };

    window.addEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
  }, []);
}
