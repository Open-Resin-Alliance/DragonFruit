import assert from 'node:assert/strict';
import test from 'node:test';

import { cascadeCollectionsFor } from '../supportCascade';
import { removalShapeFor, SUPPORT_TYPES } from '../supportTypeRegistry';

/**
 * Every collection a removal can reach must have a field in that type's
 * declared removal shape. An undeclared one is deleted without being recorded,
 * so undo cannot bring it back.
 */

test('a type hosting its own kind reaches its own collection', () => {
    // A shaft carries knots, so any type hosted on a knot hangs off its own
    // kind too. Derived from the edges, so a new such type is covered.
    const selfHosting = SUPPORT_TYPES.filter((descriptor) => descriptor.hasSegments
        && descriptor.edges.some((edge) => edge.ownership === 'hostedBy' && edge.to === 'knots'));
    assert.ok(selfHosting.length > 0, 'at least one type hosts its own kind');

    for (const descriptor of selfHosting) {
        assert.ok(
            cascadeCollectionsFor(descriptor.id).has(descriptor.location.key),
            `${descriptor.id}: hosts its own kind, so its cascade reaches ${descriptor.location.key}`,
        );
    }
});

test('each declared removal shape records every collection its cascade reaches', () => {
    let checked = 0;
    for (const descriptor of SUPPORT_TYPES) {
        const declared = new Set<unknown>(Object.keys(removalShapeFor(descriptor.id).cascade));
        for (const collection of cascadeCollectionsFor(descriptor.id)) {
            assert.ok(
                declared.has(collection),
                `${descriptor.id}: the cascade reaches ${collection}, which its removal shape does not record`,
            );
            checked += 1;
        }
    }
    assert.ok(checked > 0, 'the derivation reached at least one collection');
});
