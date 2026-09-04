import assert from 'node:assert/strict';
import test from 'node:test';

import { captureSupportGeometryToken, isSameSupportGeometry } from '../SupportPrimitives/Knot/useKnotInteraction';
import { addBranch, addKnot, setHoveredState, updateBranch } from '../state';
import type { Branch, Knot } from '../types';

const knot: Knot = {
    id: 'knot-prewarm',
    parentShaftId: 'trunk-seg-1',
    pos: { x: 0, y: 0, z: 3 },
};

const branch: Branch = {
    id: 'branch-prewarm',
    modelId: 'model-1',
    parentKnotId: knot.id,
    segments: [
        { id: 'seg-1', diameter: 1, topJoint: { id: 'joint-1', pos: { x: 0, y: 0, z: 5 }, diameter: 1.1 } },
    ],
};

test('hovering does not invalidate the prewarmed knot-drag capture', () => {
    addKnot(knot);
    addBranch(branch);

    const prewarmed = captureSupportGeometryToken();
    setHoveredState('knot', knot.id);

    assert.equal(isSameSupportGeometry(prewarmed, captureSupportGeometryToken()), true);
});

test('editing branch geometry invalidates the prewarmed knot-drag capture', () => {
    addKnot(knot);
    addBranch(branch);

    const prewarmed = captureSupportGeometryToken();
    updateBranch({
        ...branch,
        segments: [{ ...branch.segments[0], topJoint: { id: 'joint-1', pos: { x: 0, y: 0, z: 8 }, diameter: 1.1 } }],
    });

    assert.equal(isSameSupportGeometry(prewarmed, captureSupportGeometryToken()), false);
});
