import { describe, it } from 'node:test';
import assert from 'node:assert';
import { addKnot, addRoot, addSupportEntity, getSnapshot, removeSupportEntitiesForModel, resetStore } from '../state';
import { getSupportsForModel } from '../PlacementLogic/SupportModelLinker';

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

    addSupportEntity('twig', twigA);
    addSupportEntity('twig', twigB);

    const before = getSupportsForModel(getSnapshot(), 'model-a');
    assert.strictEqual(before.twigs.length, 1, 'Expected one twig mapped to model-a before deletion');

    const removedCount = removeSupportEntitiesForModel('model-a');
    assert.ok(removedCount >= 1, 'Expected at least one support entity removal for model-a');

    const afterState = getSnapshot();
    assert.ok(!afterState.twigs['twig-a'], 'Twig for deleted model should be removed');
    assert.ok(!!afterState.twigs['twig-b'], 'Twig for other models should remain');
  });

  it('takes a dependent of another model that hung off the deleted one', () => {
    resetStore();
    addRoot({
      id: 'root-a', modelId: 'model-a',
      transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
      diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
    } as never);
    addSupportEntity('trunk', {
      id: 'trunk-a', modelId: 'model-a', rootId: 'root-a',
      segments: [makeTwig('trunk-a', 'model-a').segments[0]],
    } as never);
    addKnot({
      id: 'knot-shared', parentShaftId: 'trunk-a-seg', t: 0.5,
      pos: { x: 0, y: 0, z: 1.5 }, diameter: 0.7,
    } as never);
    addSupportEntity('branch', {
      id: 'branch-b', modelId: 'model-b', parentKnotId: 'knot-shared',
      segments: [makeTwig('branch-b', 'model-b').segments[0]],
    } as never);

    removeSupportEntitiesForModel('model-a');

    const after = getSnapshot();
    assert.ok(!after.trunks['trunk-a'], 'the deleted model shaft is gone');
    assert.ok(
      !after.branches['branch-b'],
      'the other model branch hung off that shaft, so it goes rather than dangling',
    );
    assert.ok(!after.knots['knot-shared'], 'and the knot it hung from');
  });
});
