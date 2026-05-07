import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { buildMirrorSupportTransforms } from '../logic/buildMirrorSupportTransforms';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

function identityTransform() {
  return {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0, 'ZYX'),
    scale: new THREE.Vector3(1, 1, 1),
  };
}

function applyTransform(point: THREE.Vector3, t: ReturnType<typeof identityTransform>) {
  const m = new THREE.Matrix4().compose(
    t.position.clone(),
    quaternionFromGlobalEuler(t.rotation),
    t.scale.clone(),
  );
  return point.clone().applyMatrix4(m);
}

test('buildMirrorSupportTransforms returns null for axis z', () => {
  const result = buildMirrorSupportTransforms({
    current: identityTransform(),
    modelLocalBboxCenter: new THREE.Vector3(0, 0, 0),
    axis: 'z',
  });
  assert.equal(result, null);
});

test('buildMirrorSupportTransforms reflects an arbitrary world point through bbox center on X', () => {
  const current = identityTransform();
  current.position.set(10, 0, 0);
  const localCenter = new THREE.Vector3(0, 0, 0);
  const pivotWorld = applyTransform(localCenter, current);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: localCenter,
    axis: 'x',
  })!;
  assert.ok(result);

  const sample = new THREE.Vector3(3, 4, 5);
  const beforeWorld = applyTransform(sample, result.before);
  const afterWorld = applyTransform(sample, result.after);

  assert.ok(Math.abs(afterWorld.x - (2 * pivotWorld.x - beforeWorld.x)) < 1e-5);
  assert.ok(Math.abs(afterWorld.y - beforeWorld.y) < 1e-5);
  assert.ok(Math.abs(afterWorld.z - beforeWorld.z) < 1e-5);
});

test('buildMirrorSupportTransforms reflects on Y', () => {
  const current = identityTransform();
  current.position.set(0, 7, 0);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: new THREE.Vector3(0, 0, 0),
    axis: 'y',
  })!;
  const pivot = applyTransform(new THREE.Vector3(0, 0, 0), current);

  const sample = new THREE.Vector3(2, 3, 4);
  const before = applyTransform(sample, result.before);
  const after = applyTransform(sample, result.after);
  assert.ok(Math.abs(after.x - before.x) < 1e-5);
  assert.ok(Math.abs(after.y - (2 * pivot.y - before.y)) < 1e-5);
  assert.ok(Math.abs(after.z - before.z) < 1e-5);
});

test('buildMirrorSupportTransforms preserves bbox center under mirror', () => {
  const current = identityTransform();
  current.position.set(5, -3, 2);
  current.rotation.set(0, 0, Math.PI / 6, 'ZYX');
  const localCenter = new THREE.Vector3(1, 1, 1);
  const pivotWorld = applyTransform(localCenter, current);

  const result = buildMirrorSupportTransforms({
    current,
    modelLocalBboxCenter: localCenter,
    axis: 'x',
  })!;

  const pivotAfter = applyTransform(localCenter, result.after);
  assert.ok(Math.abs(pivotAfter.x - pivotWorld.x) < 1e-5);
  assert.ok(Math.abs(pivotAfter.y - pivotWorld.y) < 1e-5);
  assert.ok(Math.abs(pivotAfter.z - pivotWorld.z) < 1e-5);
});
