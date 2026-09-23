import { useEffect } from 'react';
import {
  getSavedSpaceMouseSettings,
  subscribeToSpaceMouseSettings,
} from '@/components/settings/spacemousePreferences';
import { requestNativeSpaceMouse } from './nativeSpaceMouseBridge';

/**
 * Own the navlib session for the lifetime of the app.
 *
 * navlib is a process-wide singleton, but the controllers that drive it render
 * under `cameraInteractionCycleEnabled` — false for the intro and for every Home
 * reset — so a lifecycle bound to their mount tore the session down and created a
 * fresh one on each of those: a new navlib client, with the driver's state reset
 * and the pose handshake started over. The session follows the SpaceMouse setting
 * instead, which is the thing that actually decides whether it should exist.
 */
export function useNativeSpaceMouseLifecycle(): void {
  useEffect(() => {
    requestNativeSpaceMouse(getSavedSpaceMouseSettings().enabled);
    const unsubscribe = subscribeToSpaceMouseSettings(() => {
      requestNativeSpaceMouse(getSavedSpaceMouseSettings().enabled);
    });
    return () => {
      unsubscribe();
      requestNativeSpaceMouse(false);
    };
  }, []);
}
