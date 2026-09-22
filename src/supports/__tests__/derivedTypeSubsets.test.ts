import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUTO_PLACED_BY_TYPE,
    AUTO_PLACED_TYPE_IDS,
    JOINT_REMOVAL_BY_TYPE,
    KICKSTAND_HOST_BY_TYPE,
    KICKSTAND_HOST_TYPES,
    SUPPORT_TYPES,
    type AutoPlacedTypeId,
    type JointRemovalTypeId,
    type KickstandHostTypeId,
} from '../supportTypeRegistry';

/**
 * The hand-written unions whose members ARE support type ids.
 *
 * Each is a literal map because the narrowed union has to survive to the type
 * level; every map is held to its descriptor flag here, so a rename that updates
 * one and not the other fails rather than silently dropping a type from the set.
 */

const idsFlagged = (read: (descriptor: (typeof SUPPORT_TYPES)[number]) => boolean) =>
    SUPPORT_TYPES.filter(read).map((descriptor) => descriptor.id).sort();

const idsSet = (map: Record<string, boolean>) =>
    Object.entries(map).filter(([, on]) => on).map(([id]) => id).sort();

test('the kickstand host set is exactly the types declaring hostsKickstand', () => {
    const declared = idsFlagged((descriptor) => descriptor.hostsKickstand);
    assert.deepEqual([...KICKSTAND_HOST_TYPES].sort(), declared);
    assert.deepEqual(idsSet(KICKSTAND_HOST_BY_TYPE), declared);
});

test('the auto-placed set is exactly the types declaring isAutoPlaced', () => {
    const declared = idsFlagged((descriptor) => descriptor.isAutoPlaced);
    assert.deepEqual([...AUTO_PLACED_TYPE_IDS].sort(), declared);
    assert.deepEqual(idsSet(AUTO_PLACED_BY_TYPE), declared);
});

test('the joint-removal set is exactly the shafted types resolving an endpoint elsewhere', () => {
    assert.deepEqual(
        idsSet(JOINT_REMOVAL_BY_TYPE),
        idsFlagged((descriptor) => descriptor.hasSegments && !descriptor.segmentsCarryBothJoints),
    );
});

/**
 * The negative half. A member is not a member by accident: these fail as an
 * unused `@ts-expect-error` if a union widens to every type, and as a type error
 * if a rename drops the member it names.
 */
test('a type outside a declared subset is not assignable to it', () => {
    // @ts-expect-error — leaf declares hostsKickstand: false
    const notAHost: KickstandHostTypeId = 'leaf';
    // @ts-expect-error — twig carries both its own joints, so it removes none alone
    const notJointRemovable: JointRemovalTypeId = 'twig';
    // @ts-expect-error — brace is placed by hand, never by the auto-support pass
    const notAutoPlaced: AutoPlacedTypeId = 'brace';
    assert.equal(notAHost, 'leaf');
    assert.equal(notJointRemovable, 'twig');
    assert.equal(notAutoPlaced, 'brace');
});
