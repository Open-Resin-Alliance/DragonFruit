import assert from 'node:assert/strict';
import test from 'node:test';

import { plateCascadeCell, plateCascadeOffsetMm } from '../plateCascade';

const cellsFor = (count: number) => Array.from({ length: count }, (_, index) => plateCascadeCell(index, count));

test('the grid reads left to right, top to bottom', () => {
  assert.deepEqual(cellsFor(9), [
    { col: 0, row: 0 }, // 1
    { col: 1, row: 0 }, // 2
    { col: 2, row: 0 }, // 3
    { col: 0, row: 1 }, // 4
    { col: 1, row: 1 }, // 5
    { col: 2, row: 1 }, // 6
    { col: 0, row: 2 }, // 7
    { col: 1, row: 2 }, // 8
    { col: 2, row: 2 }, // 9
  ]);
});

test('the block stays as square as it can: a column, then a row', () => {
  // 1x1, 2x1, 2x2, 3x2, 3x3, 4x3 ...
  assert.deepEqual(cellsFor(2).map((c) => c.col), [0, 1]);
  assert.deepEqual(cellsFor(4), [
    { col: 0, row: 0 }, { col: 1, row: 0 },
    { col: 0, row: 1 }, { col: 1, row: 1 },
  ]);
  assert.deepEqual(cellsFor(7), [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 },
    { col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 },
    { col: 0, row: 2 },
  ]);
  assert.deepEqual(cellsFor(10).map((c) => c.col), [0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
});

test('no two plates share a cell, at any count', () => {
  for (const count of [2, 3, 5, 7, 9, 10, 13, 25, 49]) {
    const seen = new Set<string>();
    for (const { col, row } of cellsFor(count)) {
      const key = `${col},${row}`;
      assert.equal(seen.has(key), false, `${count} plates reuses cell ${key}`);
      seen.add(key);
    }
    assert.equal(seen.size, count);
  }
});

test('the first plate is the origin and the pitch is the footprint plus the gap', () => {
  const footprint = { widthMm: 200, depthMm: 120 };

  assert.deepEqual(plateCascadeOffsetMm(0, footprint, 4), { dxMm: 0, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(1, footprint, 4), { dxMm: 224, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(2, footprint, 4), { dxMm: 0, dyMm: 144 });
});

test('adding a plate re-lays the grid, and only where the block grew', () => {
  // Four plates put 3 below 1; the fifth widens the block to three columns, so 3
  // moves up beside 2 and 4, 5 shuffle along behind it.
  assert.deepEqual(plateCascadeCell(2, 4), { col: 0, row: 1 });
  assert.deepEqual(plateCascadeCell(2, 5), { col: 2, row: 0 });
  assert.deepEqual(plateCascadeCell(3, 4), { col: 1, row: 1 });
  assert.deepEqual(plateCascadeCell(3, 5), { col: 0, row: 1 });

  // The first two never move, whatever the count.
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.deepEqual(plateCascadeCell(0, count), { col: 0, row: 0 });
    assert.deepEqual(plateCascadeCell(1, count), { col: 1, row: 0 });
  }
});
