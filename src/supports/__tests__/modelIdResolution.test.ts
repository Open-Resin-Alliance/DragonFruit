import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addBrace, addBranch, addKnot, addLeaf, addRoot, addTrunk,
    getModelIdForSupportEntityId, resetStore,
} from '../state';
import { MODEL_ID_COLLECTION_KEYS } from '../supportTypeRegistry';

/**
 * Resolving any support id -- entity, segment, joint or knot -- to its model.
 *
 * Was eight hardcoded collection lookups followed by a per-type segment walk.
 * Now derived, so a collection missing from the registry stops resolving rather
 * than falling through to null and silently unbinding a support from its model.
 */

const MODEL = 'model-a';

const segment = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

function scene() {
    resetStore();
    addRoot({
        id: 'root-a', modelId: MODEL,
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
    } as never);
    addTrunk({ id: 'trunk-a', modelId: MODEL, rootId: 'root-a', segments: [segment('seg-ta')] } as never);
    addKnot({ id: 'knot-a', parentShaftId: 'seg-ta', t: 0.5, pos: { x: 0, y: 0, z: 2 }, diameter: 1 } as never);
    addBranch({ id: 'branch-a', modelId: MODEL, parentKnotId: 'knot-a', segments: [segment('seg-ba')] } as never);
    addLeaf({ id: 'leaf-a', modelId: MODEL, parentKnotId: 'knot-a' } as never);
    addBrace({
        id: 'brace-a', modelId: 'model-b',
        startKnotId: 'knot-a', endKnotId: 'knot-a', profile: { diameter: 0.8 },
    } as never);
}

test('an entity resolves to its own model', () => {
    scene();
    for (const id of ['root-a', 'trunk-a', 'branch-a', 'leaf-a']) {
        assert.equal(getModelIdForSupportEntityId(id), MODEL, id);
    }
});

test('a segment and its joints resolve to the shaft owner', () => {
    scene();
    assert.equal(getModelIdForSupportEntityId('seg-ta'), MODEL);
    assert.equal(getModelIdForSupportEntityId('seg-ta-tj'), MODEL);
    assert.equal(getModelIdForSupportEntityId('seg-ba-bj'), MODEL);
});

test('a knot resolves through its host shaft', () => {
    scene();
    assert.equal(getModelIdForSupportEntityId('knot-a'), MODEL);
});

test('the braceSegment prefix resolves to its brace', () => {
    scene();
    assert.equal(getModelIdForSupportEntityId('braceSegment:brace-a'), 'model-b');
});

test('an unknown id resolves to null', () => {
    scene();
    assert.equal(getModelIdForSupportEntityId('nope'), null);
    assert.equal(getModelIdForSupportEntityId(null), null);
    assert.equal(getModelIdForSupportEntityId(undefined), null);
});

test('the walk covers every modelId-bearing collection', () => {
    // A collection dropped from MODEL_ID_COLLECTION_KEYS would stop resolving.
    assert.ok(MODEL_ID_COLLECTION_KEYS.includes('roots'));
    assert.ok(MODEL_ID_COLLECTION_KEYS.includes('kickstands'));
    assert.ok(!MODEL_ID_COLLECTION_KEYS.includes('knots' as never), 'knots carry no modelId');
});
