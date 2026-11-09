import assert from 'node:assert/strict';
import test from 'node:test';

import { shelfPack, type ShelfItem } from '../shelfPack';

const BED_W = 143.36;
const BED_D = 89.6;
const SPACING = 5;

function pack(items: ShelfItem[], allowTurn = true) {
  return shelfPack(items, { widthMm: BED_W, depthMm: BED_D, spacingMm: SPACING, allowTurn });
}

function item(id: string, width: number, depth: number): ShelfItem {
  return { id, width, depth };
}

/** Every placement sits on the bed, and no two share ground. */
function assertClean(items: ShelfItem[], result: ReturnType<typeof pack>) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rects = result.placed.map((placement) => {
    const source = byId.get(placement.id)!;
    const w = placement.turned ? source.depth : source.width;
    const d = placement.turned ? source.width : source.depth;
    return {
      id: placement.id,
      minX: placement.x - w / 2, maxX: placement.x + w / 2,
      minY: placement.y - d / 2, maxY: placement.y + d / 2,
    };
  });

  for (const rect of rects) {
    assert.ok(
      rect.minX >= -1e-6 && rect.maxX <= BED_W + 1e-6
      && rect.minY >= -1e-6 && rect.maxY <= BED_D + 1e-6,
      `${rect.id} landed off the bed: x ${rect.minX.toFixed(2)}..${rect.maxX.toFixed(2)}, `
      + `y ${rect.minY.toFixed(2)}..${rect.maxY.toFixed(2)}`,
    );
  }

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlaps = a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6
        && a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6;
      assert.ok(!overlaps, `${a.id} and ${b.id} share ground`);
    }
  }

  const accounted = new Set([...result.placed.map((p) => p.id), ...result.spilled]);
  assert.equal(accounted.size, items.length, 'every item is either placed or spilled');
}

test('shelf pack puts what fits on one bed', () => {
  const items = [
    item('a', 30, 30), item('b', 30, 30), item('c', 30, 30),
    item('d', 25, 20), item('e', 20, 25), item('f', 15, 15),
  ];
  const result = pack(items);
  assert.equal(result.spilled.length, 0, 'six small items fit one bed');
  assertClean(items, result);
});

test('shelf pack spills what the bed cannot take', () => {
  const items = [item('a', 70, 70), item('b', 70, 70), item('c', 70, 70), item('d', 70, 70)];
  const result = pack(items);
  assert.ok(result.spilled.length > 0, 'four 70mm items do not fit one bed');
  assertClean(items, result);
});

test('shelf pack turns an item that only fits side-on', () => {
  // 120 deep exceeds the 89.6 bed, but 120 wide fits the 143.36 bed.
  const items = [item('tall', 40, 120)];
  const result = pack(items);
  assert.equal(result.spilled.length, 0, 'it fits once turned');
  assert.equal(result.placed[0].turned, true, 'and the pack says it turned it');
  assertClean(items, result);
});

test('shelf pack leaves an item alone when it already fits', () => {
  const items = [item('wide', 120, 40)];
  const result = pack(items);
  assert.equal(result.placed[0].turned, false, 'no turn is forced on something that fits');
  assertClean(items, result);
});

test('shelf pack spills what fits in no orientation', () => {
  const items = [item('huge', 200, 200)];
  const result = pack(items);
  assert.deepEqual(result.spilled, ['huge']);
  assert.equal(result.placed.length, 0);
});

test('shelf pack does not turn when turning is refused', () => {
  const items = [item('tall', 40, 120)];
  const result = pack(items, false);
  assert.deepEqual(result.spilled, ['tall'], 'without a turn it does not fit');
});

test('shelf pack keeps a big item placeable by taking it first', () => {
  // File order puts the small ones first; taken in that order they would own the
  // middle of the bed and the big one would spill.
  const items = [
    item('s1', 20, 20), item('s2', 20, 20), item('s3', 20, 20),
    item('big', 130, 60),
    item('s4', 20, 20), item('s5', 20, 20),
  ];
  const result = pack(items);
  assert.ok(!result.spilled.includes('big'), 'the big item is placed, not spilled');
  assertClean(items, result);
});

test('shelf pack handles an empty set', () => {
  const result = pack([]);
  assert.deepEqual(result.placed, []);
  assert.deepEqual(result.spilled, []);
});

test('shelf pack is deterministic', () => {
  const items = [
    item('a', 40, 30), item('b', 30, 40), item('c', 25, 25),
    item('d', 50, 20), item('e', 15, 60),
  ];
  const first = pack(items);
  const second = pack(items);
  assert.deepEqual(second, first, 'the same input packs the same way twice');
});

test('shelf pack spaces items by the gap it was given', () => {
  const items = [item('a', 40, 40), item('b', 40, 40)];
  const result = pack(items);
  assert.equal(result.spilled.length, 0);
  const [first, second] = result.placed.sort((p, q) => p.x - q.x);
  const gap = (second.x - 20) - (first.x + 20);
  assert.ok(Math.abs(gap - SPACING) < 1e-6, `expected a ${SPACING}mm gap, got ${gap.toFixed(3)}`);
});
