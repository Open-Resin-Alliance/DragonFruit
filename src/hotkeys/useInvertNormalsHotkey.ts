import { useEffect, useRef } from 'react';
import { useActionActive } from './hotkeyStore';

export function useInvertNormalsHotkey(onToggle: () => void) {
  const active = useActionActive('MESH', 'INVERT_NORMALS');
  const wasActive = useRef(false);

  useEffect(() => {
    if (active && !wasActive.current) {
      onToggle();
    }
    wasActive.current = active;
  }, [active, onToggle]);
}
