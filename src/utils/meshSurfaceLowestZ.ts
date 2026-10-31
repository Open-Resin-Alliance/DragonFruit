import type * as THREE from 'three';
import type {} from 'three-mesh-bvh';
import { computeLowestZ } from './geometry';

/** Exact surface maximum using the same conservative BVH traversal in reversed Z. */
export function meshSurfaceHighestZ(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): number {
  const reversed = matrix.clone();
  for (const index of [2, 6, 10, 14]) reversed.elements[index] *= -1;
  return -meshSurfaceLowestZ(geometry, reversed);
}

/** Exact rendered-surface minimum, pruning BVH nodes by a conservative Z bound. */
export function meshSurfaceLowestZ(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): number {
  const tree = geometry.boundsTree;
  if (!tree) return computeLowestZ(geometry, matrix);
  const e = matrix.elements;
  if (Math.abs(e[2]) < 1e-12 && Math.abs(e[6]) < 1e-12) return computeLowestZ(geometry, matrix);
  const boxMinimum = (box: THREE.Box3) =>
    e[2] * (e[2] >= 0 ? box.min.x : box.max.x)
    + e[6] * (e[6] >= 0 ? box.min.y : box.max.y)
    + e[10] * (e[10] >= 0 ? box.min.z : box.max.z) + e[14];
  const vertexZ = (v: THREE.Vector3) => v.x * e[2] + v.y * e[6] + v.z * e[10] + e[14];
  let lowest = Infinity;
  tree.shapecast({
    boundsTraverseOrder: boxMinimum,
    intersectsBounds: (box) => boxMinimum(box) < lowest,
    intersectsTriangle: (triangle) => {
      lowest = Math.min(lowest, vertexZ(triangle.a), vertexZ(triangle.b), vertexZ(triangle.c));
      return false;
    },
  });
  return lowest;
}
