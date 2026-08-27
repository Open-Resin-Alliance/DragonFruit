import * as THREE from 'three';

import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { computeLowestZ } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

export type LiftDropModel = {
  id: string;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
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