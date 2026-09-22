/**
 * Module store for the support placement guide plane.
 *
 * The guide is the horizontal line the model is tinted along where a tip would
 * land. Two things move it: hovering a model in Support mode, and dragging a
 * tip along the surface, which is how tips get levelled against one line.
 *
 * Components subscribe to "is the plane set" only -- that flips on enter and
 * leave, never per pointer move. The Z itself is read imperatively every frame
 * by the guide's material, because notifying per move would re-render the scene
 * per frame, and quantizing the Z to avoid that is what made the line step
 * across shallow faces (a z step of d moves the contour by d / tan(tilt) on
 * screen, which is pixels on a shallow face and nothing on a steep one).
 */

import { useSyncExternalStore } from 'react';

let planeZ: number | null = null;
let planeActive = false;

const activeListeners = new Set<() => void>();

export function setSupportPlacementGuideZ(nextZ: number | null): void {
  const next = typeof nextZ === 'number' && Number.isFinite(nextZ) ? nextZ : null;
  if (next === planeZ) return;
  planeZ = next;

  const nextActive = next !== null;
  if (nextActive === planeActive) return;
  planeActive = nextActive;
  activeListeners.forEach((listener) => listener());
}

/** Read per frame by the guide material. Deliberately not a subscription. */
export function getSupportPlacementGuideZ(): number | null {
  return planeZ;
}

export function getSupportPlacementGuideActive(): boolean {
  return planeActive;
}

export function getSupportPlacementGuideServerSnapshot(): boolean {
  return false;
}

export function subscribeSupportPlacementGuideActive(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/** Mounts the guide overlay; flips on enter and leave, not per pointer move. */
export function useSupportPlacementGuideActive(): boolean {
  return useSyncExternalStore(
    subscribeSupportPlacementGuideActive,
    getSupportPlacementGuideActive,
    getSupportPlacementGuideServerSnapshot,
  );
}
