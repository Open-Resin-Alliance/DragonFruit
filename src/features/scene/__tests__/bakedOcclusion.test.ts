import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import * as THREE from 'three';
import { mapCornerValuesToVertices, meshTokenForGeometry, rememberLoadedMeshMesh } from '../bakedOcclusion';

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
  const geometry = quadIndexed();
  const cornerValues = new Float32Array([0.1, 0.2, 0.3, 0.1, 0.3, 0.4]);
  const values = mapCornerValuesToVertices(cornerValues, 4, geometry.getIndex()!.array);

  assert.ok(values, 'the mapping should succeed');
  assert.equal(values.length, 4);
  assert.deepEqual(Array.from(values), Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4])));
});

test('a soup keeps the bake order as-is', () => {
  const cornerValues = new Float32Array([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  const values = mapCornerValuesToVertices(cornerValues, 6, null);
  assert.equal(values, cornerValues);
});

/**
 * The bake starts before the BVH is built, and building it gives a soup an index
 * (three-mesh-bvh's `setIndex` default) and reorders one it finds — so the table
 * the soup was expanded through is not the table the geometry carries when the
 * values come back. Mapping against the live index put the occlusion field one
 * triangle over on every imported mesh, which reads as speckled shading.
 */
test('the mapping follows the table the soup was sent through, not the live index', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      1, 1, 0, 0, 1, 0, 0, 0, 0,
      2, 0, 0, 3, 0, 0, 3, 1, 0,
    ]), 3),
  );
  const cornerValues = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);

  // What `accelerateGeometry` does to a soup: index it, then reorder the triangles.
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8,
  ]), 1));
  geometry.getIndex()!.array.set([3, 4, 5, 6, 7, 8, 0, 1, 2]);

  const values = mapCornerValuesToVertices(cornerValues, 9, null);
  assert.ok(values, 'the mapping should succeed');
  assert.deepEqual(Array.from(values), Array.from(cornerValues), 'a soup stays in bake order');
});

test('an index permuted after the request is not the table the bake was sent through', () => {
  const geometry = quadIndexed();
  const sentThrough = (geometry.getIndex()!.array as Uint16Array).slice();
  const cornerValues = new Float32Array([0.1, 0.2, 0.3, 0.1, 0.3, 0.4]);
  // The build rewrites the geometry's own index in place.
  geometry.getIndex()!.array.set([0, 2, 1, 0, 3, 2]);

  const values = mapCornerValuesToVertices(cornerValues, 4, sentThrough);
  assert.ok(values, 'the mapping should succeed');
  assert.deepEqual(Array.from(values), Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4])));
});

test('a count mismatch is refused rather than attached', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  // Three positions but six values: attaching them would put another mesh's
  // occlusion on this one.
  assert.equal(mapCornerValuesToVertices(new Float32Array(6), 3, null), null);
  assert.equal(
    mapCornerValuesToVertices(new Float32Array(9), 4, quadIndexed().getIndex()!.array),
    null,
  );
});

describe('loaded mesh tokens', () => {
  it('drops the token when the geometry is no longer the mesh the loader produced', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rememberLoadedMeshMesh(geometry, 7);
    assert.deepEqual(meshTokenForGeometry(geometry), { token: 7, positions });

    // A repair installs a new position attribute: same geometry, different mesh.
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    assert.equal(meshTokenForGeometry(geometry), null, 'a replaced position array invalidates it');

    // A clone is another geometry, with arrays of its own.
    const clone = geometry.clone();
    assert.equal(meshTokenForGeometry(clone), null, 'a clone is not the loaded mesh');

    // And a geometry the loader never touched has no token to use.
    assert.equal(meshTokenForGeometry(new THREE.BufferGeometry()), null);
  });

  it('goes stale when a prep pass reorders the soup after the loader recorded it', () => {
    // Two triangles, corners `abc` then `def`.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 0, 0, 3, 0, 0, 2, 1, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rememberLoadedMeshMesh(geometry, 11);
    assert.equal(meshTokenForGeometry(geometry)?.token, 11);

    // What a classify pass does (`applyRepairedPositions`): same corner count, the
    // triangles in a different order. The count alone cannot tell them apart, so the
    // array identity is the whole guard.
    const reordered = new Float32Array(positions);
    reordered.set(positions.subarray(9), 0);
    reordered.set(positions.subarray(0, 9), 9);
    geometry.setAttribute('position', new THREE.BufferAttribute(reordered, 3));
    assert.equal(
      meshTokenForGeometry(geometry),
      null,
      'a reordered soup must fall back to sending the soup, not bake the loader\'s order into it',
    );
  });

  it('keeps the token through an in-place translate', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rememberLoadedMeshMesh(geometry, 5);

    // Centering translates the same buffer; the mesh the registry holds moved with it.
    geometry.translate(0, -1, 0);
    assert.equal(meshTokenForGeometry(geometry)?.token, 5);
  });
});
