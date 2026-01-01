import { useEffect } from 'react';
import { DEFAULT_KEYBINDINGS, matchesConfiguredHotkeyDown } from './hotkeyConfig';

function isTextInput(element: EventTarget | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (element.isContentEditable) return true;
  return false;
}

const CAMERA_FOCUS_KEY = DEFAULT_KEYBINDINGS.CAMERA.FOCUS_PICK.key;

export function useCameraFocusHotkey(onTrigger: () => void) {

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;

      const matches = matchesConfiguredHotkeyDown(e, { key: CAMERA_FOCUS_KEY });
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
  }, [onTrigger]);
}
