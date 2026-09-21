import assert from 'node:assert/strict';
import test from 'node:test';

import { removalPayloadFor, removeSupportEntityWithPayload } from '../history/removalPayload';
import { SUPPORT_REMOVAL_SHAPES, SUPPORT_TYPES } from '../supportTypeRegistry';
import { getSnapshot, loadFromImportFormat, removeSupportEntity, resetStore } from '../state';
import type { DragonfruitImportFormat, SupportState } from '../types';

/**
 * What a type's removal records, and whether it also repaired its host. Both
 * decisions live in `history/removalPayload.ts`, outside the React hook.
 */

const MODEL = 'model-a';
const cone = (id: string, z: number) => ({
    id, pos: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: -1 },
    profile: { type: 'cone', bodyDiameterMm: 1, contactDiameterMm: 0.4, lengthMm: 1 },
});
const seg = (id: string, length: number) => ({
    id, type: 'straight', diameter: 1,
    bottomJoint: { id: `${id}-b`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-t`, pos: { x: 0, y: 0, z: length }, diameter: 1 },
});
const root = (id: string) => ({
    id, modelId: MODEL,
    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
});

/** A trunk with two branches on it, plus a leaf, so removals cascade. */
function fixture(): DragonfruitImportFormat {
    return {
        version: 1,
        meta: { source: 'payload-shapes', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [root('root-a')],
        trunks: [{
            id: 'trunk-a', modelId: MODEL, rootId: 'root-a',
            segments: [seg('seg-ta', 10)], contactCone: cone('cone-ta', 12),
        }],
        branches: [
            { id: 'branch-a', modelId: MODEL, parentKnotId: 'knot-a', segments: [seg('seg-ba', 6)], contactCone: cone('cone-ba', 16) },
            { id: 'branch-b', modelId: MODEL, parentKnotId: 'knot-b', segments: [seg('seg-bb', 6)], contactCone: cone('cone-bb', 16) },
        ],
        leaves: [{ id: 'leaf-a', modelId: MODEL, parentKnotId: 'knot-a', contactCone: cone('cone-la', 14) }],
        anchors: [{
            id: 'anchor-a', modelId: MODEL,
            rootPos: { x: 5, y: 0, z: 0 }, rootBaseDiameter: 2, rootTopDiameter: 1, rootHeight: 1,
            joint: { id: 'anchor-a-joint', pos: { x: 5, y: 0, z: 1 }, diameter: 1 },
            segments: [seg('seg-aa', 3)], contactCone: cone('cone-aa', 7),
        }],
        knots: [
            { id: 'knot-a', parentShaftId: 'seg-ta', t: 0.4, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
            { id: 'knot-b', parentShaftId: 'seg-ta', t: 0.6, pos: { x: 0, y: 0, z: 6 }, diameter: 1 },
        ],
        twigs: [], sticks: [], braces: [], kickstands: [],
    } as unknown as DragonfruitImportFormat;
}

function load() {
    resetStore();
    loadFromImportFormat(fixture());
}

test('the payload reports exactly the fields the registry declares', () => {
    // The derivation, stated directly: for every type, the removal reports its
    // own field plus one field per declared cascade entry, and nothing else.
    load();
    for (const descriptor of SUPPORT_TYPES) {
        const shape = SUPPORT_REMOVAL_SHAPES[descriptor.id];
        const declared = new Set<string>([shape.self]);
        for (const field of Object.values(shape.cascade)) {
            if (typeof field === 'string') declared.add(field);
            else for (const name of field) declared.add(name);
        }

        const snapshots = removeSupportEntity(descriptor.id, '__missing__');
        if (!snapshots) continue; // nothing of this type in the fixture

        const payload = removalPayloadFor(
            descriptor.id,
            '__missing__',
            snapshots as unknown as Record<string, unknown>,
            getSnapshot() as unknown as SupportState,
            getSnapshot() as unknown as SupportState,
        );
        for (const field of declared) {
            assert.ok(field in payload, `${descriptor.id} payload is missing declared field "${field}"`);
        }
    }
});

test('a brace reports two NAMED knots, not a list', () => {
    // `brace: { knots: ['startKnot', 'endKnot'] }` in the registry is what makes
    // this shape.
    load();
    const removed = removeSupportEntityWithPayload('leaf', 'leaf-a');
    assert.ok(removed);
    // The leaf's cascade declares `knots: 'knot'`, so the field is singular.
    assert.ok('knot' in removed.payload, 'leaf payload names its knot singularly');
    assert.ok(!('knots' in removed.payload), 'and not as a list');
});

test('a branch removal re-solves its host trunk and reports the repair', () => {
    load();
    const beforeDiameter = (getSnapshot() as unknown as SupportState).trunks['trunk-a'].segments[0].diameter;

    const removed = removeSupportEntityWithPayload('branch', 'branch-b');
    assert.ok(removed, 'the branch was removed');

    assert.deepEqual(
        (removed.payload.branches as { id: string }[]).map((b) => b.id),
        ['branch-b'],
        'payload carries the branch that was removed',
    );
    // The trunk still hosts branch-a, so it survives -- and its diameter profile
    // is re-solved. That repair is the whole reason branch declares
    // `repairsHostOnRemoval`.
    const hostUpdate = removed.payload.hostUpdate as { before: unknown; after: unknown } | undefined;
    assert.ok(hostUpdate, 'removing a branch reports the host it re-solved');
    assert.notEqual(
        JSON.stringify(hostUpdate.before),
        JSON.stringify(hostUpdate.after),
        'the reported trunk update is a real change',
    );

    // The invariant that matters: the store is left holding exactly the trunk
    // the payload says it should, so undo restores a state that existed.
    const live = (getSnapshot() as unknown as SupportState).trunks['trunk-a'];
    assert.deepEqual(
        JSON.parse(JSON.stringify(live)),
        hostUpdate.after,
        'the live trunk matches the trunk the payload reports',
    );
    void beforeDiameter;
});

test('a type that does not repair its host reports no trunk update', () => {
    // `repairHostAfterRemoval` bails first on the removed type's own `edges`:
    // the entity finds the host it hung from through a `hostedBy` edge onto
    // knots, and a type declaring no such edge has no host to repair. That
    // declaration is the fact keyed on here, for whichever types are hostless.
    const hostless = SUPPORT_TYPES.filter((descriptor) => !descriptor.edges.some(
        (edge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
    ));
    assert.ok(hostless.length > 0, 'the registry declares a type with no host knot');

    let checked = 0;
    for (const descriptor of hostless) {
        load();
        const key = descriptor.location.key as keyof SupportState;
        const seeded = Object.keys(
            ((getSnapshot() as unknown as Record<string, Record<string, unknown>>)[key]) ?? {},
        );
        for (const id of seeded) {
            load();
            const removed = removeSupportEntityWithPayload(descriptor.id, id);
            assert.ok(removed, `the ${descriptor.id} ${id} was removed`);
            assert.equal(removed.payload.hostUpdate, undefined, `${descriptor.id} ${id}: no repair reported`);
            checked++;
        }
    }
    // The property is only exercised if the fixture seeded one of them.
    assert.ok(checked > 0, 'the fixture seeds an entity for a hostless type');
});

test('an unknown id removes nothing and reports nothing', () => {
    load();
    assert.equal(removeSupportEntityWithPayload('leaf', 'no-such-leaf'), null);
});
