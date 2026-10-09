import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_FIXED_PLATE_COLUMNS,
  DYNAMIC_PLATE_ORDERING,
  MAX_FIXED_PLATE_COLUMNS,
  fixedPlateColumns,
  plateCascadeCell,
  plateCascadeOffsetMm,
  readPlateOrdering,
  type PlateOrdering,
} from '../plateCascade';

const dynamic = DYNAMIC_PLATE_ORDERING;
const fixed = (columns: number): PlateOrdering => ({ mode: 'fixed', columns });

const cellsFor = (count: number) =>
  Array.from({ length: count }, (_, index) => plateCascadeCell(index, count, dynamic));

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

  assert.deepEqual(plateCascadeOffsetMm(0, footprint, 4, dynamic), { dxMm: 0, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(1, footprint, 4, dynamic), { dxMm: 224, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(2, footprint, 4, dynamic), { dxMm: 0, dyMm: 144 });
});

test('adding a plate re-lays the grid, and only where the block grew', () => {
  // Four plates put 3 below 1; the fifth widens the block to three columns, so 3
  // moves up beside 2 and 4, 5 shuffle along behind it.
  assert.deepEqual(plateCascadeCell(2, 4, dynamic), { col: 0, row: 1 });
  assert.deepEqual(plateCascadeCell(2, 5, dynamic), { col: 2, row: 0 });
  assert.deepEqual(plateCascadeCell(3, 4, dynamic), { col: 1, row: 1 });
  assert.deepEqual(plateCascadeCell(3, 5, dynamic), { col: 0, row: 1 });

  // The first two never move, whatever the count.
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.deepEqual(plateCascadeCell(0, count, dynamic), { col: 0, row: 0 });
    assert.deepEqual(plateCascadeCell(1, count, dynamic), { col: 1, row: 0 });
  }
});

test('a fixed grid reads across the count, then down: 1-2-3-4 / 5-6-7-8', () => {
  const four = (index: number) => plateCascadeCell(index, 8, fixed(4));

  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(four), [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 },
    { col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 },
  ]);
});

test('a fixed grid is not re-laid by the plate count, which is the point of it', () => {
  const at = (index: number, count: number) => plateCascadeCell(index, count, fixed(4));

  for (const count of [5, 8, 9, 13]) {
    for (const index of [1, 2, 3, 4, 7]) {
      assert.deepEqual(at(index, count), at(index, 8), `${count} plates moved plate ${index + 1}`);
    }
  }
});

test('a fixed grid of one column is a single file', () => {
  const single = (index: number) => plateCascadeCell(index, 6, fixed(1));

  assert.deepEqual([0, 1, 2].map(single), [
    { col: 0, row: 0 }, { col: 0, row: 1 }, { col: 0, row: 2 },
  ]);
});

test('a column count is whole and bounded, whatever it is handed', () => {
  assert.equal(fixedPlateColumns(4), 4);
  assert.equal(fixedPlateColumns(0), 1);
  assert.equal(fixedPlateColumns(-3), 1);
  assert.equal(fixedPlateColumns(4.6), 5);
  assert.equal(fixedPlateColumns(Number.NaN), DEFAULT_FIXED_PLATE_COLUMNS);
  assert.equal(fixedPlateColumns(Number.POSITIVE_INFINITY), DEFAULT_FIXED_PLATE_COLUMNS);
  assert.equal(fixedPlateColumns(500), MAX_FIXED_PLATE_COLUMNS);

  // And the cell maths uses the same bound, so a stored 0 cannot divide by zero.
  assert.deepEqual(plateCascadeCell(3, 4, fixed(0)), { col: 0, row: 3 });
});

test('the first plate is the origin under either ordering', () => {
  const footprint = { widthMm: 200, depthMm: 120 };

  assert.deepEqual(plateCascadeOffsetMm(0, footprint, 4, dynamic), { dxMm: 0, dyMm: 0 });
  assert.deepEqual(plateCascadeOffsetMm(0, footprint, 4, fixed(4)), { dxMm: 0, dyMm: 0 });
  // Under a fixed grid the fifth plate starts a row: same column as the first.
  assert.deepEqual(plateCascadeOffsetMm(4, footprint, 8, fixed(4)), { dxMm: 0, dyMm: 144 });
});

test('the default fixed grid is three to a row', () => {
  assert.equal(DEFAULT_FIXED_PLATE_COLUMNS, 3);
  const byDefault = (index: number) => plateCascadeCell(index, 6, fixed(3));

  assert.deepEqual([0, 1, 2, 3].map(byDefault), [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 1 },
  ]);
});

test('a saved layout reads back, and anything else reads as nothing', () => {
  assert.deepEqual(readPlateOrdering({ mode: 'fixed', columns: 2 }), { mode: 'fixed', columns: 2 });
  assert.deepEqual(readPlateOrdering({ mode: 'dynamic', columns: 4 }), { mode: 'dynamic', columns: 4 });
  // A file written before the ordering existed, or by something that mangled it.
  assert.equal(readPlateOrdering(undefined), null);
  assert.equal(readPlateOrdering(null), null);
  assert.equal(readPlateOrdering('fixed'), null);
  assert.equal(readPlateOrdering({ mode: 'diagonal' }), null);
  assert.equal(readPlateOrdering({}), null);
  // Bounded on the way in too, so a hand-edited file cannot ask for 900 columns.
  assert.deepEqual(readPlateOrdering({ mode: 'fixed', columns: 900 }), { mode: 'fixed', columns: MAX_FIXED_PLATE_COLUMNS });
  assert.deepEqual(readPlateOrdering({ mode: 'fixed', columns: 'four' }), { mode: 'fixed', columns: DEFAULT_FIXED_PLATE_COLUMNS });
});
