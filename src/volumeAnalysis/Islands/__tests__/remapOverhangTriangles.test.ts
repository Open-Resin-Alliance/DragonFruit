import assert from 'node:assert';
import * as THREE from 'three';
import { remapOverhangTriangleIds } from '../remapOverhangTriangles';
import type { OverhangRegion } from '../types';

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 0, 1, 1,
], 3));
// Render order is the reverse of the scan order.
geometry.setIndex([3, 4, 5, 0, 1, 2]);

const region: OverhangRegion = {
  triangleIds: [0, 1],
  triangleCentroids: [[-1 / 6, -1 / 6, 0.5], [-1 / 6, -1 / 6, -0.5]],
  areaMm2: 1,
  projectedAreaMm2: 1,
  angleDeg: 0,
  normal: [0, 0, -1],
  xyMin: [0, 0],
  xyMax: [1, 1],
  minZ: 0,
  maxZ: 1,
  footprint: { width: 1, height: 1, originX: 0, originY: 0, pxMm: 1, data: [1], surfaceZ: [0] },
};

const [remapped] = remapOverhangTriangleIds(
  [region],
  geometry,
  { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
);
assert.deepEqual(remapped.triangleIds, [0, 1], 'ids follow the rendered index order');
