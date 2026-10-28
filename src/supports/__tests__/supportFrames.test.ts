import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  captureSupportFrames,
  ensureSupportFrame,
  getSupportFrameInverse,
  getSupportFrameTransform,
  hasSupportFrame,
  resetSupportFrames,
  restoreSupportFrames,
  setSupportFrame,
  syncSupportFrames,
} from '../supportFrames';

function transform(x: number, z: number) {
  return {
    position: new THREE.Vector3(x, 0, z),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

test('a frame owns its transform and exposes its inverse', () => {
  resetSupportFrames();
  setSupportFrame('m1', transform(5, 2));
  const stored = getSupportFrameTransform('m1')!;
  assert.equal(stored.position.x, 5);
  stored.position.x = 99;
  assert.equal(getSupportFrameTransform('m1')!.position.x, 5);

  const point = new THREE.Vector3(5, 0, 2).applyMatrix4(getSupportFrameInverse('m1')!);
  assert.ok(Math.abs(point.x) < 1e-9);
  assert.ok(Math.abs(point.z) < 1e-9);
});

test('ensure keeps an existing frame and sync drops dead models', () => {
  resetSupportFrames();
  ensureSupportFrame('m1', transform(1, 0));
  ensureSupportFrame('m1', transform(9, 0));
  assert.equal(getSupportFrameTransform('m1')!.position.x, 1);

  syncSupportFrames([{ id: 'm1', transform: transform(9, 0) }, { id: 'm2', transform: transform(2, 0) }]);
  assert.equal(getSupportFrameTransform('m1')!.position.x, 1);
  assert.equal(getSupportFrameTransform('m2')!.position.x, 2);

  syncSupportFrames([{ id: 'm2', transform: transform(2, 0) }]);
  assert.equal(hasSupportFrame('m1'), false);
});

test('a frame snapshot restores the baked transform', () => {
  resetSupportFrames();
  setSupportFrame('m1', transform(1, 0));
  const snapshot = captureSupportFrames();
  setSupportFrame('m1', transform(8, 7));
  restoreSupportFrames(snapshot);
  assert.equal(getSupportFrameTransform('m1')!.position.x, 1);
  assert.equal(getSupportFrameTransform('m1')!.position.z, 0);
});
