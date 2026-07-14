import * as THREE from 'three';

export function getAbsSafeScaleComponents(scale: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    Math.max(1e-6, Math.abs(scale.x)),
    Math.max(1e-6, Math.abs(scale.y)),
    Math.max(1e-6, Math.abs(scale.z)),
  );
}

export function getDirectionScaleFactor(direction: THREE.Vector3, scale: THREE.Vector3): number {
  const dir = direction.clone();
  if (dir.lengthSq() <= 1e-12) {
    dir.set(0, 0, -1);
  } else {
    dir.normalize();
  }

  const absScale = getAbsSafeScaleComponents(scale);
  const scaledDir = new THREE.Vector3(
    dir.x * absScale.x,
    dir.y * absScale.y,
    dir.z * absScale.z,
  );
  return Math.max(1e-6, scaledDir.length());
}

export function getRadialScaleFactor(direction: THREE.Vector3, scale: THREE.Vector3): number {
  const dir = direction.clone();
  if (dir.lengthSq() <= 1e-12) {
    dir.set(0, 0, -1);
  } else {
    dir.normalize();
  }

  const helper = Math.abs(dir.z) < 0.9
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);

  const tangentA = helper.clone().cross(dir);
  if (tangentA.lengthSq() <= 1e-12) {
    tangentA.set(1, 0, 0);
  } else {
    tangentA.normalize();
  }
  const tangentB = dir.clone().cross(tangentA).normalize();

  const absScale = getAbsSafeScaleComponents(scale);
  const scaleAlong = (v: THREE.Vector3) => new THREE.Vector3(
    v.x * absScale.x,
    v.y * absScale.y,
    v.z * absScale.z,
  ).length();

  const sA = scaleAlong(tangentA);
  const sB = scaleAlong(tangentB);
  return Math.max(1e-6, (sA + sB) * 0.5);
}

export function getUniformScaleFactorForThickness(scale: THREE.Vector3): number {
  const absScale = getAbsSafeScaleComponents(scale);
  return Math.max(1e-6, (absScale.x + absScale.y + absScale.z) / 3);
}

export function worldMmToLocalMm(worldMm: number, scaleFactor: number): number {
  return Math.max(1e-4, worldMm / Math.max(1e-6, scaleFactor));
}

/** Convert a desired voxel size (mm in local space) to a voxel resolution
 *  count, given the model's largest bounding-box extent in local space.
 *  Clamped to [24, 192].
 *
 *  Callers MUST convert world-space voxel size to local space via
 *  `worldMmToLocalMm(voxelSizeMm, scaleFactor)` before calling this. */
export function computeVoxelResolution(voxelSizeMm: number, maxExtent: number): number {
  const raw = Math.round(maxExtent / Math.max(0.05, voxelSizeMm));
  return Math.min(192, Math.max(24, raw));
}
