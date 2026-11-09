import assert from 'node:assert/strict';
import test from 'node:test';

import '../state';
import { getSnapshot, resetStore } from '../state';
import { getSupportTypeDescriptor, knotHostId, SUPPORT_TYPES, updateSupportEntity } from '../supportTypeRegistry';
import { supportSettleFor, typesWithSettleHook } from '../settle/seam';
import { addKnot, addRoot, addSupportEntity } from '../state';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../types';

/**
 * The settle seam, and the write-path bug routing leaf through it exposed.
 *
 * `applySupportEntityUpdate` wrote the entity's own collection and then the
 * generic `knots` / `leaves` defaults over the top. For a type whose collection
 * IS `leaves` -- leaf -- the later `leaves:` won, so
 * `updateSupportEntity('leaf', entity)` kept the PRE-write leaves and returned
 * true. Nothing caught it because leaf had a bespoke updater that never took this
 * path; moving that body behind the seam is what reached it.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'settle-root';
const KNOT_ID = 'settle-knot';

const cone = (pos: Vec3): ContactCone => ({
    id: 'settle-cone',
    pos,
    normal: vec(0, 0, -1),
    surfaceNormal: vec(0, 0, -1),
    profile: { type: 'cone', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
} as unknown as ContactCone);

function seedLeaf(): void {
    resetStore();
    addRoot({
        id: ROOT_ID,
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 10), rotation: vec(0, 0, 0), scale: vec(1, 1, 1) },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    // The knot has to be a real cone host for the leaf's cascade to reach it:
    // the pass reads the pseudo-shaft id, which is the prefix the leaf type
    // declares, so it is built rather than spelled.
    addKnot({
        id: KNOT_ID,
        parentShaftId: knotHostId('leaf', 'leaf-1'),
        pos: vec(0, 0, 20),
        diameter: 1.4,
    } as never);
    addSupportEntity('leaf', {
        id: 'leaf-1',
        modelId: 'model-a',
        parentKnotId: KNOT_ID,
        contactCone: cone(vec(1, 2, 3)),
    } as never);
}

test('a write to the leaves collection is not overwritten by the generic leaf default', () => {
    seedLeaf();
    const stored = getSnapshot().leaves['leaf-1'];
    const moved = { ...stored, contactCone: { ...stored.contactCone, pos: vec(9, 9, 9) } };

    assert.equal(updateSupportEntity('leaf', moved), true, 'the write reports success');
    assert.equal(
        getSnapshot().leaves['leaf-1'].contactCone.pos.x,
        9,
        'and the entity it was handed is the one stored -- not the pre-write leaves',
    );
});

test('every type writes to its own collection, whichever collection that is', () => {
    // The bug was collection-specific: it only fired when a type's own collection
    // shared a name with one of the generic settle defaults. That is `leaves`
    // today, and this holds the property rather than the name.
    seedLeaf();
    const descriptor = getSupportTypeDescriptor('leaf');
    assert.equal(descriptor.location.key, 'leaves', 'fixture: leaf writes to `leaves`');

    const before = getSnapshot();
    const storedBefore = before.leaves['leaf-1'];
    updateSupportEntity('leaf', { ...storedBefore, contactCone: cone(vec(4, 4, 4)) } as never);
    const after = getSnapshot();
    assert.notEqual(after.leaves['leaf-1'], storedBefore, 'the collection holds a new entity object');
});

test('the settle hooks that exist are the two types that need a different order', () => {
    assert.deepEqual(
        [...typesWithSettleHook()].sort(),
        ['brace', 'leaf'],
        'a hook is for the types whose cascade differs from the generic one',
    );
});

test('a type with no settle hook is written by the generic path alone', () => {
    // The complement of the hooked types, walked off the registry rather than
    // listed: the two types that declare a hook are pinned above, so every OTHER
    // declared type has to settle to nothing. A type added later is covered by
    // being declared, not by being remembered here.
    const hooked = new Set(typesWithSettleHook());
    for (const descriptor of SUPPORT_TYPES) {
        if (hooked.has(descriptor.id)) continue;
        assert.equal(supportSettleFor(descriptor.id), null, `${descriptor.id} should settle to nothing`);
    }
});

test('a leaf write settles the knots rather than leaving them untouched', () => {
    // The leaf's cascade is the reason it has a hook at all: its contact cone
    // sits on the model while its knot rides a host shaft, so writing a leaf
    // moves the knot. A hook that returned nothing would pass every assertion
    // above while silently dropping the cascade.
    seedLeaf();
    const stored = getSnapshot().leaves['leaf-1'];
    const coneMoved = { ...stored, contactCone: { ...stored.contactCone, pos: vec(30, 30, 30) } };

    const knotsBefore = getSnapshot().knots;
    updateSupportEntity('leaf', coneMoved);
    const knotsAfter = getSnapshot().knots;

    assert.notEqual(knotsAfter, knotsBefore, 'the knot collection was rewritten by the settle pass');
});
