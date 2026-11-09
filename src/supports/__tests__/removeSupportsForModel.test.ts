import assert from 'node:assert/strict';
import test from 'node:test';

import { addKnot, addRoot, addSupportEntity, getSnapshot, removeSupportEntitiesForModel, resetStore } from '../state';
import type { Segment, SupportState } from '../types';

const joint = (id: string, z: number) => ({ id, pos: { x: 0, y: 0, z }, diameter: 1 });
const segment = (id: string, bottomZ: number, topZ: number): Segment => ({
    id,
    type: 'straight',
    diameter: 1,
    bottomJoint: joint(`${id}-bottom`, bottomZ),
    topJoint: joint(`${id}-top`, topZ),
});
const cone = (id: string, z: number) => ({
    id,
    pos: { x: 0, y: 0, z },
    normal: { x: 0, y: 0, z: -1 },
    profile: { type: 'cone', bodyDiameterMm: 1, contactDiameterMm: 0.4, lengthMm: 1 },
});
const root = (id: string, modelId: string) => ({
    id,
    modelId,
    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 1.5,
});

test('replacing a model takes the other model dependent that hung off it', () => {
    // A sweep by modelId left this branch on a deleted shaft; the cascade is
    // seeded from the model's entities and follows the graph out of it.
    resetStore();
    try {
        addRoot(root('root-a', 'model-a'));
        addSupportEntity('trunk', {
            id: 'trunk-a', modelId: 'model-a', rootId: 'root-a',
            segments: [segment('seg-a', 0, 10)], contactCone: cone('cone-a', 12),
        });
        addKnot({
            id: 'knot-shared', parentShaftId: 'seg-a', t: 0.5,
            pos: { x: 0, y: 0, z: 5 }, diameter: 1.125,
        });
        addSupportEntity('branch', {
            id: 'branch-b', modelId: 'model-b', parentKnotId: 'knot-shared',
            segments: [segment('seg-b', 0, 4)], contactCone: cone('cone-b', 6),
        });

        assert.ok(removeSupportEntitiesForModel('model-a'));

        const state = getSnapshot() as unknown as SupportState;
        assert.deepEqual(Object.keys(state.trunks), []);
        assert.deepEqual(Object.keys(state.branches), [], 'the dependent goes with its host shaft');
        assert.deepEqual(Object.keys(state.knots), []);
    } finally {
        resetStore();
    }
});
