import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  bakedOcclusionVersion,
  bumpBakedOcclusionVersion,
  getBakedOcclusionServerVersion,
  subscribeToBakedOcclusionVersions,
} from '../bakedOcclusion';

/**
 * A bake lands on a geometry the scene already holds, so this counter is the
 * only thing that can tell `StlMesh` to look at the attribute again. It replaced
 * a counter that rode on the `models` entries, where each landing bake replaced
 * that array and invalidated everything derived from it — the clearance map and
 * the raft, 17 rebuilds in the fifteen seconds after a load.
 */
test('a landed bake bumps its own geometry, and only its own', () => {
  const geometry = new THREE.BufferGeometry();
  const other = new THREE.BufferGeometry();

  let notified = 0;
  const unsubscribe = subscribeToBakedOcclusionVersions(() => { notified += 1; });
  try {
    assert.equal(bakedOcclusionVersion(geometry), 0);
    assert.equal(getBakedOcclusionServerVersion(), 0);

    bumpBakedOcclusionVersion(geometry);
    assert.equal(bakedOcclusionVersion(geometry), 1);
    assert.equal(notified, 1, 'nothing else tells the material the attribute landed');

    // One model's bake is not another model's business: a shared counter would
    // re-read every geometry in the scene per bake.
    bumpBakedOcclusionVersion(other);
    assert.equal(bakedOcclusionVersion(other), 1);
    assert.equal(bakedOcclusionVersion(geometry), 1);
    assert.equal(notified, 2);
  } finally {
    unsubscribe();
  }

  bumpBakedOcclusionVersion(geometry);
  assert.equal(bakedOcclusionVersion(geometry), 2);
  assert.equal(notified, 2, 'an unsubscribed listener should not hear about it');
});
