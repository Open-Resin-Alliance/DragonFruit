import assert from 'node:assert/strict';
import test from 'node:test';

import { DYNAMIC_PLATE_ORDERING, PLATE_CASCADE_GAP_MM, type PlateOrdering } from '../plateCascade';
import * as plateLayout from '../plateLayout';
import {
  appendedPlateSlots,
  computePlateFrames,
  plateFrameFor,
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
  assert.equal(resolveModelPlateId({ model: at('a', 0, 0), frames }), 'p1');
  assert.equal(resolveModelPlateId({ model: at('b', 242.88, 0), frames }), 'p2');
  // Dragged back onto the first bed: the stale membership loses.
  assert.equal(resolveModelPlateId({ model: at('c', 10, 10, 'p2'), frames }), 'p1');
});

test('off every plate, the stored membership decides, then the first plate', () => {
  assert.equal(resolveModelPlateId({ model: at('a', 1000, 1000, 'p2'), frames }), 'p2');
  assert.equal(resolveModelPlateId({ model: at('b', 1000, 1000, 'gone'), frames }), 'p1');
  assert.equal(resolveModelPlateId({ model: at('c', 1000, 1000), frames }), 'p1');
  assert.equal(resolveModelPlateId({ model: at('d', 0, 0), frames: [] }), '');
});

test('membership follows the model, unless the gesture names the plate', () => {
  assert.equal(withPlateMembership({ model: at('a', 242.88, 0, 'p1'), frames }).plateId, 'p2');
  assert.equal(withPlateMembership({ model: at('b', 0, 0), frames, landedPlateId: 'p2' }).plateId, 'p2');
  const unframed = at('c', 0, 0, 'p2');
  assert.equal(withPlateMembership({ model: unframed, frames: [] }), unframed, 'with no frames it keeps what it had');
});

test('models on a plate keep their order', () => {
  const models = [at('a', 0, 0), at('b', 242.88, 0), at('c', -50, 20), at('d', 300, 0)];
  assert.deepEqual(modelsOnPlate({ models, plateId: 'p1', frames }).map((m) => m.id), ['a', 'c']);
  assert.deepEqual(modelsOnPlate({ models, plateId: 'p2', frames }).map((m) => m.id), ['b', 'd']);
});

test('a slice scope carries the plate\'s models, volume and offset', () => {
  const models = [at('a', 0, 0), at('b', 242.88, 0)];
  assert.deepEqual(plateSliceScope({ frame: frames[1], models, frames }), {
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

test('a scene left with one bed moves the models of that bed into the first slot', () => {
  const two = plateIds(2);
  const was = computePlateFrames({ plates: two, footprint, ordering: FIXED_3 });
  const models = deepFreeze([
    at('on1', centreOf(was[0]).x, centreOf(was[0]).y),
    at('on2', centreOf(was[1]).x, centreOf(was[1]).y),
  ]);

  const keptFirst = relaidPlateShifts({ before: two, after: [two[0]], models, footprint, ordering: FIXED_3 });
  assert.equal(keptFirst.size, 0, 'the first bed stays where it is');

  const keptSecond = relaidPlateShifts({ before: two, after: [two[1]], models, footprint, ordering: FIXED_3 });
  assert.deepEqual([...keptSecond.keys()], ['on2'], 'the first bed took its models with it');
  assert.deepEqual(keptSecond.get('on2'), { dxMm: was[0].dxMm - was[1].dxMm, dyMm: was[0].dyMm - was[1].dyMm });
});

test('any plate can be deleted, the first included, while another is left', () => {
  const three = Object.freeze([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }].map((plate) => Object.freeze(plate)));
  assert.equal(plateCanBeRemoved({ plates: three, plateId: 'p1' }), true);
  assert.equal(plateCanBeRemoved({ plates: three, plateId: 'p3' }), true);
  assert.equal(plateCanBeRemoved({ plates: three, plateId: 'nope' }), false, 'a plate that is not there');
  assert.equal(plateCanBeRemoved({ plates: Object.freeze([Object.freeze({ id: 'p1' })]), plateId: 'p1' }), false, 'the last plate stays');
});

test('a plate frame is found by id, and a stale id falls back to the first plate', () => {
  const three = deepFreeze(computePlateFrames({ plates: plateIds(3), footprint, ordering: DYNAMIC_PLATE_ORDERING }));
  assert.equal(plateFrameFor({ frames: three, plateId: 'p3' }), three[2]);
  assert.equal(plateFrameFor({ frames: three, plateId: 'gone' }), three[0]);
  assert.equal(plateFrameFor({ frames: three, plateId: null }), three[0]);
  assert.equal(plateFrameFor({ frames: [], plateId: 'p1' }), undefined);
});

test('beds about to be added sit where adding them puts them, on the grown grid', () => {
  const four = deepFreeze(plateIds(4));
  for (const ordering of [DYNAMIC_PLATE_ORDERING, FIXED_3]) {
    for (const originMode of ['center', 'front_left'] as const) {
      const bed = { ...footprint, originMode };
      const grown = computePlateFrames({ plates: [...four, { id: 'n1' }, { id: 'n2' }], footprint: bed, ordering });
      const slots = appendedPlateSlots({ plates: four, count: 2, footprint: bed, ordering });
      assert.deepEqual(slots.map((slot, i) => ({ id: grown[4 + i].id, ...slot })), grown.slice(4), `${ordering.mode}, ${originMode}`);
    }
  }
  // A 2x2 grid of four grows to 3x2 with a fifth bed: the ghost lands in the middle of
  // the second row, not on a third row below the first bed, where a 2-wide grid puts it.
  const [fifth] = appendedPlateSlots({ plates: four, count: 1, footprint, ordering: DYNAMIC_PLATE_ORDERING });
  assert.equal(fifth.index, 4);
  assert.equal(fifth.dyMm, footprint.depthMm + PLATE_CASCADE_GAP_MM);
  assert.equal(fifth.dxMm, footprint.widthMm + PLATE_CASCADE_GAP_MM);
  assert.deepEqual(appendedPlateSlots({ plates: four, count: 0, footprint, ordering: FIXED_3 }), []);
});

test('every exported function takes one parameters object (ADR-0045 rule 4)', () => {
  const functions = Object.entries(plateLayout).filter(([, value]) => typeof value === 'function');
  assert.ok(functions.length > 0, 'the module exports functions');
  for (const [name, fn] of functions) {
    assert.equal((fn as (...args: unknown[]) => unknown).length, 1, `${name} takes one parameters object`);
  }
});
