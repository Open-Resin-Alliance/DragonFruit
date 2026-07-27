import { useEffect } from 'react';
import { triggerDelete } from './deleteRegistry';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown } from '@/hotkeys/hotkeyConfig';

// `Delete` is always available as a fixed, non-configurable secondary delete key.
// The primary delete key is user-configurable via GLOBAL.DELETE (defaults to Backspace).
export const SECONDARY_DELETE_KEY = 'Delete';

export function useDeleteHotkey() {
  const { getHotkey } = useHotkeyConfig();

  useEffect(() => {
    const handleKeyDown = (event: CustomEvent) => {
      const detail = event.detail;
      if (detail.repeat) return;

      const isSecondaryDelete =
        detail.key === SECONDARY_DELETE_KEY &&
        !detail.ctrlKey && !detail.metaKey && !detail.altKey && !detail.shiftKey;

      if (!isSecondaryDelete && !matchesConfiguredHotkeyDown(detail, getHotkey('GLOBAL', 'DELETE'))) {
        return;
      }

      triggerDelete();
    };

    window.addEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
    return () => window.removeEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
  }, [getHotkey]);
}
