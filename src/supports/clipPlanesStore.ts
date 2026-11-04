import * as THREE from 'three';

/**
 * The support layer's cross-section planes, outside React.
 *
 * A scrub changes only the plane constants; the supports themselves do not
 * move. Passing the clip values as props re-rendered every support detail
 * component and re-mapped the whole support list on each tick. This store holds
 * one stable array whose plane objects are replaced in place, so the renderer
 * can subscribe and update the materials' clipping planes without a render.
 */

const planes: THREE.Plane[] = [];
const listeners = new Set<() => void>();
let clipLower: number | null = null;
let clipUpper: number | null = null;

export function setSupportClipPlanes(lower: number | null, upper: number | null): void {
  if (lower === clipLower && upper === clipUpper) return;
  clipLower = lower;
  clipUpper = upper;
  planes.length = 0;
  if (lower != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -lower));
  if (upper != null) planes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), upper));
  for (const listener of listeners) listener();
}

/** The stable array. Its contents change on a scrub; its identity does not. */
export function getSupportClipPlanes(): THREE.Plane[] {
  return planes;
}

export function subscribeSupportClipPlanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
