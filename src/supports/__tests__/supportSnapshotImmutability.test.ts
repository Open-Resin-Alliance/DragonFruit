import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addRoot, getSnapshot, resetStore, transformSupportsForModel } from '../state';

test('a transform replaces records, so a held support snapshot stays at its old pose', () => {
  resetStore();
  addRoot({
    id: 'root-a',
    modelId: 'model-a',
    transform: { pos: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    diameter: 3,
    diskHeight: 1,
    coneHeight: 2,
  } as never);

  const held = getSnapshot();
  const heldRoot = held.roots['root-a'];

  transformSupportsForModel(
    'model-a',
    { position: new THREE.Vector3(0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
    { position: new THREE.Vector3(5, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
  );

  assert.deepEqual(heldRoot.transform.pos, { x: 1, y: 2, z: 3 }, 'the held snapshot must not be mutated');
  assert.deepEqual(getSnapshot().roots['root-a'].transform.pos, { x: 6, y: 2, z: 3 });
});
