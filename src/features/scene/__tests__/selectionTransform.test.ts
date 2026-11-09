import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  getSelectionPivot,
  resetSelectionTransforms,
  rotateSelectionFromActive,
  scaleSelectionFromActive,
  type SelectionTransformEntry,
} from '@/features/scene/selectionTransform';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

function entry(
  id: string,
  position: THREE.Vector3,
  rotation = new THREE.Euler(0, 0, 0, 'ZYX'),
  scale = new THREE.Vector3(1, 1, 1),
): SelectionTransformEntry {
  return { id, transform: { position, rotation, scale } };
}

function assertVectorClose(actual: THREE.Vector3, expected: THREE.Vector3) {
  assert.ok(
    actual.distanceTo(expected) < 1e-6,
    `expected ${expected.toArray().join(',')}, got ${actual.toArray().join(',')}`,
  );
}

function assertRotationClose(actual: THREE.Euler, expected: THREE.Euler) {
  assert.ok(
    quaternionFromGlobalEuler(actual).angleTo(quaternionFromGlobalEuler(expected)) < 1e-6,
    `expected ${expected.toArray().slice(0, 3).join(',')}, got ${actual.toArray().slice(0, 3).join(',')}`,
  );
}

const quarterTurnZ = new THREE.Euler(0, 0, Math.PI / 2, 'ZYX');

test('Group rotation turns every model and orbits its position about the selection centre', () => {
  const before = [
    entry('a', new THREE.Vector3(10, 0, 5)),
    entry('b', new THREE.Vector3(-10, 0, 5)),
  ];

  const after = rotateSelectionFromActive(before, 'a', quarterTurnZ, 'group');

  assert.deepEqual(after.map((e) => e.id), ['a', 'b']);
  assertVectorClose(after[0].transform.position, new THREE.Vector3(0, 10, 5));
  assertVectorClose(after[1].transform.position, new THREE.Vector3(0, -10, 5));
  assertRotationClose(after[0].transform.rotation, quarterTurnZ);
  assertRotationClose(after[1].transform.rotation, quarterTurnZ);
});

test('Individual rotation turns every model in place', () => {
  const before = [
    entry('a', new THREE.Vector3(10, 0, 5)),
    entry('b', new THREE.Vector3(-10, 0, 5)),
  ];

  const after = rotateSelectionFromActive(before, 'a', quarterTurnZ, 'individual');

  assertVectorClose(after[0].transform.position, new THREE.Vector3(10, 0, 5));
  assertVectorClose(after[1].transform.position, new THREE.Vector3(-10, 0, 5));
  assertRotationClose(after[1].transform.rotation, quarterTurnZ);
});

test('Rotation applies the active model\'s change, not its absolute rotation, to the others', () => {
  const tiltedX = new THREE.Euler(Math.PI / 4, 0, 0, 'ZYX');
  const before = [
    entry('a', new THREE.Vector3(0, 0, 0)),
    entry('b', new THREE.Vector3(20, 0, 0), tiltedX),
  ];

  const after = rotateSelectionFromActive(before, 'a', quarterTurnZ, 'individual');

  // b keeps its tilt, then takes the same world-Z quarter turn as a.
  const expected = new THREE.Euler().setFromQuaternion(
    quaternionFromGlobalEuler(quarterTurnZ).multiply(quaternionFromGlobalEuler(tiltedX)),
    'ZYX',
  );
  assertRotationClose(after[1].transform.rotation, expected);
});

test('Rotation without a change leaves the selection where it was', () => {
  const tilted = new THREE.Euler(0.3, -0.2, 1.1, 'ZYX');
  const before = [
    entry('a', new THREE.Vector3(1, 2, 3), tilted),
    entry('b', new THREE.Vector3(7, -4, 9)),
  ];

  const after = rotateSelectionFromActive(before, 'a', tilted.clone(), 'group');

  assertVectorClose(after[0].transform.position, before[0].transform.position);
  assertVectorClose(after[1].transform.position, before[1].transform.position);
  assertRotationClose(after[1].transform.rotation, before[1].transform.rotation);
});

test('Rotation needs the active model in the selection', () => {
  const before = [entry('a', new THREE.Vector3())];
  assert.deepEqual(rotateSelectionFromActive(before, 'missing', quarterTurnZ, 'group'), []);
});

test('Scale applies the active model\'s factor to every model and to its offset from the centre', () => {
  const before = [
    entry('a', new THREE.Vector3(10, 0, 0), undefined, new THREE.Vector3(1, 1, 1)),
    entry('b', new THREE.Vector3(-10, 4, 0), undefined, new THREE.Vector3(2, 2, 2)),
  ];

  const after = scaleSelectionFromActive(before, 'a', new THREE.Vector3(2, 2, 2));

  assertVectorClose(after[0].transform.scale, new THREE.Vector3(2, 2, 2));
  assertVectorClose(after[1].transform.scale, new THREE.Vector3(4, 4, 4));
  // Centre (0, 2, 0): a sits at (+10, -2), b at (-10, +2), both doubled.
  assertVectorClose(after[0].transform.position, new THREE.Vector3(20, -2, 0));
  assertVectorClose(after[1].transform.position, new THREE.Vector3(-20, 6, 0));
});

test('Reset puts rotation and scale back to identity without moving anything', () => {
  const before = [
    entry('a', new THREE.Vector3(3, 4, 5), quarterTurnZ, new THREE.Vector3(2, 2, 2)),
    entry('b', new THREE.Vector3(-3, 1, 5), new THREE.Euler(0.4, 0, 0, 'ZYX'), new THREE.Vector3(0.5, 1, 1)),
  ];

  const rotationReset = resetSelectionTransforms(before, { rotation: true });
  assertRotationClose(rotationReset[1].transform.rotation, new THREE.Euler());
  assertVectorClose(rotationReset[1].transform.scale, new THREE.Vector3(0.5, 1, 1));
  assertVectorClose(rotationReset[1].transform.position, new THREE.Vector3(-3, 1, 5));

  const scaleReset = resetSelectionTransforms(before, { scale: true });
  assertVectorClose(scaleReset[0].transform.scale, new THREE.Vector3(1, 1, 1));
  assertRotationClose(scaleReset[0].transform.rotation, quarterTurnZ);
});

test('The pivot is the mean of the positions', () => {
  const pivot = getSelectionPivot([
    entry('a', new THREE.Vector3(0, 0, 0)),
    entry('b', new THREE.Vector3(4, 8, 2)),
  ]);
  assertVectorClose(pivot!, new THREE.Vector3(2, 4, 1));
  assert.equal(getSelectionPivot([]), null);
});
