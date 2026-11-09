import { useSyncExternalStore } from 'react';
import { detectPlatform, subscribeToPlatform } from './usePlatform';

// The server snapshot is 'Ctrl' so the first render matches the prerendered HTML.
export function usePlatformModifier(): string {
  return useSyncExternalStore(
    subscribeToPlatform,
    () => (detectPlatform() === 'mac' ? 'Cmd' : 'Ctrl'),
    () => 'Ctrl',
  );
}
