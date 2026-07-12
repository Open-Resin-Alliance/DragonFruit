import { useEffect, useRef } from 'react';
import { useActionActive } from './hotkeyStore';
import { toggleCameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';

export function useCameraProjectionHotkey() {
  const active = useActionActive('CAMERA', 'TOGGLE_PROJECTION');
  const wasActive = useRef(false);

  useEffect(() => {
    if (active && !wasActive.current) {
      toggleCameraProjectionMode();
    }
    wasActive.current = active;
  }, [active]);
}
