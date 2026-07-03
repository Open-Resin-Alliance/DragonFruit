import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRaftBaseCirclesByModel,
  RAFT_UNASSIGNED_MODEL_KEY,
} from '../Rafts/Crenelated/raftFootprintCircles';

test('collectRaftBaseCirclesByModel includes support roots, anchors, and kickstand roots', () => {
  const circlesByModel = collectRaftBaseCirclesByModel({
    roots: [
      {
        modelId: 'model-a',
        diameter: 4,
        transform: { pos: { x: 1, y: 2, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
    anchors: [
      {
        modelId: 'model-a',
        rootBaseDiameter: 6,
        rootPos: { x: 3, y: 4, z: 0 },
      },
    ],
    kickstandRoots: [
      {
        modelId: 'model-a',
        diameter: 2,
        transform: { pos: { x: 5, y: 6, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
      {
        modelId: null as any,
        diameter: 8,
        transform: { pos: { x: -1, y: -2, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
  });

  assert.deepEqual(circlesByModel.get('model-a'), [
    { x: 1, y: 2, r: 2 },
    { x: 3, y: 4, r: 3 },
    { x: 5, y: 6, r: 1 },
  ]);
  assert.deepEqual(circlesByModel.get(RAFT_UNASSIGNED_MODEL_KEY), [
    { x: -1, y: -2, r: 4 },
  ]);
});

test('collectRaftBaseCirclesByModel honors model filters and exclusions for kickstand roots too', () => {
  const circlesByModel = collectRaftBaseCirclesByModel({
    roots: [
      {
        modelId: 'model-a',
        diameter: 4,
        transform: { pos: { x: 1, y: 1, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
    kickstandRoots: [
      {
        modelId: 'model-a',
        diameter: 2,
        transform: { pos: { x: 2, y: 2, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
      {
        modelId: 'model-b',
        diameter: 2,
        transform: { pos: { x: 3, y: 3, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
  }, {
    modelFilterId: 'model-a',
  });

  assert.deepEqual(Array.from(circlesByModel.keys()), ['model-a']);
  assert.equal(circlesByModel.get('model-a')?.length, 2);

  const excluded = collectRaftBaseCirclesByModel({
    kickstandRoots: [
      {
        modelId: 'model-a',
        diameter: 2,
        transform: { pos: { x: 2, y: 2, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
      {
        modelId: 'model-b',
        diameter: 2,
        transform: { pos: { x: 3, y: 3, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
  }, {
    excludedModelIds: new Set(['model-b']),
  });

  assert.deepEqual(Array.from(excluded.keys()), ['model-a']);
});