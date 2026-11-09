import assert from 'node:assert/strict';
import test from 'node:test';

import { addKnot, addRoot, addSupportEntity, getSnapshot, getSupportTypeOf, getSupports, setSnapshot, loadFromImportFormat, removeSupportEntity, resetStore } from '../state';
import { SUPPORT_TYPES, contactEndpointsFor, defaultPlacementToolTypeId, getSupportTypeDescriptor, removalShapeFor, restoreToCollection, updateSupportEntity, type SupportEdge, type SupportTypeDescriptor } from '../supportTypeRegistry';
import { buildSupportExportFromStores } from '@/features/scene/voxl/codec';

/**
 * Every entity knows its own type, and agrees with the collection holding it.
 *
 * Collection membership is the type discriminator today -- roughly 55 lookups
 * ask `if (state.trunks[id])` to learn what a thing is. `typeId` is the
 * replacement, and while both exist they must not disagree: this file is what
 * holds them together.
 *
 * The field is optional on the interface only so files written before it
 * existed still typecheck. Anything the store hands out carries it.
 *
 * Every fixture below is built from what a type declares -- `hasSegments`, its
 * edges, its contact fields. Nothing here is keyed by a type's spelling.
 */

/** The straight segment `seg` builds, and so the shaft the knot scaffold rides. */
const SEGMENT_TOP_Z = 4;

/** How far apart the scene's roots sit, so no two land on the same spot. */
const ROOT_SPACING_MM = 3;

/** The diameter written into a field a type declares by path. */
const DECLARED_DIAMETER_MM = 1;

/** The lowest `t` at which a type hosted on another shaft's segment may sit. */
const HOST_MIN_T = 0.2;

const seg = (id: string) => ({
    id, diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: SEGMENT_TOP_Z }, diameter: 1 },
});

const root = (id: string, x: number) => ({
    id, modelId: 'model-a',
    transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
});

const cone = () => ({
    pos: { x: 0, y: 0, z: 4 },
    normal: { x: 0, y: 0, z: 1 },
    surfaceNormal: { x: 0, y: 0, z: 1 },
    profile: { type: 'cone', lengthMm: 1, contactDiameterMm: 0.4, bodyDiameterMm: 0.8 },
});

const disk = (x: number) => ({
    id: `disk-${x}`, pos: { x, y: 0, z: 4 },
    surfaceNormal: { x: 0, y: 0, z: 1 }, coneAxis: { x: 0, y: 0, z: 1 },
    contactDiameterMm: 0.4,
    profile: { type: 'disk', lengthMm: 1, contactDiameterMm: 0.4, bodyDiameterMm: 0.8 },
});

/** The id one instance of a type carries in the scene `oneOfEach` builds. */
const instanceId = (typeId: string) => `${typeId}-a`;

/** The `roots` entry a type's edge into `roots` points at. */
const rootIdFor = (descriptor: SupportTypeDescriptor) => `${descriptor.id}-root`;

/**
 * The knot an edge into `knots` points at, named for the type and the field
 * rather than shared between them: two ends that both declare `takeHost` must
 * not be able to take each other's knot out from under the scene.
 */
const knotIdFor = (descriptor: SupportTypeDescriptor, edge: SupportEdge) => `${descriptor.id}-${edge.field}`;

/** Every knot the scene needs: one per declared edge into `knots`. */
const KNOT_IDS: readonly string[] = SUPPORT_TYPES.flatMap((descriptor) =>
    descriptor.edges.filter((edge) => edge.to === 'knots').map((edge) => knotIdFor(descriptor, edge)));

/**
 * The shaft every knot rides. The default placement tool's instance is the one
 * shaft the scene always builds, and `seg` names its segment from the instance
 * id, so the knot's host follows from the type rather than from a literal id.
 */
const hostSegmentId = () => `${instanceId(defaultPlacementToolTypeId())}-s`;

/**
 * The numeric fields a type declares by path but carries no value for: the two
 * ends of its shaft taper, and the one its fallback diameter reads. A type
 * carrying a profile names every field of it here, so the object is built from
 * the declaration.
 */
