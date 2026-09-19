import assert from 'node:assert/strict';
import test from 'node:test';

import { interiorSupportIds } from '../SupportProxyMeshLayer';
import { contactEndpointsFor, SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * What the interior (cavity) view shows.
 *
 * A visual feature with no other coverage and invisible to every golden, so
 * these assertions are the only check on what the view hides.
 *
 * The predicates are injected -- the layer passes BVH-backed ones, these pass
 * `placementSurface`-driven ones -- so the classification is tested without
 * cavity geometry or a GPU.
 */

const MODEL = 'model-1';

const contact = (surface: 'interior' | 'exterior') => ({
    pos: { x: 0, y: 0, z: 1 },
    placementSurface: surface,
});

const isContactInterior = (c: unknown): boolean =>
    (c as { placementSurface?: string } | null)?.placementSurface === 'interior';

/** A segment carries the flag directly, so the sample loop needs no geometry. */
const isSegmentsInterior = (segs: readonly unknown[]): boolean =>
    (segs as Array<{ interior?: boolean }>).some((s) => s.interior === true);

/** One entity per declared type, its contact fields taken from the descriptor. */
function stateWithContacts(surface: 'interior' | 'exterior'): SupportState {
    const state: Record<string, Record<string, unknown>> = {};
    for (const descriptor of SUPPORT_TYPES) {
        const entity: Record<string, unknown> = { id: `${descriptor.id}-1`, typeId: descriptor.id, modelId: MODEL, segments: [] };
        for (const { field } of contactEndpointsFor(descriptor.id)) {
            entity[field] = contact(surface);
        }
        state[descriptor.location.key] = { [entity.id as string]: entity };
    }
    return state as unknown as SupportState;
}

/** The types that can contribute at all: contacts declared, not plate-rooted. */
const qualifying = SUPPORT_TYPES.filter(
    (d) => contactEndpointsFor(d.id).length > 0 && d.lower.kind !== 'plateRoot',
);

const key = (typeId: string) => `${typeId}:${typeId}-1`;

test('an interior contact puts its type in the set; an exterior one keeps it out', () => {
    assert.ok(qualifying.length >= 4, `precondition: several types qualify, got ${qualifying.length}`);

    const interior = interiorSupportIds(stateWithContacts('interior'), isContactInterior, isSegmentsInterior);
    const exterior = interiorSupportIds(stateWithContacts('exterior'), isContactInterior, isSegmentsInterior);

    for (const descriptor of qualifying) {
        assert.ok(
            interior.has(key(descriptor.id)),
            `${descriptor.id} declares contacts, so an interior one is in the set`,
        );
        assert.ok(
            !exterior.has(key(descriptor.id)),
            `${descriptor.id}: every contact exterior, so it is out of the set`,
        );
    }
});

test('a plate-rooted type never qualifies, however its contact is stamped', () => {
    // A support rooted in the build plate starts in open space, so its primitive
    // is never inside a cavity. `lower.kind` is the declaration that says so.
    const rooted = SUPPORT_TYPES.filter((d) => d.lower.kind === 'plateRoot');
    assert.ok(rooted.length > 0, 'precondition: something is plate-rooted');

    const ids = interiorSupportIds(stateWithContacts('interior'), isContactInterior, isSegmentsInterior);
    for (const descriptor of rooted) {
        assert.ok(!ids.has(key(descriptor.id)), `${descriptor.id} is plate-rooted and must stay out`);
    }
});

test('a type with no declared contacts never contributes', () => {
    const contactless = SUPPORT_TYPES.filter((d) => contactEndpointsFor(d.id).length === 0);
    assert.ok(contactless.length > 0, 'precondition: something declares no contacts');

    const ids = interiorSupportIds(stateWithContacts('interior'), isContactInterior, isSegmentsInterior);
    for (const descriptor of contactless) {
        assert.ok(!ids.has(key(descriptor.id)), `${descriptor.id} declares no contacts`);
    }
});

test('only a shaft rooted at a knot gets the segment test', () => {
    // A shaft whose lower end is a knot begins mid-air on another support, so it
    // can cut through a cavity on its way to the contact. One rooted in the plate
    // cannot, and one spanning two contacts is already tested at both ends.
    //
    // The predicate is `lower.kind === 'knot' && hasSegments`. This pins that
    // `hasSegments` alone is not it: that is true for twig, stick, stump and
    // kickstand too, which would admit four extra types.
    const state: Record<string, Record<string, unknown>> = {};
    for (const descriptor of SUPPORT_TYPES) {
        const entity: Record<string, unknown> = {
            id: `${descriptor.id}-1`,
            typeId: descriptor.id,
            modelId: MODEL,
            // Contact present but exterior, so only the segment path can admit it.
            segments: [{ id: 's', bottomJoint: { pos: { x: 0, y: 0, z: 0 } }, topJoint: { pos: { x: 0, y: 0, z: 1 } }, interior: true }],
        };
        for (const { field } of contactEndpointsFor(descriptor.id)) {
            entity[field] = contact('exterior');
        }
        state[descriptor.location.key] = { [entity.id as string]: entity };
    }

    const ids = interiorSupportIds(state as unknown as SupportState, isContactInterior, isSegmentsInterior);
    const admitted = SUPPORT_TYPES
        .filter((d) => d.lower.kind === 'knot' && d.hasSegments)
        .map((d) => d.id);
    assert.ok(admitted.length > 0, 'precondition: a knot-rooted shafted type exists');

    for (const descriptor of SUPPORT_TYPES) {
        const shouldBeAdmitted = admitted.includes(descriptor.id);
        assert.equal(
            ids.has(key(descriptor.id)),
            shouldBeAdmitted,
            `${descriptor.id}: segment test applies only to ${admitted.join(', ')}`,
        );
    }
});

test('the key carries the entity\'s own type, so two types cannot collide on an id', () => {
    // Both a branch and a leaf are given the SAME id; the keys must differ, or
    // one type's interior geometry would be shown for the other.
    const shared = 'shared-id';
    const state = {
        branches: { [shared]: { id: shared, typeId: 'branch', modelId: MODEL, contactCone: contact('interior') } },
        leaves: { [shared]: { id: shared, typeId: 'leaf', modelId: MODEL, contactCone: contact('interior') } },
    } as unknown as SupportState;

    const ids = interiorSupportIds(state, isContactInterior, isSegmentsInterior);
    assert.ok(ids.has(`branch:${shared}`), 'the branch key');
    assert.ok(ids.has(`leaf:${shared}`), 'the leaf key');
    assert.equal(ids.size, 2, 'two keys, not one');
});
