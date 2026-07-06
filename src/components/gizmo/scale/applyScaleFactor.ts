import * as THREE from 'three';
import type { GizmoAxis } from '../types';

const AXIS_INDEX: Record<GizmoAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export function applyScaleFactor(
  initial: THREE.Vector3,
  axis: GizmoAxis | 'uniform',
  factor: number,
): THREE.Vector3 {
  const clamped = Math.max(0.0001, factor);
  if (axis === 'uniform') {
    return initial.clone().multiplyScalar(clamped);
  }
  const i = AXIS_INDEX[axis];
  return initial.clone().setComponent(i, initial.getComponent(i) * clamped);
}
