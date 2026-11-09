import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { countTriangles } from '@/utils/geometry';

test('countTriangles counts an unindexed geometry by its corners', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(2 * 9), 3));
  assert.equal(countTriangles(geometry), 2);
});

test('countTriangles counts an indexed geometry by its index, not its shared vertices', () => {
  // A quad: four shared vertices, two triangles. Four over three is the 1.33 the
  // models panel used to show for indexed meshes.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  assert.equal(countTriangles(geometry), 2);
});

test('countTriangles is zero for a geometry with no positions', () => {
  assert.equal(countTriangles(new THREE.BufferGeometry()), 0);
});
