import { useEffect, useRef } from 'react';
import { useActionActive } from './hotkeyStore';

export function useCameraFocusHotkey(onTrigger: () => void) {
  const active = useActionActive('CAMERA', 'FOCUS_PICK');
  const wasActive = useRef(false);

  useEffect(() => {
    if (active && !wasActive.current) {
      onTrigger();
    }
    wasActive.current = active;
  }, [active, onTrigger]);
}
