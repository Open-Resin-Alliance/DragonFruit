import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { resetSupportFrames, setSupportFrame } from '../supportFrames';
import { toLocalSupportState, toWorldSupportState } from '../supportFrameTransform';

function frame(x: number, z = 0) {
  return {
    position: new THREE.Vector3(x, 0, z),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

function seed() {
  addRoot({
    id: 'root-1',
    modelId: 'm1',
    transform: { pos: { x: 10, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 1,
    coneHeight: 2,
  } as never);
  addSupportEntity('trunk', {
    id: 'trunk-1',
    modelId: 'm1',
    rootId: 'root-1',
    segments: [],
  } as never);
}

test('world support records convert into the model frame and back', () => {
  resetStore();
  resetSupportFrames();
  setSupportFrame('m1', frame(5, 2));
  seed();

  const world = getSnapshot();
  const local = toLocalSupportState(world);
  assert.equal(local.roots['root-1'].transform.pos.x, 5);
  assert.equal(local.roots['root-1'].transform.pos.y, 4);
  assert.equal(local.roots['root-1'].transform.pos.z, -2);

  const roundTrip = toWorldSupportState(local);
  assert.equal(roundTrip.roots['root-1'].transform.pos.x, 10);
  assert.equal(roundTrip.roots['root-1'].transform.pos.y, 4);
  assert.equal(roundTrip.roots['root-1'].transform.pos.z, 0);
  assert.equal(roundTrip.supports, undefined, 'the derived map is rebuilt, not carried stale');
});

test('a model with no frame is left in world space', () => {
  resetStore();
  resetSupportFrames();
  seed();
  const world = getSnapshot();
  const local = toLocalSupportState(world);
  assert.equal(local.roots['root-1'].transform.pos.x, 10);
});
