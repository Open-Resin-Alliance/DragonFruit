import assert from 'node:assert/strict';
import test from 'node:test';

import { DYNAMIC_PLATE_ORDERING, type PlateOrdering } from '../plateCascade';
import {
  computePlateFrames,
  modelsOnPlate,
  plateCanBeRemoved,
  plateLocalRect,
  relaidPlateShifts,
  plateSliceScope,
  resolveModelPlateId,
  withPlateMembership,
} from '../plateLayout';

// Saturn 2: the footprint the CLI's end-to-end check slices with.
const footprint = { widthMm: 218.88, depthMm: 123.12, originMode: 'center' as const };
const twoPlates = [{ id: 'p1' }, { id: 'p2' }];
const frames = computePlateFrames({ plates: twoPlates, footprint, ordering: DYNAMIC_PLATE_ORDERING });

const at = (id: string, x: number, y: number, plateId?: string) => ({
  id,
  transform: { position: { x, y } },
  ...(plateId ? { plateId } : {}),
});

test('a plate starts centred on its origin, or at it for a front-left origin', () => {
  assert.deepEqual(plateLocalRect({ widthMm: 200, depthMm: 100, originMode: 'center' }), {
    minX: -100, minY: -50, maxX: 100, maxY: 50, centerX: 0, centerY: 0,
  });
  assert.deepEqual(plateLocalRect({ widthMm: 200, depthMm: 100, originMode: 'front_left' }), {
    minX: 0, minY: 0, maxX: 200, maxY: 100, centerX: 100, centerY: 50,
  });
});

test('plates are pitched by their footprint plus the cascade gap', () => {
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { id: 'p1', index: 0, dxMm: 0, dyMm: 0, minX: -109.44, minY: -61.56, maxX: 109.44, maxY: 61.56 });
  assert.equal(frames[1].dxMm, 242.88);
  assert.equal(frames[1].dyMm, 0);
  assert.equal(frames[1].minX, -109.44 + 242.88);
  assert.equal(frames[1].maxX, 109.44 + 242.88);
});

test('a model belongs to the plate it stands on, whatever it was stored with', () => {
  assert.equal(resolveModelPlateId(at('a', 0, 0), frames), 'p1');
  assert.equal(resolveModelPlateId(at('b', 242.88, 0), frames), 'p2');
  // Dragged back onto the first bed: the stale membership loses.
  assert.equal(resolveModelPlateId(at('c', 10, 10, 'p2'), frames), 'p1');
});

test('off every plate, the stored membership decides, then the first plate', () => {
  assert.equal(resolveModelPlateId(at('a', 1000, 1000, 'p2'), frames), 'p2');
  assert.equal(resolveModelPlateId(at('b', 1000, 1000, 'gone'), frames), 'p1');
  assert.equal(resolveModelPlateId(at('c', 1000, 1000), frames), 'p1');
  assert.equal(resolveModelPlateId(at('d', 0, 0), []), '');
});

test('membership follows the model, unless the gesture names the plate', () => {
  assert.equal(withPlateMembership(at('a', 242.88, 0, 'p1'), frames).plateId, 'p2');
  assert.equal(withPlateMembership(at('b', 0, 0), frames, 'p2').plateId, 'p2');
  const unframed = at('c', 0, 0, 'p2');
  assert.equal(withPlateMembership(unframed, []), unframed, 'with no frames it keeps what it had');
});

test('models on a plate keep their order', () => {
  const models = [at('a', 0, 0), at('b', 242.88, 0), at('c', -50, 20), at('d', 300, 0)];
  assert.deepEqual(modelsOnPlate(models, 'p1', frames).map((m) => m.id), ['a', 'c']);
  assert.deepEqual(modelsOnPlate(models, 'p2', frames).map((m) => m.id), ['b', 'd']);
});

test('a slice scope carries the plate\'s models, volume and offset', () => {
  const models = [at('a', 0, 0), at('b', 242.88, 0)];
  assert.deepEqual(plateSliceScope(frames[1], models, frames), {
    plateId: 'p2',
    modelIds: ['b'],
    volumeBoundsMm: { minX: frames[1].minX, minY: frames[1].minY, maxX: frames[1].maxX, maxY: frames[1].maxY },
    offsetMm: { dxMm: 242.88, dyMm: 0 },
  });
});

