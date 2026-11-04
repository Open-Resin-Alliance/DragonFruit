import * as THREE from 'three';

import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { computeLowestZ } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/** A model dropped on the plate sits this far above it, so float drift cannot clip it. */
export const PLATE_CLEARANCE_MM = 0.001;

export type LiftDropModel = {
  id: string;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  /** The model tracks the scene's lift distance after transforms. */
  autoLift?: boolean;
};

export function getModelLowestWorldZ(model: LiftDropModel): number {
  const geometry = model.geometry.geometry;
  const boundingBox = geometry.boundingBox
    ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
  const center = boundingBox.getCenter(new THREE.Vector3());

  const matrix = new THREE.Matrix4().makeTranslation(
    model.transform.position.x,
    model.transform.position.y,
    model.transform.position.z,
  );
  matrix.multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(),
    quaternionFromGlobalEuler(model.transform.rotation),
    model.transform.scale,
  ));
  matrix.multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

  return computeLowestZ(geometry, matrix);
}

/**
 * Holds the model's own bottom height while its scale, rotation or centre changes.
 * This is the manual-placement half of the lift rule: a model that is not tracking
 * the lift distance keeps the height it was placed at, so a pre-supported mesh
 * keeps the clearance its supports were built around.
 */
export function preserveModelBottom(model: LiftDropModel, next: ModelTransform): ModelTransform {
  const position = next.position.clone();
  position.z += getModelLowestWorldZ(model) - getModelLowestWorldZ({ ...model, transform: next });
  return {
    position,
    rotation: next.rotation.clone(),
    scale: next.scale.clone(),
  };
}

/** Whether the model follows the scene's lift distance. */
export function isModelAutoLifted(model: LiftDropModel): boolean {
  return model.autoLift === true;
}

/**
 * Holds the model's bottom through a transform. An auto-lifted model is seated at
 * the scene's lift distance; every other model keeps the bottom it was placed at.
 */
export function alignModelToLift(
  model: LiftDropModel,
  candidate: ModelTransform,
  liftDistance: number,
): ModelTransform {
  const target = model.autoLift ? liftDistance : getModelLowestWorldZ(model);
  const position = candidate.position.clone();
  position.z += target - getModelLowestWorldZ({ ...model, transform: candidate });
  return {
    position,
    rotation: candidate.rotation.clone(),
    scale: candidate.scale.clone(),
  };
}

export function buildLiftDropUpdates(
  models: readonly LiftDropModel[],
  targetIds: readonly string[],
  targetLowestWorldZ: number,
): Array<{ id: string; transform: ModelTransform }> {
  const targetIdSet = new Set(targetIds);

  return models
    .filter((model) => targetIdSet.has(model.id))
    .map((model) => {
      const lowestWorldZ = getModelLowestWorldZ(model);
      const position = model.transform.position.clone();
      position.z += targetLowestWorldZ - lowestWorldZ;

      return {
        id: model.id,
        transform: {
          position,
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        },
      };
    });
}
