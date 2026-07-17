import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  getRotationQuatTuple,
  hashBlockedVoxelIndices,
  resolveBlockedVoxelValidity,
  rotationQuatTuplesMatch,
} from '../hollowingGrid';

test('resolveBlockedVoxelValidity decision table', () => {
  const identity = getRotationQuatTuple(new THREE.Euler(0, 0, 0));
  const rotated = getRotationQuatTuple(new THREE.Euler(0, 0, Math.PI / 2));

  // No blockers: always valid, regardless of stamps.
  assert.equal(resolveBlockedVoxelValidity(undefined, identity), 'valid');
  assert.equal(
    resolveBlockedVoxelValidity({ blockedVoxelIndices: [] }, rotated),
    'valid',
  );

  // Legacy data (no stamp): adopt, do not destroy.
  assert.equal(
    resolveBlockedVoxelValidity({ blockedVoxelIndices: [1, 2] }, rotated),
    'stamp-legacy',
  );

  // Matching stamp: valid.
  assert.equal(
    resolveBlockedVoxelValidity(
      { blockedVoxelIndices: [1, 2], blockedVoxelRotationQuat: identity },
      identity,
    ),
    'valid',
  );

  // Rotation changed since commit: stale.
  assert.equal(
    resolveBlockedVoxelValidity(
      { blockedVoxelIndices: [1, 2], blockedVoxelRotationQuat: identity },
      rotated,
    ),
    'stale',
  );
});

test('rotationQuatTuplesMatch treats q and -q as the same rotation', () => {
  const q = getRotationQuatTuple(new THREE.Euler(0.3, -0.7, 1.1));
  const negated: typeof q = [-q[0], -q[1], -q[2], -q[3]];
  assert.ok(rotationQuatTuplesMatch(q, negated));
  const other = getRotationQuatTuple(new THREE.Euler(0.3, -0.7, 1.2));
  assert.ok(!rotationQuatTuplesMatch(q, other));
});

test('hashBlockedVoxelIndices is order-sensitive and length-prefixed', () => {
  assert.equal(hashBlockedVoxelIndices([1, 2, 3]), hashBlockedVoxelIndices([1, 2, 3]));
  assert.notEqual(hashBlockedVoxelIndices([1, 2, 3]), hashBlockedVoxelIndices([3, 2, 1]));
  assert.notEqual(hashBlockedVoxelIndices([]), hashBlockedVoxelIndices([0]));
});
