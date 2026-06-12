import * as THREE from 'three';

/**
 * Per-triangle "keep support-free" mask for a model. Stored on the geometry's
 * userData so it travels with the model (and survives world transforms, since it
 * lives in the geometry's own triangle ordering). 1 = protected, 0 = normal.
 *
 * This is the single source of truth shared by the face-paint UI and the
 * auto-orient scorer's `protectFaces` goal.
 */
const MASK_KEY = 'autoOrientProtectedMask';

export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const pos = geometry.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** Read the protected mask, or undefined if none/size-mismatched. */
export function getProtectedMask(geometry: THREE.BufferGeometry): Uint8Array | undefined {
  const mask = (geometry.userData as Record<string, unknown>)[MASK_KEY];
  if (mask instanceof Uint8Array && mask.length === triangleCount(geometry)) return mask;
  return undefined;
}

/** Get the existing mask or allocate a zeroed one sized to the geometry. */
export function ensureProtectedMask(geometry: THREE.BufferGeometry): Uint8Array {
  const existing = getProtectedMask(geometry);
  if (existing) return existing;
  const mask = new Uint8Array(triangleCount(geometry));
  (geometry.userData as Record<string, unknown>)[MASK_KEY] = mask;
  return mask;
}

export function clearProtectedMask(geometry: THREE.BufferGeometry): void {
  delete (geometry.userData as Record<string, unknown>)[MASK_KEY];
}

/** True if any triangle is flagged protected. */
export function hasProtectedFaces(geometry: THREE.BufferGeometry): boolean {
  const mask = getProtectedMask(geometry);
  if (!mask) return false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
  return false;
}

/** Number of triangles flagged protected. */
export function protectedFaceCount(geometry: THREE.BufferGeometry): number {
  const mask = getProtectedMask(geometry);
  if (!mask) return 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  return count;
}
