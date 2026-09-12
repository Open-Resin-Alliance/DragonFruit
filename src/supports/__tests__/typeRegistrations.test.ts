import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import {
    collectionsMissingRestore,
    inferSupportSettings,
    resolveKnotDiameter,
    SUPPORT_TYPES,
    updateSupportEntity,
} from '../supportTypeRegistry';

/**
 * The registry's slots are filled by side effect at load. Nothing else checks
 * they were actually filled: deleting a whole registration left all 799 other
 * tests passing, because a missing slot falls through to a default.
 */

test('every type registers an updater', () => {
    for (const descriptor of SUPPORT_TYPES) {
        assert.equal(
            updateSupportEntity(descriptor.id, { id: 'nonexistent' }),
            true,
            `${descriptor.id} has no updater registered`,
        );
    }
});

test('every collection registers a restore', () => {
    assert.deepEqual(collectionsMissingRestore(), []);
});

