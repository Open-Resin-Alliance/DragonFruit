import assert from 'node:assert/strict';
import test from 'node:test';

import { followedPlateIdForMove, modelAnswersPointer, modelPlateScope } from '../plateInteractivity';

const frames = [
  { id: 'plate-1', minX: -200, minY: -100, maxX: 200, maxY: 100 },
  { id: 'plate-2', minX: 424, minY: -100, maxX: 824, maxY: 100 },
];

test('a scene with one plate answers everywhere, because there is nowhere else to be', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 900, y: 900 }, frames: [frames[0]], activePlateId: 'plate-1', plateCount: 1 }),
    true,
  );
});

test('a model on the plate being worked on answers', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 0, y: 0 }, frames, activePlateId: 'plate-1', plateCount: 2 }),
    true,
  );
});

test('a model on another plate is scenery', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 600, y: 0 }, frames, activePlateId: 'plate-1', plateCount: 2 }),
    false,
  );
});

test('a model off every plate still answers, so it can be dragged back', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 2600, y: 1400 }, frames, activePlateId: 'plate-1', plateCount: 2 }),
    true,
  );
});

test('a model exactly on a plate edge counts as on that plate', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 424, y: 100 }, frames, activePlateId: 'plate-1', plateCount: 2 }),
    false,
  );
  assert.equal(
    modelAnswersPointer({ position: { x: 424, y: 100 }, frames, activePlateId: 'plate-2', plateCount: 2 }),
    true,
  );
});

test('no frames at all leaves every model answering', () => {
  assert.equal(
    modelAnswersPointer({ position: { x: 0, y: 0 }, frames: [], activePlateId: undefined, plateCount: 2 }),
    true,
  );
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
