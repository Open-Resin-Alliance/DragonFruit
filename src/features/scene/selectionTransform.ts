import * as THREE from 'three';

import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/**
 * How a multi-model selection turns: as one rigid block about the selection's
 * centre, or each model about its own origin with the positions left alone.
 */
export type SelectionRotationMode = 'group' | 'individual';

export type SelectionTransformEntry = {
  id: string;
  transform: ModelTransform;
};

function cloneTransform(transform: ModelTransform): ModelTransform {
  return {
    position: transform.position.clone(),
    rotation: transform.rotation.clone(),
    scale: transform.scale.clone(),
  };
}

function safeRatio(next: number, current: number) {
  if (Math.abs(current) <= 1e-8) return 1;
  const ratio = next / current;
  return Number.isFinite(ratio) ? ratio : 1;
}

/** The centre the gizmo sits on: the mean of the models' positions. */
export function getSelectionPivot(entries: readonly SelectionTransformEntry[]): THREE.Vector3 | null {
  if (entries.length === 0) return null;
  const pivot = new THREE.Vector3();
  entries.forEach((entry) => pivot.add(entry.transform.position));
  return pivot.multiplyScalar(1 / entries.length);
}

/**
 * Turns the selection by the rotation that takes the active model from its
 * `before` rotation to `activeRotation`, in world axes. In `group` mode every
 * position orbits `pivot` by that same rotation, so the selection keeps its
 * shape; in `individual` mode the positions stay put.
 */
export function rotateSelectionFromActive(
  before: readonly SelectionTransformEntry[],
  activeModelId: string,
  activeRotation: THREE.Euler,
  mode: SelectionRotationMode,
  pivot: THREE.Vector3 | null = getSelectionPivot(before),
): SelectionTransformEntry[] {
  const active = before.find((entry) => entry.id === activeModelId);
  if (!active || !pivot) return [];

  const delta = quaternionFromGlobalEuler(activeRotation)
    .multiply(quaternionFromGlobalEuler(active.transform.rotation).invert());

  return before.map(({ id, transform }) => {
    const rotation = new THREE.Euler().setFromQuaternion(
      delta.clone().multiply(quaternionFromGlobalEuler(transform.rotation)),
      'ZYX',
    );
    const position = mode === 'group'
      ? transform.position.clone().sub(pivot).applyQuaternion(delta).add(pivot)
      : transform.position.clone();
    return { id, transform: { position, rotation, scale: transform.scale.clone() } };
  });
}

/**
 * Scales the selection by the per-axis factor the active model's scale changed
 * by, about `pivot`: each model grows by that factor and its offset from the
 * pivot grows with it, as the gizmo does for a multi-selection.
 */
export function scaleSelectionFromActive(
  before: readonly SelectionTransformEntry[],
  activeModelId: string,
  activeScale: THREE.Vector3,
  pivot: THREE.Vector3 | null = getSelectionPivot(before),
): SelectionTransformEntry[] {
  const active = before.find((entry) => entry.id === activeModelId);
  if (!active || !pivot) return [];

  const ratio = new THREE.Vector3(
    safeRatio(activeScale.x, active.transform.scale.x),
    safeRatio(activeScale.y, active.transform.scale.y),
    safeRatio(activeScale.z, active.transform.scale.z),
  );

  return before.map(({ id, transform }) => ({
    id,
    transform: {
      position: transform.position.clone().sub(pivot).multiply(ratio).add(pivot),
      rotation: transform.rotation.clone(),
      scale: transform.scale.clone().multiply(ratio),
    },
  }));
}

/** Puts each model's rotation, scale, or both back to identity, where it stands. */
export function resetSelectionTransforms(
  before: readonly SelectionTransformEntry[],
  reset: { rotation?: boolean; scale?: boolean },
): SelectionTransformEntry[] {
  return before.map(({ id, transform }) => {
    const next = cloneTransform(transform);
    if (reset.rotation) next.rotation = new THREE.Euler(0, 0, 0, 'ZYX');
    if (reset.scale) next.scale = new THREE.Vector3(1, 1, 1);
    return { id, transform: next };
  });
}
