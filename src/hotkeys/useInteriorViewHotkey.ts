import { useEffect, useRef } from 'react';
import { useActionActive } from './hotkeyStore';

export function useInteriorViewHotkey(onToggle: () => void, enabled: boolean) {
  const active = useActionActive('CAMERA', 'INTERIOR_VIEW');
  const wasActive = useRef(false);

  useEffect(() => {
    if (enabled && active && !wasActive.current) {
      onToggle();
    }
    wasActive.current = active;
  }, [active, enabled, onToggle]);
}
