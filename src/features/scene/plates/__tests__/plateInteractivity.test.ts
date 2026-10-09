import assert from 'node:assert/strict';
import test from 'node:test';

import { followedPlateIdForMove, modelAnswersPointer, modelPlateScope, rectStandsOnAnyBed } from '../plateInteractivity';

const frames = [
  { id: 'plate-1', minX: -200, minY: -100, maxX: 200, maxY: 100 },
  { id: 'plate-2', minX: 424, minY: -100, maxX: 824, maxY: 100 },
];

test('a scene with one plate answers everywhere, because there is nowhere else to be', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 900, y: 900 }, frames: [frames[0]], activePlateId: 'plate-1', plateCount: 1 }), false),
    true,
  );
});

test('a model on the plate being worked on answers', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 0, y: 0 }, frames, activePlateId: 'plate-1', plateCount: 2 }), false),
    true,
  );
});

test('a model on another plate is scenery', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 600, y: 0 }, frames, activePlateId: 'plate-1', plateCount: 2 }), false),
    false,
  );
});

test('a model off every plate still answers, so it can be dragged back', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 2600, y: 1400 }, frames, activePlateId: 'plate-1', plateCount: 2 }), false),
    true,
  );
});

test('a model exactly on a plate edge counts as on that plate', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 424, y: 100 }, frames, activePlateId: 'plate-1', plateCount: 2 }), false),
    false,
  );
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 424, y: 100 }, frames, activePlateId: 'plate-2', plateCount: 2 }), false),
    true,
  );
});

test('no frames at all leaves every model answering', () => {
  assert.equal(
    modelAnswersPointer(modelPlateScope({ position: { x: 0, y: 0 }, frames: [], activePlateId: undefined, plateCount: 2 }), false),
    true,
  );
});

test('a selected model answers from another bed, so it stays draggable there', () => {
  assert.equal(modelAnswersPointer('other', true), true);
  assert.equal(modelAnswersPointer('other', false), false);
  assert.equal(modelAnswersPointer('loose', false), true);
  assert.equal(modelAnswersPointer('active', false), true);
});

test('a model is classified by where it stands, not only whether it answers', () => {
  const args = { frames, activePlateId: 'plate-1', plateCount: 2 };

  assert.equal(modelPlateScope({ ...args, position: { x: 0, y: 0 } }), 'active');
  assert.equal(modelPlateScope({ ...args, position: { x: 600, y: 0 } }), 'other');
  assert.equal(modelPlateScope({ ...args, position: { x: 2600, y: 1400 } }), 'loose');
});

test('one plate has no other bed to be on, so everything reads as active', () => {
  assert.equal(
    modelPlateScope({ position: { x: 900, y: 900 }, frames: [frames[0]], activePlateId: 'plate-1', plateCount: 1 }),
    'active',
  );
});

test('a move landing wholly on one bed makes that bed the one being worked on', () => {
  assert.equal(
    followedPlateIdForMove({ followLandedPlate: true, landedPlateIds: new Set(['plate-2']) }),
    'plate-2',
  );
});

test('a move spread over several beds says nothing about which to work on', () => {
  assert.equal(
    followedPlateIdForMove({ followLandedPlate: true, landedPlateIds: new Set(['plate-1', 'plate-2']) }),
    null,
  );
});

test('a move that landed nothing on a bed leaves the active plate alone', () => {
  assert.equal(followedPlateIdForMove({ followLandedPlate: true, landedPlateIds: new Set() }), null);
});

test('a bed the caller created in the same step is followed even though it is not in the set yet', () => {
  assert.equal(
    followedPlateIdForMove({
      followLandedPlate: true,
      explicitPlateId: 'plate-3',
      landedPlateIds: new Set(['plate-1']),
    }),
    'plate-3',
  );
});

test('with following turned off, no move makes another bed active', () => {
  assert.equal(
    followedPlateIdForMove({ followLandedPlate: false, landedPlateIds: new Set(['plate-2']) }),
    null,
  );
  assert.equal(
    followedPlateIdForMove({
      followLandedPlate: false,
      explicitPlateId: 'plate-3',
      landedPlateIds: new Set(['plate-2']),
    }),
    null,
  );
});

// The two beds a cascade lays out for a 218 x 123 build volume: the first at the origin,
// the second one gap to the right of it.
const bedOne = { minX: -109, minY: -61.5, maxX: 109, maxY: 61.5 };
const bedTwo = { minX: 133, minY: -61.5, maxX: 351, maxY: 61.5 };

test('a model on the second bed stands on a bed', () => {
  assert.equal(
    rectStandsOnAnyBed({ minX: 212, minY: -20, maxX: 272, maxY: 20 }, [bedOne, bedTwo]),
    true,
  );
});

test('a model in the gap between two beds stands on none of them', () => {
  assert.equal(
    rectStandsOnAnyBed({ minX: 112, minY: -20, maxX: 130, maxY: 20 }, [bedOne, bedTwo]),
    false,
  );
});

test('a model overhanging its bed stands on none of them', () => {
  assert.equal(
    rectStandsOnAnyBed({ minX: 100, minY: -20, maxX: 200, maxY: 20 }, [bedOne, bedTwo]),
    false,
  );
});

test('a footprint touching a bed edge counts as standing on it', () => {
  assert.equal(rectStandsOnAnyBed(bedTwo, [bedOne, bedTwo]), true);
});

test('with no beds at all nothing stands on one', () => {
  assert.equal(rectStandsOnAnyBed({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, []), false);
});
