import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import {
    collectionsMissingRestore,
    promoteAwayHost,
    SUPPORT_TYPES,
    placementOf,
    typesMissingHostPromotion,
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

/**
 * The auto-placement overrides the registry is asked for. `state.ts` throws when
 * these are empty; this pins that throw to a named test.
 */
test('every type declaring replacedByHigherContact registers a promotion', () => {
    assert.deepEqual(typesMissingHostPromotion(), []);
});

test('a promotion that was never registered reports "could not", not a silent success', () => {
    // Branch declares the flag false, so nothing registers for it.
    const result = promoteAwayHost('branch', {
        draft: {} as never,
        hostId: 'nope',
        nodeKey: '0,0',
        recordHistory: false,
        placed: placementOf('branch', { id: 'b' } as never),
        promotedMember: placementOf('branch', { id: 'b' } as never, { parentKnotId: { id: 'k' } as never }),
    });
    assert.equal(result, null, 'an unregistered promotion must not claim success');
});

test('the registered trunk promotion fails rather than throwing on an unknown host', () => {
    const result = promoteAwayHost('trunk', {
        draft: { roots: {}, trunks: {}, branches: {}, knots: {} } as never,
        hostId: 'does-not-exist',
        nodeKey: '0,0',
        recordHistory: false,
        placed: placementOf('trunk', { id: 't' } as never, { rootId: { id: 'r' } as never }),
        promotedMember: placementOf('branch', { id: 'b' } as never, { parentKnotId: { id: 'k' } as never }),
    });
    assert.equal(result, null, 'a missing host is a failed promotion, not a crash');
});

