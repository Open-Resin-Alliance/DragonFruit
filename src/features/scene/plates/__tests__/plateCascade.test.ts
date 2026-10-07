import assert from 'node:assert/strict';
import test from 'node:test';

import { plateCascadeCell, plateCascadeOffsetMm } from '../plateCascade';

test('the first plate sits at the origin and the rest spiral out around it', () => {
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(plateCascadeCell);

  assert.deepEqual(cells, [
    { col: 0, row: 0 },   // 1
    { col: 1, row: 0 },   // 2, right of 1
    { col: 1, row: 1 },   // 3, below 2
    { col: 0, row: 1 },   // 4, below 1
    { col: -1, row: 1 },  // 5, left of 4
    { col: -1, row: 0 },  // 6, above 5
    { col: -1, row: -1 }, // 7, above 6
    { col: 0, row: -1 },  // 8, right of 7
    { col: 1, row: -1 },  // 9, right of 8
  ]);
});

test('no two plates share a cell, out to a couple of rings', () => {
  const seen = new Set<string>();
  for (let index = 0; index < 49; index += 1) {
    const { col, row } = plateCascadeCell(index);
    const key = `${col},${row}`;
    assert.equal(seen.has(key), false, `plate ${index + 1} reuses cell ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, 49);
});

test('the spiral completes each ring before starting the next', () => {
  // The first ring is the eight cells around the origin.
  const ring = new Set(['1,0', '1,1', '0,1', '-1,1', '-1,0', '-1,-1', '0,-1', '1,-1']);
  for (let index = 1; index <= 8; index += 1) {
    const { col, row } = plateCascadeCell(index);
    assert.ok(ring.has(`${col},${row}`), `plate ${index + 1} is still on the first ring`);
  }

  // Plate ten opens the second ring, one step beyond plate nine.
  assert.deepEqual(plateCascadeCell(9), { col: 2, row: -1 });
});

test('offsets are the cell times the plate pitch, so plates never touch', () => {
  const footprint = { widthMm: 200, depthMm: 120 };

  assert.deepEqual(plateCascadeOffsetMm(0, footprint), { dxMm: 0, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(1, footprint), { dxMm: 224, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(3, footprint), { dxMm: 0, dyMm: 144 });
  assert.deepEqual(plateCascadeOffsetMm(4, footprint), { dxMm: -224, dyMm: 144 });

  // The pitch is the footprint plus the gap, so adjacent volumes clear each other.
  const adjacent = plateCascadeOffsetMm(1, footprint);
  assert.ok(adjacent.dxMm > footprint.widthMm);
});
