import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineRootBatchInstance } from '../SupportPrimitives/Roots/inlineRootBatch';
import { BATCHED_PASSES, batchesInView } from '../rendering/batchCoverage';
import { getSupportTypeDescriptor, parseInlineRootId, SUPPORT_TYPES, type SupportEndpoint } from '../supportTypeRegistry';

/** The stump is the one type whose plate root is geometry on the entity. */
const STUMP_ENTITY = {
    id: 'stump-1',
    modelId: 'model-a',
    rootPos: { x: 1, y: 2, z: 0 },
    rootBaseDiameter: 2,
    rootTopDiameter: 1.5,
    rootHeight: 1,
};

test('an inline root batches from the fields its endpoint declares', () => {
    const root = inlineRootBatchInstance(getSupportTypeDescriptor('stump').lower, STUMP_ENTITY);

    assert.ok(root, 'the stump root batches');
    assert.equal(root.supportId, 'stump-1');
    assert.equal(parseInlineRootId(root.id), 'stump-1', 'the primitive id names the entity');
    assert.deepEqual(root.basePos, { x: 1, y: 2, z: 0 });
    assert.equal(root.bottomRadius, 1, 'the base diameter is a diameter');
    assert.equal(root.topRadius, 0.75, 'the frustum tapers to its own top diameter');
    assert.equal(root.coneHeight, 1);
});

test('an inline root without a top radius is a cylinder, and half-built ones stay out', () => {
    const cylinder: SupportEndpoint = { kind: 'inlineRoot', field: 'basePos', radiusField: 'baseDiameter' };
    const entity = { id: 'a', basePos: { x: 0, y: 0, z: 0 }, baseDiameter: 3 };
    const root = inlineRootBatchInstance(cylinder, entity);

    assert.ok(root);
    assert.equal(root.bottomRadius, 1.5);
    assert.equal(root.topRadius, 1.5, 'no top radius declared, so no taper');
    assert.equal(root.coneHeight, 0, 'no height declared, so a disc alone');

    assert.equal(inlineRootBatchInstance(cylinder, { id: 'a', baseDiameter: 3 }), null, 'no base position');
    assert.equal(inlineRootBatchInstance(cylinder, { id: 'a', basePos: { x: 0, y: 0, z: 0 } }), null, 'no base width');
});

test('a type that does not batch its contact cones is still carried by the cone pass', () => {
    // The stump's contact disc, and the line from its root to that disc, come from
    // this pass: its own renderer is skipped in a simple view, and it has no
    // `Roots` row either. Both places that decide it have to agree - the map of
    // cone sets and the groups drawn from it - or the disc silently disappears.
    const drawsOwnCones = SUPPORT_TYPES.filter(
        (descriptor) => descriptor.upper.kind === 'cone' && !descriptor.batchesContactCones,
    );

    assert.ok(drawsOwnCones.length > 0, 'the stump is carried this way');
    for (const descriptor of drawsOwnCones) {
        assert.equal(
            batchesInView('cone', descriptor, true),
            true,
            `${descriptor.id} must reach the cone pass in a simple view`,
        );
    }
});

test('a simple view draws every type through the batched passes', () => {
    // A simple view skips every detail renderer, so a type the batches leave out
    // vanishes from it entirely - which is what a stump did, a frustum root under
    // a contact cone with no `Roots` row and nothing batched. Brace is the one
    // type that needs none of the shared passes: it batches its own curve set.
    // A type could also draw its own simplified form instead; none declares it.
    for (const descriptor of SUPPORT_TYPES) {
        if (descriptor.segmentSelectionPrefix) continue;
        assert.ok(
            BATCHED_PASSES.some((pass) => batchesInView(pass, descriptor, true)),
            `${descriptor.id} is drawn by no batched pass in a simple view`,
        );
    }
});
