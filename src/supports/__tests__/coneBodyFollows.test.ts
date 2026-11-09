import assert from 'node:assert/strict';
import test from 'node:test';

import { getSupportTypeDescriptor, SUPPORT_TYPES } from '../supportTypeRegistry';
import { syncContactConeDiameters } from '../autoSupport/autoPlace';
import { addKnot, addSupportEntity, getSnapshot, resetStore } from '../state';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { SupportTypeId } from '../supportTypeRegistry';

/**
 * Which shaft a contact-cone BODY follows, declared per type.
 *
 * `syncContactConeDiameters` builds its segment-diameter map from each type's
 * declared `coneBodyFollows`. A type that follows nothing declares nothing.
 *
 * The declarations below are the whole point of the flag: they pin which types
 * participate, so a type gaining or losing one is a visible change rather than a
 * quietly different set of cones.
 */

const cone = (bodyDiameterMm: number): ContactCone => ({
    id: 'cone',
    pos: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    surfaceNormal: { x: 0, y: 0, z: 1 },
    profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm, lengthMm: 2, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
} as unknown as ContactCone);

const segment = (id: string, diameter: number) => ({
    id,
    type: 'straight' as const,
    diameter,
    bottomJoint: { id: `${id}-b`, pos: { x: 0, y: 0, z: 0 }, diameter },
    topJoint: { id: `${id}-t`, pos: { x: 0, y: 0, z: 5 }, diameter },
});

test('the types whose cone body follows a shaft are exactly three', () => {
    const declaring = SUPPORT_TYPES
        .filter((descriptor) => (descriptor as unknown as { coneBodyFollows?: string }).coneBodyFollows !== undefined)
        .map((descriptor) => descriptor.id)
        .sort();

    assert.deepEqual(declaring, ['branch', 'leaf', 'trunk']);
});

test('a type whose cone body is deliberately left alone declares nothing', () => {
    // Stick and stump both have cone upper endpoints and segments, and both are
    // deliberately absent: a stick's cone is placed against a socket and a
    // stump's frustum is not a shaft. Adding either later is one line.
    for (const typeId of ['stick', 'stump'] as SupportTypeId[]) {
        const descriptor = getSupportTypeDescriptor(typeId) as unknown as {
            coneBodyFollows?: string;
            upper: { kind: string };
            hasSegments: boolean;
        };
        assert.equal(descriptor.upper.kind, 'cone', `fixture: ${typeId} carries a cone`);
        assert.equal(descriptor.hasSegments, true, `fixture: ${typeId} has segments`);
        assert.equal(
            descriptor.coneBodyFollows,
            undefined,
            `${typeId} must not follow its shaft`,
        );
    }
});

test('a declared source survives a round trip through the real sync', () => {
    // Declaring the flag is not enough on its own: the pass has to honour it. A
    // type declaring a source contributes its segment diameters, and any type
    // with one gets its cone body moved to the shaft it follows.
    for (const typeId of ['trunk', 'branch'] as SupportTypeId[]) {
        const descriptor = getSupportTypeDescriptor(typeId) as unknown as {
            coneBodyFollows?: string;
            location: { key: string };
            upper: { field?: string };
        };
        // Through the real writer, so the entity is in the store the pass reads.
        resetStore();
        addSupportEntity(typeId, {
            id: 'e1',
            modelId: 'm',
            segments: [segment('seg-e1', 1.75)],
            [descriptor.upper.field as string]: cone(0.5),
        } as never);

        const synced = syncContactConeDiameters(getSnapshot()) as unknown as Record<
            string, Record<string, Record<string, { profile?: { bodyDiameterMm?: number } }>>
        >;
        const syncedCone = (synced[descriptor.location.key]['e1'][descriptor.upper.field as string]);
        assert.equal(
            syncedCone.profile?.bodyDiameterMm,
            1.75,
            `${typeId}: the declared source did not reach the cone body`,
        );
    }
});

test('a cone HOSTED on a type that declares nothing stays where it was placed', () => {
    // Only types declaring a source put their segments in the diameter map, so
    // a leaf hosted on a stick's segment resolves no shaft.
    const stickSegmentId = 'stick-seg-1';
    resetStore();
    addSupportEntity('stick', {
        id: 'stick-1',
        modelId: 'm',
        segments: [segment(stickSegmentId, 1.75)],
        contactConeA: cone(0.4),
        contactConeB: cone(0.4),
    } as never);
    addKnot({ id: 'k-stick', parentShaftId: stickSegmentId, pos: { x: 0, y: 0, z: 5 }, diameter: 1.2 } as never);
    addSupportEntity('leaf', {
        id: 'leaf-1',
        modelId: 'm',
        parentKnotId: 'k-stick',
        contactCone: cone(0.5),
    } as never);

    const synced = syncContactConeDiameters(getSnapshot()) as unknown as Record<
        string, Record<string, Record<string, { profile?: { bodyDiameterMm?: number } }>>
    >;
    assert.equal(
        synced.leaves['leaf-1'].contactCone.profile?.bodyDiameterMm,
        0.5,
        'a cone hosted on a stick segment must keep its placed body',
    );
});

test('a cone HOSTED on a type that declares a source does follow that shaft', () => {
    // The other side of the same rule, so the test above cannot pass merely
    // because the hosted path is broken: on a trunk the same leaf DOES follow.
    const trunkSegmentId = 'trunk-seg-1';
    resetStore();
    addSupportEntity('trunk', {
        id: 'trunk-1',
        modelId: 'm',
        rootId: 'r1',
        segments: [segment(trunkSegmentId, 1.75)],
        contactCone: cone(0.4),
    } as never);
    addKnot({ id: 'k-trunk', parentShaftId: trunkSegmentId, pos: { x: 0, y: 0, z: 5 }, diameter: 1.2 } as never);
    addSupportEntity('leaf', {
        id: 'leaf-1',
        modelId: 'm',
        parentKnotId: 'k-trunk',
        contactCone: cone(0.5),
    } as never);

    const synced = syncContactConeDiameters(getSnapshot()) as unknown as Record<
        string, Record<string, Record<string, { profile?: { bodyDiameterMm?: number } }>>
    >;
    assert.equal(
        synced.leaves['leaf-1'].contactCone.profile?.bodyDiameterMm,
        1.75,
        'a cone hosted on a trunk segment follows that shaft',
    );
});

test("a type declaring nothing keeps its own cone body", () => {
    // The other role of absence: no arm syncs it, so its cone body is as placed.
    for (const typeId of ['stick', 'stump'] as SupportTypeId[]) {
        const descriptor = getSupportTypeDescriptor(typeId) as unknown as {
            location: { key: string };
            upper: { field?: string };
        };
        resetStore();
        addSupportEntity(typeId, {
            id: 'e1',
            modelId: 'm',
            segments: [segment('seg-e1', 1.75)],
            [descriptor.upper.field as string]: cone(0.5),
        } as never);

        const synced = syncContactConeDiameters(getSnapshot()) as unknown as Record<
            string, Record<string, Record<string, { profile?: { bodyDiameterMm?: number } }>>
        >;
        const syncedCone = (synced[descriptor.location.key]?.['e1']?.[descriptor.upper.field as string]);
        assert.equal(
            syncedCone?.profile?.bodyDiameterMm ?? 0.5,
            0.5,
            `${typeId}: its cone body must not move`,
        );
    }
});
