import * as THREE from 'three';
import type { ModelHollowingModifier } from './types';

export type RotationQuatTuple = [number, number, number, number];

/** Average |scale| across the three axes, floored away from zero — the same
 *  factor page.tsx uses to convert world-space mm (voxel size, shell
 *  thickness) into the model's local space before hollowing. */
export function getUniformScaleFactorForThickness(scale: THREE.Vector3): number {
  const ax = Math.max(1e-6, Math.abs(scale.x));
  const ay = Math.max(1e-6, Math.abs(scale.y));
  const az = Math.max(1e-6, Math.abs(scale.z));
  return Math.max(1e-6, (ax + ay + az) / 3);
}

export function worldMmToLocalMm(worldMm: number, scaleFactor: number): number {
  return Math.max(1e-4, worldMm / Math.max(1e-6, scaleFactor));
}

/** Convert a desired voxel size (mm in local space) to a voxel resolution
 *  count, given the model's largest bounding-box extent in local space.
 *  Clamped to [24, 192]. Callers MUST convert world-space voxel size to
 *  local space via `worldMmToLocalMm` first. */
export function computeVoxelResolution(voxelSizeMm: number, maxExtent: number): number {
  const raw = Math.round(maxExtent / Math.max(0.05, voxelSizeMm));
  return Math.min(192, Math.max(24, raw));
}

/** Order-sensitive FNV-1a hash over blocked voxel indices. Used in cache
 *  signatures instead of JSON.stringify (a large lasso selection would
 *  otherwise serialize to tens of MB of key string — see audit item #23). */
export function hashBlockedVoxelIndices(indices: readonly number[]): string {
  let hash = 0x811c9dc5;
  for (const value of indices) {
    hash ^= value & 0xffff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 16) & 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${indices.length}:${(hash >>> 0).toString(16)}`;
}

export function getRotationQuatTuple(rotation: THREE.Euler): RotationQuatTuple {
  const quat = new THREE.Quaternion().setFromEuler(rotation);
  return [quat.x, quat.y, quat.z, quat.w];
}

/** True when two quaternions encode the same rotation. q and -q are the same
 *  rotation (double cover), so compare via |dot| instead of componentwise. */
export function rotationQuatTuplesMatch(
  a: RotationQuatTuple,
  b: RotationQuatTuple,
  epsilon = 1e-6,
): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(dot) >= 1 - epsilon;
}

/** Rotation folded into cache signatures: quantized to 1e-5 so float noise
 *  below the harmless-drift threshold (see audit "Verified-OK": quaternion
 *  round-trip drift ~1e-5 mm) cannot thrash keys, and sign-canonicalized so
 *  q and -q agree. */
export function buildRotationSignature(rotation: THREE.Euler): string {
  const quat = new THREE.Quaternion().setFromEuler(rotation);
  const sign = quat.w < 0 ? -1 : 1;
  const q = (v: number) => Math.round(sign * v * 1e5) / 1e5;
  return `${q(quat.x)},${q(quat.y)},${q(quat.z)},${q(quat.w)}`;
}

export type BlockedVoxelValidity = 'valid' | 'stamp-legacy' | 'stale';

/** Decides what to do with a model's committed blocked voxels given its
 *  current scene rotation:
 *  - 'valid':        rotation still matches the commit-time stamp (or there
 *                    are no blockers);
 *  - 'stamp-legacy': blockers predate the rotation stamp (data persisted
 *                    before this change) — adopt the current rotation as the
 *                    stamp rather than destroying the user's selection;
 *  - 'stale':        rotation changed since commit — the linear indices
 *                    address a different rotation-aligned grid and must be
 *                    cleared. */
export function resolveBlockedVoxelValidity(
  hollowing:
    | Pick<ModelHollowingModifier, 'blockedVoxelIndices' | 'blockedVoxelRotationQuat'>
    | null
    | undefined,
  currentQuat: RotationQuatTuple,
): BlockedVoxelValidity {
  if (!hollowing?.blockedVoxelIndices?.length) return 'valid';
  if (!hollowing.blockedVoxelRotationQuat) return 'stamp-legacy';
  return rotationQuatTuplesMatch(hollowing.blockedVoxelRotationQuat, currentQuat)
    ? 'valid'
    : 'stale';
}
