import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { computeHandlePlacements } from '../logic/computeHandlePlacements';
import { HANDLE_SURFACE_GAP_MM } from '../constants';

function makeBox() {
  return new THREE.Box3(
    new THREE.Vector3(-10, -20, 0),
    new THREE.Vector3(10, 20, 30),
  );
}

test('computeHandlePlacements returns six placements (2 per axis)', () => {
  const result = computeHandlePlacements(makeBox());
  assert.equal(result.length, 6);
  for (const axis of ['x', 'y', 'z'] as const) {
    const matching = result.filter((p) => p.axis === axis);
    assert.equal(matching.length, 2);
    assert.equal(matching.filter((p) => p.side === 'positive').length, 1);
    assert.equal(matching.filter((p) => p.side === 'negative').length, 1);
  }
});

test('handles sit offset from the bbox surface by HANDLE_SURFACE_GAP_MM', () => {
  const box = makeBox();
  const result = computeHandlePlacements(box);
  const xPos = result.find((p) => p.axis === 'x' && p.side === 'positive')!;
  const xNeg = result.find((p) => p.axis === 'x' && p.side === 'negative')!;
  assert.equal(xPos.position.x, box.max.x + HANDLE_SURFACE_GAP_MM);
  assert.equal(xNeg.position.x, box.min.x - HANDLE_SURFACE_GAP_MM);
});

test('handles point inward toward the bbox center', () => {
  const result = computeHandlePlacements(makeBox());
  const xPos = result.find((p) => p.axis === 'x' && p.side === 'positive')!;
  const xNeg = result.find((p) => p.axis === 'x' && p.side === 'negative')!;
  assert.equal(xPos.direction.x, -1);
  assert.equal(xNeg.direction.x, 1);
});

test('non-axis components of handle position match bbox center', () => {
  const box = makeBox();
  const center = box.getCenter(new THREE.Vector3());
  const result = computeHandlePlacements(box);
  const xPos = result.find((p) => p.axis === 'x' && p.side === 'positive')!;
  assert.equal(xPos.position.y, center.y);
  assert.equal(xPos.position.z, center.z);
});
