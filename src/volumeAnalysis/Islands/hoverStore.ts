import { useSyncExternalStore } from 'react';

let hoveredIslandId: number | null = null;
const listeners = new Set<() => void>();

export function setHoveredIslandId(id: number | null) {
  hoveredIslandId = id;
  listeners.forEach((l) => l());
}

export function getHoveredIslandId() {
  return hoveredIslandId;
}

export function subscribeHoveredIslandId(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHoveredIslandId() {
  return useSyncExternalStore(subscribeHoveredIslandId, getHoveredIslandId);
}
