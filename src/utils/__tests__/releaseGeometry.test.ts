import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { releaseGeometryStorage } from '../releaseGeometry';

test('releaseGeometryStorage drops attributes and the index, not just GPU buffers', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  geometry.setIndex([0, 1, 2]);
  geometry.morphAttributes = { position: [new THREE.BufferAttribute(new Float32Array(9), 3)] };

  let disposed = 0;
  let bvhDisposed = 0;
  geometry.dispose = () => { disposed += 1; };
  geometry.disposeBoundsTree = () => { bvhDisposed += 1; };

  releaseGeometryStorage(geometry);

  assert.equal(disposed, 1);
  assert.equal(bvhDisposed, 1);
  assert.deepEqual(Object.keys(geometry.attributes), []);
  assert.equal(geometry.index, null);
  assert.deepEqual(geometry.morphAttributes, {});
});