function declaredDiameterFields(descriptor: SupportTypeDescriptor): Record<string, string[]> {
    const fallback = descriptor.shaftFallback.fallbackDiameterMm;
    const paths = [
        ...(descriptor.shaftTaper?.from ?? []),
        ...(fallback && typeof fallback === 'object' ? [fallback.path] : []),
    ];

    const byRoot: Record<string, string[]> = {};
    for (const path of paths) {
        const dot = path.indexOf('.');
        if (dot < 0) continue;
        const root_ = path.slice(0, dot);
        byRoot[root_] = [...(byRoot[root_] ?? []), path.slice(dot + 1)];
    }
    return byRoot;
}

/** The entity an edge points at, from the vocabulary the edge declares. */
function edgeTargetFor(descriptor: SupportTypeDescriptor, edge: SupportEdge): string {
    if (edge.to === 'roots') return rootIdFor(descriptor);
    if (edge.to === 'segment') return hostSegmentId();
    if (edge.to === 'knots') return knotIdFor(descriptor, edge);
    throw new Error(`${descriptor.id} declares an edge to ${edge.to}, which the seed scene builds no target for`);
}

/**
 * A minimal but valid instance of `descriptor`.
 *
 * Every field comes from a declared fact: `hasSegments` for the shaft, the
 * declared contacts and their kinds for the primitives, `edges` for the links
 * to roots, knots and the host segment, and the taper/fallback paths for the
 * diameters a type carries inside a profile.
 */
function seedFor(descriptor: SupportTypeDescriptor, id: string): Record<string, unknown> {
    const entity: Record<string, unknown> = { id, modelId: 'model-a' };

    if (descriptor.hasSegments) entity.segments = [seg(`${id}-s`)];

    const kindByField: Record<string, string> = {};
    for (const { field, kind } of contactEndpointsFor(descriptor.id)) kindByField[field] = kind;

    let disks = 0;
    for (const field of descriptor.contactFields) {
        if (kindByField[field] === 'disk') {
            disks += 1;
            entity[field] = disk(disks);
        } else {
            entity[field] = cone();
        }
    }

    for (const edge of descriptor.edges) entity[edge.field] = edgeTargetFor(descriptor, edge);

    // A type riding another shaft's segment sits at a `t` along it and records
    // the lowest one it may take. The edge to `segment` says so; the t is not
    // declared anywhere, so the scaffold pins the number itself.
    if (descriptor.edges.some((edge) => edge.to === 'segment')) entity.hostMinT = HOST_MIN_T;

    for (const [root_, fields] of Object.entries(declaredDiameterFields(descriptor))) {
        // Skipped where the entity already carries the object: a taper path may
        // point into a contact the loop above built (a twig's two disks).
        if (root_ in entity) continue;
        entity[root_] = Object.fromEntries(fields.map((field) => [field, DECLARED_DIAMETER_MM]));
    }

    return entity;
}

/** One of every type, added through the generic adder. */
function oneOfEach() {
    resetStore();

    SUPPORT_TYPES
        .filter((descriptor) => descriptor.edges.some((edge) => edge.to === 'roots'))
        .forEach((descriptor, index) => addRoot(root(rootIdFor(descriptor), index * ROOT_SPACING_MM) as never));

    KNOT_IDS.forEach((knotId, index) => {
        // Spread along the shaft, so no two knots land on the same spot.
        const t = (index + 1) / (KNOT_IDS.length + 1);
        addKnot({
            id: knotId,
            parentShaftId: hostSegmentId(),
            t,
            pos: { x: 0, y: 0, z: t * SEGMENT_TOP_Z },
            diameter: 1,
        } as never);
    });

    for (const descriptor of SUPPORT_TYPES) {
        addSupportEntity(descriptor.id, seedFor(descriptor, instanceId(descriptor.id)) as never);
    }
}

/** Every entity in every type collection, with the type its collection implies. */
function* storedEntities() {
    const state = getSnapshot();
    for (const descriptor of SUPPORT_TYPES) {
        const collection = state[descriptor.location.key] as Record<string, { id: string; typeId?: string }>;
        for (const entity of Object.values(collection ?? {})) {
            yield { entity, impliedBy: descriptor.id };
        }
    }
}

