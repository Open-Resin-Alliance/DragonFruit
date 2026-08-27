import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import {
  buildLiftDropUpdates,
  getModelLowestWorldZ,
  type LiftDropModel,
} from '@/features/scene/selectionLiftDrop';

function model(
  id: string,
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  rotation = new THREE.Euler(),
  scale = new THREE.Vector3(1, 1, 1),
): LiftDropModel {
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox!.clone();

  return {
    id,
    geometry: {
      geometry,
      bbox: boundingBox,
      size: boundingBox.getSize(new THREE.Vector3()),
    } as GeometryWithBounds,
    transform: { position, rotation, scale },
  };
}

test('Lift places each selected model bottom independently at the requested distance', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(2, 4, 6), new THREE.Vector3(3, 4, 10)),
    model(
      'model-b',
      new THREE.BoxGeometry(2, 4, 6),
      new THREE.Vector3(-5, 7, 20),
      new THREE.Euler(Math.PI / 2, 0, 0),
      new THREE.Vector3(1, 2, 1),
    ),
  ];

  const updates = buildLiftDropUpdates(models, ['model-b', 'model-a'], 5);

  assert.deepEqual(updates.map((update) => update.id), ['model-a', 'model-b']);
  updates.forEach((update, index) => {
    assert.ok(Math.abs(getModelLowestWorldZ({ ...models[index], transform: update.transform }) - 5) < 1e-6);
    assert.equal(update.transform.position.x, models[index].transform.position.x);
    assert.equal(update.transform.position.y, models[index].transform.position.y);
  });
  assert.notEqual(updates[0].transform.position.z, updates[1].transform.position.z);
});

test('Drop places every selected bottom at zero and skips unselected models', () => {
  const models = [
    model('model-a', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(0, 0, 15)),
    model('model-b', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(8, 0, 25)),
    model('model-c', new THREE.BoxGeometry(4, 4, 4), new THREE.Vector3(16, 0, 35)),
  ];

  const updates = buildLiftDropUpdates(models, ['model-a', 'model-c'], 0);

  assert.deepEqual(updates.map((update) => update.id), ['model-a', 'model-c']);
  assert.ok(Math.abs(getModelLowestWorldZ({ ...models[0], transform: updates[0].transform })) < 1e-6);
  assert.ok(Math.abs(getModelLowestWorldZ({ ...models[2], transform: updates[1].transform })) < 1e-6);
});