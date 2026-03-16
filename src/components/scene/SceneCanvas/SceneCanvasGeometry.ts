import * as THREE from 'three';

export function getBoxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const { min, max } = bounds;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];
}

export function buildBoxWireframePositions(bounds: THREE.Box3): Float32Array {
  const min = bounds.min;
  const max = bounds.max;

  const a = [min.x, min.y, min.z];
  const b = [max.x, min.y, min.z];
  const c = [max.x, max.y, min.z];
  const d = [min.x, max.y, min.z];
  const e = [min.x, min.y, max.z];
  const f = [max.x, min.y, max.z];
  const g = [max.x, max.y, max.z];
  const h = [min.x, max.y, max.z];

  return new Float32Array([
    ...a, ...b,
    ...b, ...c,
    ...c, ...d,
    ...d, ...a,
    ...e, ...f,
    ...f, ...g,
    ...g, ...h,
    ...h, ...e,
    ...a, ...e,
    ...b, ...f,
    ...c, ...g,
    ...d, ...h,
  ]);
}

export function writeCornerOnlyWireframePositions(target: Float32Array, bounds: THREE.Box3, cornerLengthMm = 5): void {
  const min = bounds.min;
  const max = bounds.max;

  const xLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.x - min.x));
  const yLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.y - min.y));
  const zLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.z - min.z));

  const corners: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [
    { x: min.x, y: min.y, z: min.z, sx: 1, sy: 1, sz: 1 },
    { x: max.x, y: min.y, z: min.z, sx: -1, sy: 1, sz: 1 },
    { x: max.x, y: max.y, z: min.z, sx: -1, sy: -1, sz: 1 },
    { x: min.x, y: max.y, z: min.z, sx: 1, sy: -1, sz: 1 },
    { x: min.x, y: min.y, z: max.z, sx: 1, sy: 1, sz: -1 },
    { x: max.x, y: min.y, z: max.z, sx: -1, sy: 1, sz: -1 },
    { x: max.x, y: max.y, z: max.z, sx: -1, sy: -1, sz: -1 },
    { x: min.x, y: max.y, z: max.z, sx: 1, sy: -1, sz: -1 },
  ];

  let index = 0;
  for (const corner of corners) {
    const { x, y, z, sx, sy, sz } = corner;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x + (sx * xLen); target[index++] = y; target[index++] = z;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x; target[index++] = y + (sy * yLen); target[index++] = z;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x; target[index++] = y; target[index++] = z + (sz * zLen);
  }
}

export function buildEmptyCornerOnlyWireframePositions(): Float32Array {
  return new Float32Array(8 * 3 * 2 * 3);
}
