import * as THREE from 'three';
import type { MirrorAxis } from '../types';

const AXIS_INDEX: Record<MirrorAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};

export function bakeMirrorIntoGeometry(
  source: THREE.BufferGeometry,
  axis: MirrorAxis,
): THREE.BufferGeometry {
  const out = source.clone();

  const positionAttr = out.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!positionAttr) {
    throw new Error('bakeMirrorIntoGeometry: source geometry has no position attribute');
  }

  const axisIndex = AXIS_INDEX[axis];
  const positions = positionAttr.array as Float32Array;
  const itemSize = positionAttr.itemSize;
  for (let i = axisIndex; i < positions.length; i += itemSize) {
    positions[i] = -positions[i];
  }
  positionAttr.needsUpdate = true;

  const index = out.getIndex();
  if (index) {
    const arr = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
  } else {
    // Swap the second and third corner of every triangle in every attribute, not just
    // the positions: a normal, a UV or a display mesh's baked AO left behind would
    // belong to the other corner.
    const triCount = positionAttr.count / 3;
    for (const attribute of Object.values(out.attributes)) {
      if (!(attribute instanceof THREE.BufferAttribute) || attribute.count !== positionAttr.count) continue;
      const values = attribute.array;
      const size = attribute.itemSize;
      for (let t = 0; t < triCount; t += 1) {
        const baseA = (t * 3 + 1) * size;
        const baseB = baseA + size;
        for (let c = 0; c < size; c += 1) {
          const tmp = values[baseA + c];
          values[baseA + c] = values[baseB + c];
          values[baseB + c] = tmp;
        }
      }
      attribute.needsUpdate = true;
    }
  }

  const normalAttr = out.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (normalAttr) {
    const normals = normalAttr.array as Float32Array;
    const normalItemSize = normalAttr.itemSize;
    for (let i = axisIndex; i < normals.length; i += normalItemSize) {
      normals[i] = -normals[i];
    }
    normalAttr.needsUpdate = true;
  } else {
    out.computeVertexNormals();
  }

  out.computeBoundingBox();
  out.computeBoundingSphere();

  return out;
}
