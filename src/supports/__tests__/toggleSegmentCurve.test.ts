import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addKnot,
    addRoot,
    addSupportEntity,
    getSnapshot,
    resetStore,
    toggleSegmentCurve,
} from '../state';
import { resolveSegmentEndpoints, type EndpointHosts, type ShaftEntity } from '../SupportPrimitives/Knot/segmentEndpoints';
import { hostKnotFieldsFor, SUPPORT_TYPES, type SupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { BezierSegment, Joint, Segment, StraightSegment, Vec3 } from '../types';

/**
 * `toggleSegmentCurve` converts a shaft segment between straight and curved.
 *
 * These tests iterate `SUPPORT_TYPES` filtered by `hasSegments`, the same
 * declaration the code walks, so every shafted type is covered by being
 * declared. The failure to watch for is a walk that skips a type: that type's
 * segment stays straight, silently.
 *
 * The handles come from the declared endpoints, so a shaft ending at a contact
 * reaches the socket rather than the raw contact point.
 */

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const ROOT_ID = 'toggle-root';
const KNOT_ID = 'toggle-knot';

const joint = (id: string, pos: Vec3): Joint => ({ id, pos, diameter: 1.2 });

const cone = (id: string, pos: Vec3): ContactCone => ({
    id,
    pos,
    normal: vec(0, 0, -1),
    surfaceNormal: vec(0, 0, -1),
    profile: { type: 'cone', lengthMm: 2, contactDiameterMm: 0.3, bodyDiameterMm: 0.8 },
} as unknown as ContactCone);

/** A segment whose far end is a contact rather than another joint. */
const segmentEndingAtContact = (id: string): StraightSegment => ({
    id,
    diameter: 1.2,
    type: 'straight',
    bottomJoint: joint(`${id}-bottom`, vec(1, 2, 3)),
});

/** One entity per shafted type, carrying the hosts its descriptor declares. */
function entityFor(typeId: SupportTypeId): Record<string, unknown> {
    const segment = segmentEndingAtContact(`seg-${typeId}`);
    const shared = { id: `entity-${typeId}`, modelId: 'model-a', segments: [segment] };

    switch (typeId) {
        case 'trunk':
            return { ...shared, rootId: ROOT_ID, contactCone: cone('cone-trunk', vec(5, 6, 7)) };
        case 'branch':
            return { ...shared, parentKnotId: KNOT_ID, contactCone: cone('cone-branch', vec(5, 6, 7)) };
        case 'twig':
            return {
                ...shared,
                contactDiskA: { ...cone('disk-a', vec(5, 6, 7)), profile: { type: 'disk', lengthMm: 1, contactDiameterMm: 0.4, bodyDiameterMm: 0.9 } },
                contactDiskB: { ...cone('disk-b', vec(9, 9, 9)), profile: { type: 'disk', lengthMm: 1, contactDiameterMm: 0.4, bodyDiameterMm: 0.9 } },
            };
        case 'stick':
            return {
                ...shared,
                contactConeA: cone('cone-a', vec(5, 6, 7)),
                contactConeB: cone('cone-b', vec(9, 9, 9)),
            };
        case 'stump':
            return {
                ...shared,
                rootPos: vec(0, 0, 0),
                rootBaseDiameter: 2,
                rootTopDiameter: 1.5,
                rootHeight: 2,
                joint: joint('stump-joint', vec(1, 2, 3)),
                contactCone: cone('cone-stump', vec(5, 6, 7)),
            };
        case 'kickstand':
            return { ...shared, rootId: ROOT_ID, hostKnotId: KNOT_ID };
        default:
            return shared;
    }
}

const hostsFor = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>): EndpointHosts => {
    const store = getSnapshot();
    let hostKnot: EndpointHosts['hostKnot'];
    for (const field of hostKnotFieldsFor(descriptor.id)) {
        const knot = store.knots[entity[field] as string];
        if (knot) {
            hostKnot = knot;
            break;
        }
    }
    return {
        root: descriptor.ownsRoot ? store.roots[entity.rootId as string] : undefined,
        hostKnot,
    };
};

/** A store holding one entity of `typeId`, ready to toggle. */
function seed(typeId: SupportTypeId): string {
    resetStore();
    addRoot({
        id: ROOT_ID,
        modelId: 'model-a',
        transform: { pos: vec(0, 0, 10), rotation: vec(0, 0, 0), scale: vec(1, 1, 1) },
        diameter: 3,
        diskHeight: 1,
        coneHeight: 2,
    } as never);
    addKnot({ id: KNOT_ID, pos: vec(0, 0, 20), diameter: 1.4 } as never);

    const entity = entityFor(typeId);
    addSupportEntity(typeId, entity as never);
    return (entity.segments as StraightSegment[])[0].id;
}

const storedEntity = (typeId: SupportTypeId): Record<string, unknown> => {
    const descriptor = SUPPORT_TYPES.find((candidate) => candidate.id === typeId)!;
    return getSnapshot()[descriptor.location.key][`entity-${typeId}`] as unknown as Record<string, unknown>;
};

const storedSegment = (typeId: SupportTypeId): Segment =>
    (storedEntity(typeId).segments as Segment[])[0];

