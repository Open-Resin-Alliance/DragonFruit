import * as THREE from 'three';

/**
 * The scene's cross-section clip, outside React.
 *
 * The layer slider used to write `page.tsx` state, which re-rendered the whole
 * app on every tick: the scene, the models, the cap and the support tree. The
 * supports do not change during a scrub, so the slider now writes here and the
 * scene reads it imperatively. The stable plane array is replaced in place, so
 * materials that hold it see the new constants without a render.
 *
 * The gate is the page's cross-section switch: when it is closed the scene sees
 * no clip at all, whatever the slider says.
 */

export interface SceneClip {
  lower: number | null;
  upper: number | null;
}

let gateOpen = true;
let rawLower: number | null = null;
let rawUpper: number | null = null;
let clip: SceneClip = { lower: null, upper: null };
const planes: THREE.Plane[] = [];
const listeners = new Set<() => void>();

function recompute(): void {
  const lower = gateOpen ? rawLower : null;
  const upper = gateOpen ? rawUpper : null;
  if (lower === clip.lower && upper === clip.upper) return;
  clip = { lower, upper };
  planes.length = 0;
  if (lower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -lower));
  if (upper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), upper));
  for (const listener of listeners) listener();
}

export function setSceneClip(lower: number | null, upper: number | null): void {
  const nextLower = lower ?? null;
  const nextUpper = upper ?? null;
  if (nextLower === rawLower && nextUpper === rawUpper) return;
  rawLower = nextLower;
  rawUpper = nextUpper;
  recompute();
}

/** The page's cross-section switch. Closed hides the clip entirely. */
export function setSceneClipGate(open: boolean): void {
  if (gateOpen === open) return;
  gateOpen = open;
  recompute();
}

export function getSceneClip(): SceneClip {
  return clip;
}

/** The stable array. Its contents change on a scrub; its identity does not. */
export function getSceneClipPlanes(): THREE.Plane[] {
  return planes;
}

export function subscribeSceneClip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
