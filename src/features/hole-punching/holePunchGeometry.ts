import * as THREE from 'three';
import type { MeshModifierOpenFace } from '@/features/mesh-modifiers/types';

export type HolePunchWorldFrame = {
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
};

export type HolePunchPlacementState = {
  id: string;
  modelId: string;
  worldPoint: THREE.Vector3;
  worldNormal: THREE.Vector3;
  worldFrame?: HolePunchWorldFrame;
  localPoint: THREE.Vector3;
  localNormal: THREE.Vector3;
  radiusMm: number;
  radiusYMm?: number;
  depthMm: number;
  depthMode: 'manual' | 'auto';
};

const HOLE_PUNCH_FRAME_REFERENCE_X = new THREE.Vector3(1, 0, 0);
const HOLE_PUNCH_FRAME_REFERENCE_Z = new THREE.Vector3(0, 0, 1);

export function createHolePunchWorldFrame(worldNormal: THREE.Vector3): HolePunchWorldFrame {
  const yAxis = worldNormal.clone();
  if (yAxis.lengthSq() <= 1e-12) {
    yAxis.set(0, 0, -1);
  } else {
    yAxis.normalize();
  }
  const displayY = yAxis.clone().negate();
  const upReference = Math.abs(displayY.dot(HOLE_PUNCH_FRAME_REFERENCE_Z)) < 0.92
    ? HOLE_PUNCH_FRAME_REFERENCE_Z.clone()
    : HOLE_PUNCH_FRAME_REFERENCE_X.clone();
  const displayZ = upReference
    .sub(displayY.clone().multiplyScalar(upReference.dot(displayY)))
    .normalize();
  const xAxis = displayY.clone().cross(displayZ).normalize();
  const zAxis = displayZ.negate();
  return { xAxis, yAxis, zAxis };
}

export function cloneHolePunchWorldFrame(frame: HolePunchWorldFrame): HolePunchWorldFrame {
  return {
    xAxis: frame.xAxis.clone(),
    yAxis: frame.yAxis.clone(),
    zAxis: frame.zAxis.clone(),
  };
}

export function normalizeDirectionTuple(x: number, y: number, z: number): [number, number, number] {
  const dir = new THREE.Vector3(x, y, z);
  if (dir.lengthSq() <= 1e-12) {
    return [0, 0, -1];
  }
  dir.normalize();
  return [dir.x, dir.y, dir.z];
}

export function inferOpenFaceFromHit(
  hit: THREE.Intersection,
  fallback: MeshModifierOpenFace,
): MeshModifierOpenFace {
  const normal = hit.face?.normal;
  if (!normal) return fallback;

  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);

  if (absX >= absY && absX >= absZ) {
    return normal.x >= 0 ? 'x_max' : 'x_min';
  }
  if (absY >= absX && absY >= absZ) {
    return normal.y >= 0 ? 'y_max' : 'y_min';
  }
  return normal.z >= 0 ? 'z_max' : 'z_min';
}