/** The stored entity as the shared resolver sees it, with its index-0 segment. */
const shaftAt = (typeId: SupportTypeId): { shaft: ShaftEntity; segment: Segment } => {
    const entity = storedEntity(typeId);
    const segment = (entity.segments as Segment[])[0];
    return { shaft: entity as unknown as ShaftEntity, segment };
};

const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(v.x, v.y, v.z);
    return length === 0 ? vec(0, 0, 0) : vec(v.x / length, v.y / length, v.z / length);
};

/** The object's own fields that carry a value; `{ a: undefined }` behaves as `{}`. */
const withoutUndefined = (value: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));

const closeTo = (a: Vec3, b: Vec3, epsilon = 1e-6): boolean =>
    Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon && Math.abs(a.z - b.z) < epsilon;

const shaftedTypes = SUPPORT_TYPES.filter((descriptor) => descriptor.hasSegments);

test('every type that declares segments owns a toggleable one', () => {
    for (const descriptor of shaftedTypes) {
        const segmentId = seed(descriptor.id);
        toggleSegmentCurve(segmentId);

        assert.equal(
            storedSegment(descriptor.id).type,
            'bezier',
            `${descriptor.id}: the segment did not curve, so nothing found its owner`,
        );
    }
});

test('a segment converts and converts back, keeping its joints and diameter', () => {
    for (const descriptor of shaftedTypes) {
        const segmentId = seed(descriptor.id);
        const original = { ...(entityFor(descriptor.id).segments as StraightSegment[])[0] };

        toggleSegmentCurve(segmentId);
        assert.equal(storedSegment(descriptor.id).type, 'bezier', `${descriptor.id}: not curved`);

        // Converting back writes the joints it was handed, so an absent joint
        // comes back as an explicit `undefined`. Compare the fields that carry a
        // value.
        toggleSegmentCurve(segmentId);
        assert.deepEqual(
            withoutUndefined(storedSegment(descriptor.id)),
            withoutUndefined(original),
            `${descriptor.id}: converting back did not restore the segment`,
        );
    }
});

test('the handles follow the shaft, not the contact point it ends against', () => {
    for (const descriptor of shaftedTypes) {
        const segmentId = seed(descriptor.id);

        const { shaft, segment } = shaftAt(descriptor.id);
        const expected = resolveSegmentEndpoints(shaft, segment, 0, hostsFor(descriptor, storedEntity(descriptor.id)));
        assert.ok(expected, `${descriptor.id}: no resolved span to compare the handles against`);

        toggleSegmentCurve(segmentId);
        const curve = storedSegment(descriptor.id) as BezierSegment;

        // The handles are the segment's direction, so they must point along the
        // span the rest of the app draws the shaft across.
        const span = normalize(vec(
            expected.end.x - expected.start.x,
            expected.end.y - expected.start.y,
            expected.end.z - expected.start.z,
        ));
        assert.ok(
            closeTo(curve.startTangent, span, 1e-6) && closeTo(curve.endTangent, span, 1e-6),
            `${descriptor.id}: handles do not follow the resolved span`,
        );

        // And where that span ends is NOT the raw contact point, for the types
        // whose contact sits off the shaft's end.
        const contact = storedEntity(descriptor.id).contactCone as ContactCone | undefined;
        if (contact) {
            const toContact = normalize(vec(
                contact.pos.x - expected.start.x,
                contact.pos.y - expected.start.y,
                contact.pos.z - expected.start.z,
            ));
            if (!closeTo(toContact, span, 1e-3)) {
                assert.ok(
                    !closeTo(curve.endTangent, toContact, 1e-6),
                    `${descriptor.id}: handles aim at the contact point instead of the socket`,
                );
            }
        }
    }
});

test('a shaft ending at a contact reaches the socket, past the contact point', () => {
    // A trunk with no top joint: the span comes from the declared endpoints. The
    // contact sits on the surface and the socket is offset from it along the
    // normal, so the handles must reach the socket.
    const descriptor = SUPPORT_TYPES.find((candidate) => candidate.id === 'trunk')!;
    const segmentId = seed('trunk');

    const { shaft, segment } = shaftAt('trunk');
    const expected = resolveSegmentEndpoints(shaft, segment, 0, hostsFor(descriptor, storedEntity('trunk')))!;
    const contactPoint = (entityFor('trunk').contactCone as ContactCone).pos;

    assert.ok(
        !closeTo(expected.end, contactPoint, 1e-3),
        'fixture is meaningless: the socket coincides with the contact point here',
    );

    toggleSegmentCurve(segmentId);
    const curve = storedSegment('trunk') as BezierSegment;
    const span = normalize(vec(
        expected.end.x - expected.start.x,
        expected.end.y - expected.start.y,
        expected.end.z - expected.start.z,
    ));
    const toContact = normalize(vec(
        contactPoint.x - expected.start.x,
        contactPoint.y - expected.start.y,
        contactPoint.z - expected.start.z,
    ));

    assert.ok(closeTo(curve.startTangent, span, 1e-6), 'trunk: handles do not reach the socket');
    assert.ok(!closeTo(curve.startTangent, toContact, 1e-6), 'trunk: handles still aim at the contact point');
});
