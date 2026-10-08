import assert from 'node:assert/strict';
import test from 'node:test';

import { freeRectsForPlate, type PlateRect } from '../plateFreeSpace';

const PLATE: PlateRect = { minX: 0, maxX: 100, minY: 0, maxY: 60 };

const overlaps = (a: PlateRect, b: PlateRect) => (
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
);

const inside = (inner: PlateRect, outer: PlateRect) => (
  inner.minX >= outer.minX && inner.maxX <= outer.maxX
  && inner.minY >= outer.minY && inner.maxY <= outer.maxY
);

test('an empty plate is one free rectangle', () => {
  assert.deepEqual(freeRectsForPlate(PLATE, []), [PLATE]);
});

test('free rectangles avoid the models on the bed, and each other', () => {
  const occupied: PlateRect[] = [
    { minX: 20, maxX: 40, minY: 15, maxY: 35 },
    { minX: 60, maxX: 80, minY: 20, maxY: 40 },
  ];

  const free = freeRectsForPlate(PLATE, occupied);

  assert.ok(free.length > 0, 'expected some free space around two models');
  for (const rect of free) {
    assert.ok(inside(rect, PLATE), `free rect ${JSON.stringify(rect)} escaped the plate`);
    for (const blocker of occupied) {
      assert.ok(!overlaps(rect, blocker), `free rect ${JSON.stringify(rect)} overlaps a model`);
    }
  }

  for (let i = 0; i < free.length; i += 1) {
    for (let j = i + 1; j < free.length; j += 1) {
      assert.ok(!overlaps(free[i], free[j]), 'free rectangles must not overlap each other');
    }
  }
});

test('the gap widens every model, so a packed neighbour keeps its distance', () => {
  const occupied: PlateRect[] = [{ minX: 40, maxX: 60, minY: 20, maxY: 40 }];

  const tight = freeRectsForPlate(PLATE, occupied, { gapMm: 0 });
  const spaced = freeRectsForPlate(PLATE, occupied, { gapMm: 4 });

  const leftEdgeOf = (rects: PlateRect[]) => Math.max(...rects.filter((r) => r.maxX <= 40).map((r) => r.maxX));
  assert.equal(leftEdgeOf(tight), 40);
  assert.equal(leftEdgeOf(spaced), 38, 'a 4mm gap takes 2mm from each side');
});

test('a bed with no room left has no free rectangles', () => {
  const occupied: PlateRect[] = [{ minX: -1, maxX: 101, minY: -1, maxY: 61 }];
  assert.deepEqual(freeRectsForPlate(PLATE, occupied), []);
});

test('slivers are dropped and the list is capped', () => {
  const occupied: PlateRect[] = [
    { minX: 0, maxX: 50, minY: 0, maxY: 30 },
    { minX: 50, maxX: 100, minY: 0, maxY: 30 },
    { minX: 0, maxX: 33, minY: 30, maxY: 60 },
    { minX: 33, maxX: 66, minY: 30, maxY: 60 },
  ];

  const free = freeRectsForPlate(PLATE, occupied, { minSideMm: 20, maxRects: 1 });
  assert.equal(free.length, 1, 'the cap keeps only the largest rectangle');
  assert.ok(inside(free[0], PLATE));
  assert.ok(free[0].maxX - free[0].minX >= 20 && free[0].maxY - free[0].minY >= 20);
});
