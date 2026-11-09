import assert from 'node:assert/strict';
import test from 'node:test';

import { buildKickstandSnapTargetMetaIndex } from '../interaction/shared/placement/snapping/kickstandSnapTargets';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import type { Kickstand, Knot, Roots } from '../types';

const MODEL_ID = 'model-1';

/** A kickstand whose last segment ends at its host knot, as placement builds it. */
function seedKickstand(): void {
    resetStore();
    addRoot({
        id: 'root-1',
        modelId: MODEL_ID,
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 1,
    } as Roots);
    addKnot({
        id: 'knot-1',
        parentShaftId: 'shaft-1',
        t: 0.25,
        pos: { x: 2, y: 0, z: 14 },
        diameter: 1.1,
    } as Knot);
    addSupportEntity('kickstand', {
        id: 'kick-1',
        modelId: MODEL_ID,
        rootId: 'root-1',
        hostKnotId: 'knot-1',
        hostSegmentId: 'shaft-1',
        hostMinT: 0,
        segments: [
            {
                id: 'seg-first',
                diameter: 1,
                topJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 4 }, diameter: 1.1 },
            },
            {
                id: 'seg-lower',
                diameter: 1,
                bottomJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 4 }, diameter: 1.1 },
                topJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: 1.1 },
            },
            {
                id: 'seg-terminal',
                diameter: 1,
                bottomJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: 1.1 },
            },
        ],
        profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1.1 },
    } as unknown as Kickstand);
}

test('every segment of a kickstand can host another kickstand', () => {
    seedKickstand();
    const index = buildKickstandSnapTargetMetaIndex(getSnapshot());
    const ids = [...index.keys()].sort();

    assert.deepEqual(ids, ['seg-first', 'seg-lower', 'seg-terminal']);
    for (const meta of index.values()) {
        assert.equal(meta.supportKind, 'kickstand');
    }
    resetStore();
});

test('the terminal segment spans from its joint to the host knot', () => {
    seedKickstand();
    const target = buildKickstandSnapTargetMetaIndex(getSnapshot()).get('seg-terminal');
    const path = target?.target.pathSegment;

    assert.ok(path, 'the terminal segment carries a path to ride');
    assert.deepEqual(path.start, { x: 0, y: 0, z: 10 });
    assert.deepEqual(path.end, { x: 2, y: 0, z: 14 });
    resetStore();
});

test('the first segment spans from the root top to its joint', () => {
    seedKickstand();
    const target = buildKickstandSnapTargetMetaIndex(getSnapshot()).get('seg-first');
    const path = target?.target.pathSegment;

    assert.ok(path, 'the first segment carries a path to ride');
    // The root sits at z 0 with a 0.5 disk under a 1 cone.
    assert.deepEqual(path.start, { x: 0, y: 0, z: 1.5 });
    assert.deepEqual(path.end, { x: 0, y: 0, z: 4 });
    resetStore();
});