/** Freeze a fixture all the way down, so a rule that writes to its input throws (ADR-0045). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const plateIds = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}` }));
const centreOf = (frame: { minX: number; maxX: number; minY: number; maxY: number }) => ({
  x: (frame.minX + frame.maxX) / 2,
  y: (frame.minY + frame.maxY) / 2,
});
const FIXED_3: PlateOrdering = { mode: 'fixed', columns: 3 };

test('adding a bed that widens the grid moves the models on the beds it re-lays', () => {
  const four = plateIds(4);
  const five = [...four, { id: 'p5' }];
  const was = computePlateFrames({ plates: four, footprint, ordering: DYNAMIC_PLATE_ORDERING });
  const now = computePlateFrames({ plates: five, footprint, ordering: DYNAMIC_PLATE_ORDERING });
  const models = deepFreeze([
    at('on1', centreOf(was[0]).x, centreOf(was[0]).y),
    at('on3', centreOf(was[2]).x, centreOf(was[2]).y),
    at('off', -1000, -1000),
  ]);

  const shifts = relaidPlateShifts({
    before: deepFreeze(four), after: deepFreeze(five), models, footprint, ordering: DYNAMIC_PLATE_ORDERING,
  });

  // A 2x2 grid becomes 3x2: the third bed goes from the second row to the end of the first.
  assert.deepEqual([...shifts.keys()], ['on3'], 'the first bed never moves, and a model on no bed stays put');
  assert.deepEqual(shifts.get('on3'), { dxMm: now[2].dxMm - was[2].dxMm, dyMm: now[2].dyMm - was[2].dyMm });
});

test('removing a bed moves the ones after it a slot down, by id, and leaves its own models', () => {
  const three = plateIds(3);
  const remaining = [three[0], three[2]];
  const was = computePlateFrames({ plates: three, footprint, ordering: FIXED_3 });
  const models = deepFreeze([
    at('on2', centreOf(was[1]).x, centreOf(was[1]).y),
    at('on3', centreOf(was[2]).x, centreOf(was[2]).y),
  ]);

  const shifts = relaidPlateShifts({ before: three, after: remaining, models, footprint, ordering: FIXED_3 });

  assert.deepEqual([...shifts.keys()], ['on3'], 'the removed bed takes its model with it');
  assert.deepEqual(shifts.get('on3'), { dxMm: was[1].dxMm - was[2].dxMm, dyMm: was[1].dyMm - was[2].dyMm });
});

test('a new build volume moves every bed but the first, and the models with them', () => {
  const two = plateIds(2);
  const smaller = { widthMm: 150, depthMm: 90, originMode: 'center' as const };
  const was = computePlateFrames({ plates: two, footprint, ordering: FIXED_3 });
  const now = computePlateFrames({ plates: two, footprint: smaller, ordering: FIXED_3 });
  const models = deepFreeze([at('on2', centreOf(was[1]).x, centreOf(was[1]).y)]);

  const shifts = relaidPlateShifts({
    before: two, after: two, models, footprint: smaller, ordering: FIXED_3, laidOut: footprint,
  });

  assert.deepEqual(shifts.get('on2'), { dxMm: now[1].dxMm - was[1].dxMm, dyMm: 0 });
});

test('a new ordering moves the models from the grid they were laid out on', () => {
  const four = plateIds(4);
  const was = computePlateFrames({ plates: four, footprint, ordering: FIXED_3 });
  const now = computePlateFrames({ plates: four, footprint, ordering: DYNAMIC_PLATE_ORDERING });
  const models = deepFreeze(was.map((frame, i) => at(`on${i + 1}`, centreOf(frame).x, centreOf(frame).y)));

  const shifts = relaidPlateShifts({
    before: four, after: four, models, footprint, ordering: DYNAMIC_PLATE_ORDERING, wasOrdering: FIXED_3,
  });

  for (const [i, frame] of was.entries()) {
    const moved = { dxMm: now[i].dxMm - frame.dxMm, dyMm: now[i].dyMm - frame.dyMm };
    if (moved.dxMm === 0 && moved.dyMm === 0) assert.equal(shifts.has(`on${i + 1}`), false);
    else assert.deepEqual(shifts.get(`on${i + 1}`), moved);
  }
  assert.ok(shifts.size > 0, 'the two grids differ for four beds');
});

test('a scene left with one bed has nothing to re-lay', () => {
  const two = plateIds(2);
  const was = computePlateFrames({ plates: two, footprint, ordering: FIXED_3 });
  const models = deepFreeze([at('on1', centreOf(was[0]).x, centreOf(was[0]).y)]);
  assert.equal(relaidPlateShifts({ before: two, after: [two[0]], models, footprint, ordering: FIXED_3 }).size, 0);
});

test('any plate can be deleted, the first included, while another is left', () => {
  const three = Object.freeze([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }].map((plate) => Object.freeze(plate)));
  assert.equal(plateCanBeRemoved(three, 'p1'), true);
  assert.equal(plateCanBeRemoved(three, 'p3'), true);
  assert.equal(plateCanBeRemoved(three, 'nope'), false, 'a plate that is not there');
  assert.equal(plateCanBeRemoved(Object.freeze([Object.freeze({ id: 'p1' })]), 'p1'), false, 'the last plate stays');
});
