import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { shouldRefineCoarseFaces } from '../tauriMeshBridge';

function geometryWithTriangles(triangles: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(triangles * 9), 3),
  );
  return geometry;
}

test('refine gate refuses empty geometry and accepts a mesh at the ceiling', () => {
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(0), 3), false);
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(3), 3), true);
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(4), 3), false);
});