function assertAllAgree(context: string) {
    let seen = 0;
    for (const { entity, impliedBy } of storedEntities()) {
        seen += 1;
        assert.equal(entity.typeId, impliedBy, `${context}: ${entity.id} in the ${impliedBy} collection`);
    }
    assert.ok(seen > 0, `${context}: nothing was checked`);
    return seen;
}

test('adding through the generic adder stamps the type', () => {
    oneOfEach();
    assert.equal(assertAllAgree('after add'), SUPPORT_TYPES.length);
});

test('an entity arriving with the wrong type is corrected, not trusted', () => {
    // The adder knows the collection it is writing to; a caller passing a
    // stale or hand-written typeId must not be able to desynchronise the two.
    oneOfEach();
    for (const descriptor of SUPPORT_TYPES) {
        const wrong = SUPPORT_TYPES.find((candidate) => candidate.id !== descriptor.id);
        assert.ok(wrong, 'a type can only be given a wrong one while a second type exists');

        const id = `${descriptor.id}-wrong`;
        addSupportEntity(descriptor.id, { ...seedFor(descriptor, id), typeId: wrong.id } as never);

        const collection = getSnapshot()[descriptor.location.key] as Record<string, { typeId?: string }>;
        assert.equal(collection[id]?.typeId, descriptor.id, `${descriptor.id} trusted the type it was handed`);
    }
});

test('updating an entity keeps the type', () => {
    oneOfEach();
    for (const descriptor of SUPPORT_TYPES) {
        const collection = getSnapshot()[descriptor.location.key] as Record<string, { id: string }>;
        const existing = Object.values(collection)[0];
        updateSupportEntity(descriptor.id, { ...existing, modelId: 'model-b' });
    }
    assertAllAgree('after update');
});

test('restoring after a removal keeps the type', () => {
    // Undo puts entities back through `restoreToCollection`; an entity that
    // came back without its type would be invisible to every typeId lookup.
    // One type at a time from a fresh scene: removing a trunk cascades away the
    // branch hanging off it, so a single pass would remove some types twice.
    for (const descriptor of SUPPORT_TYPES) {
        oneOfEach();

        const removed = removeSupportEntity(descriptor.id, instanceId(descriptor.id));
        assert.ok(removed, `${descriptor.id} was not removed`);
        // The removal result names the entity under the `self` key its shape
        // declares, which the registry derives from the type.
        const self = (removed as Record<string, unknown>)[removalShapeFor(descriptor.id).self];
        assert.ok(self, `${descriptor.id} removal returned no entity`);
        restoreToCollection(descriptor.location.key, self);

        const collection = getSnapshot()[descriptor.location.key] as Record<string, { typeId?: string }>;
        assert.equal(
            collection[instanceId(descriptor.id)]?.typeId,
            descriptor.id,
            `${descriptor.id} lost its type on restore`,
        );
    }
});

test('a loaded file carries the type, derived from the array it came out of', () => {
    oneOfEach();
    const payload = buildSupportExportFromStores(getSnapshot(), getSnapshot() as never);

    resetStore();
    loadFromImportFormat(payload);

    assertAllAgree('after load');
});


test('an entity that reaches the store unstamped is stamped on entry', () => {
    // `setSnapshot` replaces the whole store and is the path undo of a
    // whole-store action takes. It stamps, so an entity that arrives without a
    // typeId still lands in its collection. `seedFor` never writes a typeId,
    // so every seed here is unstamped.
    oneOfEach();
    const forced = { ...getSnapshot() } as unknown as Record<string, unknown>;
    for (const descriptor of SUPPORT_TYPES) {
        const id = `${descriptor.id}-unstamped`;
        forced[descriptor.location.key] = { [id]: seedFor(descriptor, id) };
    }
    setSnapshot(forced as never);

    for (const descriptor of SUPPORT_TYPES) {
        const id = `${descriptor.id}-unstamped`;
        assert.equal(
            getSupportTypeOf(id),
            descriptor.id,
            `${descriptor.id} arrived unstamped and was not stamped by the store`,
        );
        // Not just resolvable from its collection: the store hands it out
        // carrying the stamp.
        assert.equal(getSupports()[id]?.typeId, descriptor.id, `${descriptor.id} was not stamped on entry`);
    }
    assert.equal(getSupportTypeOf('not-in-the-store'), null);
});
