import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { computeBoundsZ, computeLowestZ } from '../geometry';
import { meshSurfaceHighestZ, meshSurfaceLowestZ } from '../meshSurfaceLowestZ';

test('BVH grounding matches a vertex scan under rotation, translation and nonuniform/mirrored scale', () => {
  const geometry = new THREE.TorusKnotGeometry(12, 3, 120, 12).toNonIndexed();
  geometry.computeBoundingBox();
  geometry.boundsTree = new MeshBVH(geometry);
  const vertices = [...geometry.getAttribute('position').array];
  const index = [...geometry.index!.array];
  for (let i = 0; i < 80; i += 1) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(i, -i, i / 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.13, i * 0.27, -i * 0.07)),
      new THREE.Vector3(i % 2 ? -2 : 0.7, 1.3, 2.6));
    assert.ok(Math.abs(meshSurfaceLowestZ(geometry, matrix) - computeLowestZ(geometry, matrix)) < 1e-9);
    const originalMatrix = [...matrix.elements];
    assert.ok(Math.abs(meshSurfaceHighestZ(geometry, matrix) - computeBoundsZ(geometry, matrix).max) < 1e-9);
    assert.deepEqual(matrix.elements, originalMatrix);
  }
  assert.deepEqual([...geometry.getAttribute('position').array], vertices);
  assert.deepEqual([...geometry.index!.array], index);
  geometry.dispose();
});

test('grounding uses the actual surface, not the transformed bounding-box corner', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 2, 9, 0, 3, 0, 8, 7], 3));
  geometry.boundsTree = new MeshBVH(geometry);
  geometry.computeBoundingBox();
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, 0.4, 0.2));
  assert.ok(Math.abs(meshSurfaceLowestZ(geometry, matrix) - computeLowestZ(geometry, matrix)) < 1e-9);
  assert.ok(Math.abs(meshSurfaceLowestZ(geometry, matrix) - geometry.boundingBox!.clone().applyMatrix4(matrix).min.z) > 0.1);
  geometry.dispose();
});

test('unindexed fallback remains available and a dense BVH query prunes most triangles', () => {
  const geometry = new THREE.SphereGeometry(12, 160, 100).toNonIndexed();
  const matrix = new THREE.Matrix4().makeRotationX(0.74);
  assert.equal(meshSurfaceLowestZ(geometry, matrix), computeLowestZ(geometry, matrix));
  assert.equal(meshSurfaceHighestZ(geometry, matrix), computeBoundsZ(geometry, matrix).max);
  geometry.boundsTree = new MeshBVH(geometry);
  let reads = 0;
  const positions = geometry.getAttribute('position');
  const getX = positions.getX.bind(positions);
  positions.getX = (i) => { reads += 1; return getX(i); };
  assert.ok(Math.abs(meshSurfaceLowestZ(geometry, matrix) - computeLowestZ(geometry, matrix)) < 1e-9);
  assert.ok(Math.abs(meshSurfaceHighestZ(geometry, matrix) - computeBoundsZ(geometry, matrix).max) < 1e-9);
  assert.ok(reads < positions.count / 20);
  geometry.dispose();
});
