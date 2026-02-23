import * as THREE from 'three';

type EulerComponentsLike = {
  x?: number;
  y?: number;
  z?: number;
};

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

export function sanitizeGlobalEulerRadians(rotation: EulerComponentsLike | null | undefined) {
  return {
    x: finiteOrZero(rotation?.x),
    y: finiteOrZero(rotation?.y),
    z: finiteOrZero(rotation?.z),
  };
}

/**
 * Build a quaternion from global/world-axis Euler components.
 *
 * DragonFruit's canonical convention is:
 * - X, Y, Z sliders are interpreted in build-plate/world axes
 * - rotations compose as extrinsic XYZ (about fixed world axes)
 */
export function quaternionFromGlobalEuler(rotation: EulerComponentsLike | null | undefined): THREE.Quaternion {
  const { x, y, z } = sanitizeGlobalEulerRadians(rotation);

  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y);
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z);

  return qz.multiply(qy).multiply(qx);
}

export function quaternionFromGlobalEulerDegrees(rotation: EulerComponentsLike | null | undefined): THREE.Quaternion {
  const deg2rad = Math.PI / 180;
  return quaternionFromGlobalEuler({
    x: finiteOrZero(rotation?.x) * deg2rad,
    y: finiteOrZero(rotation?.y) * deg2rad,
    z: finiteOrZero(rotation?.z) * deg2rad,
  });
}

/**
 * Keep raw XYZ values but store them in an Euler order whose intrinsic form
 * matches our extrinsic/global-axis XYZ convention.
 */
export function eulerFromGlobalEuler(rotation: EulerComponentsLike | null | undefined): THREE.Euler {
  const { x, y, z } = sanitizeGlobalEulerRadians(rotation);
  return new THREE.Euler(x, y, z, 'ZYX');
}
