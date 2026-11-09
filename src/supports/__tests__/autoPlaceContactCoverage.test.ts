import assert from 'node:assert/strict';
import test from 'node:test';

import { collectContactPositions } from '../autoSupport/autoPlace';
import { SUPPORT_TYPES, contactEndpointsFor } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * Where the model is already being held.
 *
 * Auto-placement asks this twice -- to skip a candidate that is already
 * supported, and to score how much of an island is covered. Both collected
 * contacts from trunk, branch, leaf and anchor by hand, so a point held by a
 * twig or a stick read as unsupported: auto-support would stack another
 * support on top of one that was already there.
 */

const seg = (id: string) => ({
    id, diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

const contactAt = (id: string, x: number) => ({
    id,
    pos: { x, y: 0, z: 4 },
    normal: { x: 0, y: 0, z: 1 },
    surfaceNormal: { x: 0, y: 0, z: 1 },
    coneAxis: { x: 0, y: 0, z: 1 },
    contactDiameterMm: 0.4,
    profile: { type: 'cone', lengthMm: 1, contactDiameterMm: 0.4, bodyDiameterMm: 0.8 },
});

function emptyState(): SupportState {
    const state = {
        roots: {}, knots: {},
        selectedId: null, hoveredId: null,
        selectedCategory: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;
    for (const descriptor of SUPPORT_TYPES) {
        (state as unknown as Record<string, unknown>)[descriptor.location.key] = {};
    }
    return state;
}

const put = (state: SupportState, key: string, entity: { id: string }) => {
    (state as unknown as Record<string, Record<string, unknown>>)[key][entity.id] = entity;
};

/** One entity of `typeId`, with a contact at a distinct x per declared field. */
function withContacts(state: SupportState, typeId: string, baseX: number) {
    const descriptor = SUPPORT_TYPES.find((d) => d.id === typeId)!;
    const entity: Record<string, unknown> = {
        id: `${typeId}-a`, modelId: 'model-a', typeId,
        segments: descriptor.hasSegments ? [seg(`${typeId}-s`)] : undefined,
    };

    descriptor.contactFields.forEach((field, i) => {
        entity[field] = contactAt(`${typeId}-${field}`, baseX + i);
    });

    put(state, descriptor.location.key, entity as { id: string });
    return descriptor.contactFields.length;
}

test('every declared contact is reported, for every type that has one', () => {
    const state = emptyState();
    let expected = 0;
    let x = 0;

    for (const descriptor of SUPPORT_TYPES) {
        expected += withContacts(state, descriptor.id, x);
        x += 10;
    }

    assert.equal(collectContactPositions(state).length, expected);
});

