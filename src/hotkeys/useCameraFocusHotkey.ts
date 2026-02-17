import { useEffect } from 'react';
import { matchesConfiguredHotkeyDown } from './hotkeyConfig';
import { useHotkeyConfig } from './HotkeyContext';

function isTextInput(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (element.isContentEditable) return true;
  return false;
}

export function useCameraFocusHotkey(onTrigger: () => void) {
  const { getHotkey } = useHotkeyConfig();
  const focusKey = getHotkey('CAMERA', 'FOCUS_PICK');

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;

      const matches = matchesConfiguredHotkeyDown(e, { key: focusKey.key, modifier: focusKey.modifier });
      if (matches && !e.repeat) {
        e.preventDefault();
        onTrigger();
      }
    };

    const blur = () => {
      // No-op: stateless hotkey
    };

    window.addEventListener('keydown', down, true);
    window.addEventListener('blur', blur);

    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('blur', blur);
    };
  }, [onTrigger, focusKey]);
}
