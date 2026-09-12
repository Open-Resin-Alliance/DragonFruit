import assert from 'node:assert/strict';
import test from 'node:test';

import { addKnot, addRoot, addSupportEntity, findShaftOwnerOfJoint, findShaftOwnerOfSegment, getSnapshot, getSupportTypeOf, setSnapshot, loadFromImportFormat, removeSupportEntity, resetStore } from '../state';
import { SUPPORT_TYPES, getSupportTypeDescriptor, restoreToCollection, updateSupportEntity } from '../supportTypeRegistry';
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
 */

const seg = (id: string) => ({
    id, diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
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

/** A minimal but valid instance of each type, keyed by type id. */
const SEED: Record<string, (id: string) => Record<string, unknown>> = {
    trunk: (id) => ({ id, modelId: 'model-a', rootId: 'root-a', segments: [seg(`${id}-s`)], contactCone: cone() }),
    branch: (id) => ({ id, modelId: 'model-a', parentKnotId: 'knot-a', segments: [seg(`${id}-s`)], contactCone: cone() }),
    leaf: (id) => ({ id, modelId: 'model-a', parentKnotId: 'knot-a', contactCone: cone() }),
    twig: (id) => ({ id, modelId: 'model-a', segments: [seg(`${id}-s`)], contactDiskA: disk(1), contactDiskB: disk(2) }),
    stick: (id) => ({ id, modelId: 'model-a', segments: [seg(`${id}-s`)], contactConeA: cone(), contactConeB: cone() }),
    brace: (id) => ({ id, modelId: 'model-a', startKnotId: 'knot-a', endKnotId: 'knot-b' }),
    anchor: (id) => ({ id, modelId: 'model-a', segments: [seg(`${id}-s`)], contactCone: cone() }),
    kickstand: (id) => ({
        id, modelId: 'model-a', rootId: 'ks-root', hostKnotId: 'knot-b',
        hostSegmentId: 'trunk-a-s', hostMinT: 0.2, segments: [seg(`${id}-s`)],
        profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 0.8 },
    }),
};

/** One of every type, added through the generic adder. */
function oneOfEach() {
    resetStore();
    addRoot(root('root-a', 0) as never);
    addRoot(root('ks-root', 3) as never);
    addKnot({ id: 'knot-a', parentShaftId: 'trunk-a-s', t: 0.5, pos: { x: 0, y: 0, z: 2 }, diameter: 1 } as never);
    addKnot({ id: 'knot-b', parentShaftId: 'trunk-a-s', t: 0.3, pos: { x: 0, y: 0, z: 1.2 }, diameter: 1 } as never);

    for (const descriptor of SUPPORT_TYPES) {
        addSupportEntity(descriptor.id, SEED[descriptor.id](`${descriptor.id}-a`) as never);
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
    addSupportEntity('twig', { ...SEED.twig('twig-b'), typeId: 'trunk' } as never);

    assert.equal(getSnapshot().twigs['twig-b'].typeId, 'twig');
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

        const removed = removeSupportEntity(descriptor.id, `${descriptor.id}-a`);
        assert.ok(removed, `${descriptor.id} was not removed`);
        // The removal result names the entity by its `self` key, which is the
        // type id -- SUPPORT_REMOVAL_SHAPES declares it.
        const self = (removed as Record<string, unknown>)[descriptor.id];
        assert.ok(self, `${descriptor.id} removal returned no entity`);
        restoreToCollection(descriptor.location.key, self);

        const collection = getSnapshot()[descriptor.location.key] as Record<string, { typeId?: string }>;
        assert.equal(
            collection[`${descriptor.id}-a`]?.typeId,
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
    // typeId still lands in its collection.
    oneOfEach();
    const forced = { ...getSnapshot() } as Record<string, unknown>;
    forced.twigs = { unstamped: { id: 'unstamped', modelId: 'model-a', segments: [] } };
    setSnapshot(forced as never);

    assert.equal(getSupportTypeOf('unstamped'), 'twig');
    assert.equal(getSupportTypeOf('not-in-the-store'), null);
});

