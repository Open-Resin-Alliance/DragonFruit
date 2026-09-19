import assert from 'node:assert/strict';
import test from 'node:test';

import {
    removalShapeFor,
    SUPPORT_REMOVAL_SHAPES,
    SUPPORT_TYPES,
    type SupportEntityFor,
    type SupportEntityPayload,
    type SupportRemovalResult,
    type SupportTypeId,
} from '../supportTypeRegistry';

/**
 * History payload shapes, derived from the registry rather than written out:
 * `{ self }` for an add, `{ self, ...cascade }` for a removal, both from the
 * shape each type declares in `SUPPORT_REMOVAL_SHAPES`.
 *
 * These assertions fail to build if a derived payload stops matching its
 * declared shape. Nothing here names a type.
 */

/**
 * An add payload for one type: the field the entity arrives under, carrying that
 * type's entity from the registry's entity mapping.
 */
type ExpectedEntityPayload<T extends SupportTypeId> = {
    [S in (typeof SUPPORT_REMOVAL_SHAPES)[T]['self']]: SupportEntityFor<T>;
};

/**
 * The fields a removal of `T` reports: its own entity field, plus one name per
 * declared cascade entry. An entry declared as an array names several slots
 * rather than one.
 */
type ExpectedRemovalFields<T extends SupportTypeId> =
    | (typeof SUPPORT_REMOVAL_SHAPES)[T]['self']
    | {
        [K in keyof (typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade']]:
            (typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade'][K] extends readonly string[]
                ? (typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade'][K][number]
                : (typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade'][K]
    }[keyof (typeof SUPPORT_REMOVAL_SHAPES)[T]['cascade']];

/** Whether two types are the same, in both directions. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The declared types whose derived payloads no longer match the shape they
 * declare; empty when every one agrees. Mapped so each type is checked alone.
 */
type PayloadShapeDrift = {
    [T in SupportTypeId]:
        Same<SupportEntityPayload<T>, ExpectedEntityPayload<T>> extends true
            ? SupportRemovalResult<T> extends ExpectedEntityPayload<T>
                ? Same<keyof SupportRemovalResult<T>, ExpectedRemovalFields<T>> extends true ? never : T
                : T
            : T;
}[SupportTypeId];

/** The compile-time net: `never` when nothing drifts, the failing ids otherwise. */
const _payloadShapeDrift: Record<PayloadShapeDrift, true> = true;
void _payloadShapeDrift;

test('the derived payloads carry the fields their shape declares', () => {
    for (const descriptor of SUPPORT_TYPES) {
        const shape = removalShapeFor(descriptor.id);
        assert.equal(shape.self, descriptor.id, `${descriptor.id}: payload keyed on its own name`);

        // Every collection a removal drains, and the field each reports under.
        const drained = Object.keys(shape.cascade);
        assert.ok(drained.length > 0, `${descriptor.id} declares a cascade`);
        assert.ok(drained.includes('knots'), `${descriptor.id} cascades its knots`);
    }
});

test('every type declares a removal shape keyed on a real field name', () => {
    // A shape whose `self` was empty would derive a payload with no entity
    // field at all, which no handler could seed from.
    for (const descriptor of SUPPORT_TYPES) {
        const shape = removalShapeFor(descriptor.id);
        assert.ok(shape, `${descriptor.id} declares a shape`);
        assert.ok(shape.self.length > 0, `${descriptor.id} names its entity field`);
    }
});
