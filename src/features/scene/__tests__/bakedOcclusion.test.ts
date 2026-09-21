import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mapCornerValuesToVertices } from '../bakedOcclusion';

/**
 * An indexed geometry's index buffer is the *corner* order, not a vertex lookup.
 */
function quadIndexed(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]), 3),
  );
  // Slots: 0,1,2, 0,2,3 — vertex 0 sits at slots 0 and 3, vertex 2 at slots 2
  // and 4. So the buffer is not its own inverse.
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  return geometry;
}

test('indexed geometry takes each vertex value from the corner that draws it', () => {
  // A bake of this quad: corners in index order, and corners that share a vertex
  // agree because the bake welds coincident positions.
  const cornerValues = new Float32Array([0.1, 0.2, 0.3, 0.1, 0.3, 0.4]);
  const values = mapCornerValuesToVertices(cornerValues, quadIndexed());

  assert.ok(values, 'the mapping should succeed');
  assert.equal(values.length, 4);
  assert.deepEqual(Array.from(values), Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4])));
});

test('a soup keeps the bake order as-is', () => {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(18);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const cornerValues = new Float32Array([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);

  const values = mapCornerValuesToVertices(cornerValues, geometry);
  assert.equal(values, cornerValues);
});

test('a count mismatch is refused rather than attached', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  // Three positions but six values: attaching them would put another mesh's
  // occlusion on this one.
  assert.equal(mapCornerValuesToVertices(new Float32Array(6), geometry), null);
  assert.equal(mapCornerValuesToVertices(new Float32Array(9), quadIndexed()), null);
});
