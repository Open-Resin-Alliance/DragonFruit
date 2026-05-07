import * as THREE from 'three';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { MirrorAxis } from '../types';

const AXIS_INDEX: Record<MirrorAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};

export interface MirrorSupportTransforms {
  before: ModelTransform;
  after: ModelTransform;
}

// Reflects a model's transform across a world-space axis through the model's
// world-space bbox center. Works for any axis, including Z.
export function reflectTransformAcrossWorldAxis(
  current: ModelTransform,
  modelLocalBboxCenter: THREE.Vector3,
  axis: MirrorAxis,
): ModelTransform {
  const beforeMatrix = new THREE.Matrix4().compose(
    current.position.clone(),
    quaternionFromGlobalEuler(current.rotation),
    current.scale.clone(),
  );

  const pivotWorld = modelLocalBboxCenter.clone().applyMatrix4(beforeMatrix);

  const reflect = new THREE.Matrix4().identity();
  const reflectElements = reflect.elements;
  reflectElements[AXIS_INDEX[axis] * 5] = -1;

  const toPivot = new THREE.Matrix4().makeTranslation(-pivotWorld.x, -pivotWorld.y, -pivotWorld.z);
  const fromPivot = new THREE.Matrix4().makeTranslation(pivotWorld.x, pivotWorld.y, pivotWorld.z);

  const afterMatrix = new THREE.Matrix4()
    .multiply(fromPivot)
    .multiply(reflect)
    .multiply(toPivot)
    .multiply(beforeMatrix);

  const afterPosition = new THREE.Vector3();
  const afterQuat = new THREE.Quaternion();
  const afterScale = new THREE.Vector3();
  afterMatrix.decompose(afterPosition, afterQuat, afterScale);

  return {
    position: afterPosition,
    rotation: new THREE.Euler().setFromQuaternion(afterQuat, 'ZYX'),
    scale: afterScale,
  };
}

export function buildMirrorSupportTransforms(args: {
  current: ModelTransform;
  modelLocalBboxCenter: THREE.Vector3;
  axis: MirrorAxis;
}): MirrorSupportTransforms | null {
  const { current, modelLocalBboxCenter, axis } = args;
  if (axis === 'z') return null;

  const after = reflectTransformAcrossWorldAxis(current, modelLocalBboxCenter, axis);
  return {
    before: {
      position: current.position.clone(),
      rotation: current.rotation.clone(),
      scale: current.scale.clone(),
    },
    after,
  };
}
