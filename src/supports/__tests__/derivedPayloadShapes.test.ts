import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORT_REMOVAL_SHAPES, SUPPORT_TYPES } from '../supportTypeRegistry';
import type {
    SupportAnchorPayload,
    SupportAnchorRemovePayload,
    SupportStickPayload,
    SupportStickRemovePayload,
    SupportTwigPayload,
    SupportTwigRemovePayload,
} from '../history/actionTypes';
import type { Anchor, Knot, Leaf, Stick, Twig } from '../types';

/**
 * History payload shapes, derived rather than written out.
 *
 * Six interfaces repeated what `SUPPORT_REMOVAL_SHAPES` already declares --
 * twig, stick and anchor each spelled `{ self }` for their add payload and
 * `{ self, knots, leaves }` for their removal. The compile-time assertions
 * below are the real test: they fail to build if a derived type stops matching
 * the interface it replaced.
 */

// The shapes the hand-written interfaces had. A derived type that drifts from
// these is a compile error, not a silent change.
const _twigAdd: SupportTwigPayload = { twig: {} as Twig };
const _stickAdd: SupportStickPayload = { stick: {} as Stick };
const _anchorAdd: SupportAnchorPayload = { anchor: {} as Anchor };

const _twigRemove: SupportTwigRemovePayload = {
    twig: {} as Twig, knots: [] as Knot[], leaves: [] as Leaf[],
};
const _stickRemove: SupportStickRemovePayload = {
    stick: {} as Stick, knots: [] as Knot[], leaves: [] as Leaf[],
};
const _anchorRemove: SupportAnchorRemovePayload = {
    anchor: {} as Anchor, knots: [] as Knot[], leaves: [] as Leaf[],
};

void _twigAdd; void _stickAdd; void _anchorAdd;
void _twigRemove; void _stickRemove; void _anchorRemove;

test('the derived payloads carry the fields their shape declares', () => {
    // The runtime half: the declaration those types read from still names the
    // fields the assertions above rely on.
    for (const typeId of ['twig', 'stick', 'anchor'] as const) {
        const shape = SUPPORT_REMOVAL_SHAPES[typeId];
        assert.equal(shape.self, typeId, `${typeId}: payload keyed on its own name`);
        assert.deepEqual(
            Object.entries(shape.cascade).sort(),
            [['knots', 'knots'], ['leaves', 'leaves']],
            `${typeId}: cascades knots and leaves`,
        );
    }
});

test('every type declares a removal shape keyed on a real field name', () => {
    // A shape whose `self` was empty would derive a payload with no entity
    // field at all, which no handler could seed from.
    for (const descriptor of SUPPORT_TYPES) {
        const shape = SUPPORT_REMOVAL_SHAPES[descriptor.id];
        assert.ok(shape, `${descriptor.id} declares a shape`);
        assert.ok(shape.self.length > 0, `${descriptor.id} names its entity field`);
    }
});
