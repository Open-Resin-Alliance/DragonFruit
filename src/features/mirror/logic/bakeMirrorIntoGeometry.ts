import * as THREE from 'three';
import type { MirrorAxis } from '../types';

const AXIS_INDEX: Record<MirrorAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};

/**
 * Swaps vertices 1 and 2 of every triangle in a non-indexed BufferAttribute
 * so all per-vertex attributes stay aligned when triangle winding flips.
 */
export function swapNonIndexedAttributeWinding(attr: THREE.BufferAttribute): void {
  const arr = attr.array as Float32Array | Float64Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array | Uint8ClampedArray;
  const itemSize = attr.itemSize;
  const triCount = Math.floor(attr.count / 3);
  for (let t = 0; t < triCount; t += 1) {
    const baseA = (t * 3 + 1) * itemSize;
    const baseB = (t * 3 + 2) * itemSize;
    for (let c = 0; c < itemSize; c += 1) {
      const a = baseA + c;
      const b = baseB + c;
      const tmp = arr[a];
      arr[a] = arr[b];
      arr[b] = tmp;
    }
  }
  attr.needsUpdate = true;
}

export function bakeMirrorIntoGeometry(
  source: THREE.BufferGeometry,
  axis: MirrorAxis,
): THREE.BufferGeometry {
  const out = source.clone();

  const positionAttr = out.getAttribute('position');
  if (!positionAttr) {
    throw new Error('bakeMirrorIntoGeometry: source geometry has no position attribute');
  }
  if (!(positionAttr instanceof THREE.BufferAttribute) || positionAttr.itemSize < 3) {
    throw new Error(
      `bakeMirrorIntoGeometry: position attribute must be a BufferAttribute with itemSize >= 3 (got itemSize=${positionAttr.itemSize})`,
    );
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
    for (const attr of Object.values(out.attributes)) {
      if (attr instanceof THREE.BufferAttribute) {
        swapNonIndexedAttributeWinding(attr);
      }
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
