import { describe, it } from 'node:test';
import assert from 'node:assert';
import { addTwig, getSnapshot, resetStore } from '../state';
import { deleteSupportsForModel, getSupportsForModel } from '../PlacementLogic/SupportModelLinker';

function makeTwig(id: string, modelId: string) {
  return {
    id,
    modelId,
    segments: [
      {
        id: `${id}-seg`,
        type: 'straight',
        diameter: 0.6,
        bottomJoint: {
          id: `${id}-j0`,
          pos: { x: 0, y: 0, z: 1 },
          diameter: 0.7,
        },
        topJoint: {
          id: `${id}-j1`,
          pos: { x: 0, y: 0, z: 5 },
          diameter: 0.7,
        },
      },
    ],
    contactDiskA: {
      id: `${id}-diskA`,
      pos: { x: 0, y: 0, z: 1 },
      surfaceNormal: { x: 0, y: 0, z: 1 },
      coneAxis: { x: 0, y: 0, z: 1 },
      profile: {
        type: 'disk',
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.25,
        standoffAngleThreshold: Math.PI / 4,
      },
      contactDiameterMm: 0.4,
    },
    contactDiskB: {
      id: `${id}-diskB`,
      pos: { x: 0, y: 0, z: 5 },
      surfaceNormal: { x: 0, y: 0, z: 1 },
      coneAxis: { x: 0, y: 0, z: 1 },
      profile: {
        type: 'disk',
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.25,
        standoffAngleThreshold: Math.PI / 4,
      },
      contactDiameterMm: 0.4,
    },
  } as any;
}

describe('SupportModelLinker', () => {
  it('deletes twigs that belong to the deleted model', () => {
    resetStore();

    const twigA = makeTwig('twig-a', 'model-a');
    const twigB = makeTwig('twig-b', 'model-b');

    addTwig(twigA);
    addTwig(twigB);

    const before = getSupportsForModel(getSnapshot(), 'model-a');
    assert.strictEqual(before.twigs.length, 1, 'Expected one twig mapped to model-a before deletion');

    const removedCount = deleteSupportsForModel(getSnapshot(), 'model-a');
    assert.ok(removedCount >= 1, 'Expected at least one support entity removal for model-a');

    const afterState = getSnapshot();
    assert.ok(!afterState.twigs['twig-a'], 'Twig for deleted model should be removed');
    assert.ok(!!afterState.twigs['twig-b'], 'Twig for other models should remain');
  });
});
