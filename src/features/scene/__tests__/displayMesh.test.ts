import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  DISPLAY_REFINE_MAX_TRIANGLES,
  acknowledgeEditInPlace,
  forgetDisplayGeometry,
  hasCoarseFaces,
  isDisplayGeometryPending,
  requestDisplayGeometry,
  settledDisplayGeometry,
  subscribeDisplayGeometry,
  wantsDisplayGeometry,
  wasEditedInPlace,
} from '../displayMesh';

test('a panel of two triangles has faces too long for the AO', () => {
  assert.equal(hasCoarseFaces(new THREE.PlaneGeometry(10, 10, 1, 1)), true);
  assert.equal(hasCoarseFaces(new THREE.PlaneGeometry(10, 10, 1, 1).toNonIndexed()), true);
});

test('a mesh already finer than the AO needs is left alone', () => {
  // 1/60 of the side is under 2% of the diagonal, and so is each cell's diagonal.
  assert.equal(hasCoarseFaces(new THREE.PlaneGeometry(10, 10, 60, 60)), false);
  assert.equal(hasCoarseFaces(new THREE.PlaneGeometry(10, 10, 60, 60).toNonIndexed()), false);
});

test('empty and flat-to-a-point meshes have nothing to split', () => {
  assert.equal(hasCoarseFaces(new THREE.BufferGeometry()), false);
  const point = new THREE.BufferGeometry();
  point.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  assert.equal(hasCoarseFaces(point), false);
});

test('a coarse mesh is only sent when it is small enough and carries no colour', () => {
  const coarse = new THREE.PlaneGeometry(10, 10, 1, 1);
  assert.equal(wantsDisplayGeometry(coarse), true);

  const coloured = coarse.clone();
  coloured.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  assert.equal(wantsDisplayGeometry(coloured), false);

  // One long triangle among many collapsed ones: coarse, but over the ceiling.
  const triangles = DISPLAY_REFINE_MAX_TRIANGLES + 1;
  const positions = new Float32Array(triangles * 9);
  positions.set([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const large = new THREE.BufferGeometry();
  large.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  assert.equal(hasCoarseFaces(large), true);
  assert.equal(wantsDisplayGeometry(large), false);
});

// Outside the desktop shell there is no native side, so every derivation settles on
// `null` (the model draws its own mesh) — which is enough to exercise the store.

test('a model mesh is derived once and the subscribers hear when it settles', async () => {
  const real = new THREE.PlaneGeometry(10, 10, 1, 1);
  let heard = 0;
  const unsubscribe = subscribeDisplayGeometry(() => { heard += 1; });
  try {
    assert.equal(settledDisplayGeometry(real), undefined);
    const first = requestDisplayGeometry(real);
    assert.equal(requestDisplayGeometry(real), first, 'a second request shares the first');
    assert.equal(await first, null);
    assert.equal(settledDisplayGeometry(real), null);
    assert.equal(heard, 1);
  } finally {
    unsubscribe();
  }
});

test('the AO waits for a display mesh still to come, and only for that', async () => {
  const real = new THREE.PlaneGeometry(10, 10, 1, 1);
  assert.equal(isDisplayGeometryPending({ geometry: real }), true, 'not derived yet');
  await requestDisplayGeometry(real);
  assert.equal(isDisplayGeometryPending({ geometry: real }), false, 'settled on its own mesh');

  // An entry that arrived with its display mesh (a clone, a rehydrated snapshot)
  // does not wait on a derivation nobody asked for.
  const restored = new THREE.PlaneGeometry(10, 10, 1, 1);
  assert.equal(isDisplayGeometryPending({ geometry: restored, displayGeometry: new THREE.BufferGeometry() }), false);
});

test('a mesh edited in place is forgotten until its entries drop the stale display mesh', async () => {
  const real = new THREE.PlaneGeometry(10, 10, 1, 1);
  const display = new THREE.BufferGeometry();
  await requestDisplayGeometry(real);

  forgetDisplayGeometry(real);
  assert.equal(settledDisplayGeometry(real), undefined);
  assert.equal(wasEditedInPlace(real), true);
  assert.equal(isDisplayGeometryPending({ geometry: real, displayGeometry: display }), true);

  acknowledgeEditInPlace(real);
  assert.equal(wasEditedInPlace(real), false);
  assert.equal(await requestDisplayGeometry(real), null);
  assert.equal(isDisplayGeometryPending({ geometry: real }), false);
});
