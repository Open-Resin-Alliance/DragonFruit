import assert from 'node:assert/strict';
import test from 'node:test';

import { getSnapshot, loadFromImportFormat, removeSupportEntity, resetStore } from '../state';
import {
    hostKnotFieldsFor,
    removalShapeFor,
    restoreToCollection,
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
    typeIdForCollection,
    type SupportCollectionKey,
} from '../supportTypeRegistry';
import { keyOf } from './helpers/typeCollections';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import type { DragonfruitImportFormat } from '../types';

/**
 * Every removal must return enough to rebuild what it deleted. The goldens pin
 * what a cascade removes, not whether the snapshot can put it back; these
 * replay each snapshot the way its history handler does.
 */

/** Entity counts per collection, for comparing before and after. */
function census(): Record<string, number> {
    const state = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const counts: Record<string, number> = {};
    for (const key of SUPPORT_COLLECTION_KEYS) counts[key] = Object.keys(state[key] ?? {}).length;
    return counts;
}

const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

const seg = (id: string, topZ: number) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: topZ - 2 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: topZ }, diameter: 1 },
});
const cone = (id: string, z: number) => ({
    id,
    pos: { x: 0, y: 0, z },
    normal: { x: 0, y: 0, z: 1 },
    surfaceNormal: { x: 0, y: 0, z: 1 },
    diameter: 1,
    height: 1,
    profile: DEFAULT_TIP_PROFILE,
});
const root = (id: string, modelId: string, x: number) => ({
    id, modelId,
    transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
});
const knotOn = (id: string, shaftId: string, z: number) => ({
    id, parentShaftId: shaftId, t: 0.5, pos: { x: 0, y: 0, z }, diameter: 1,
});

/** The collections this file builds and puts back, asked of the registry. */
const TRUNKS = keyOf('trunk');
const BRANCHES = keyOf('branch');
const LEAVES = keyOf('leaf');
const TWIGS = keyOf('twig');
const STICKS = keyOf('stick');
const BRACES = keyOf('brace');
const STUMPS = keyOf('stump');
const KICKSTANDS = keyOf('kickstand');

/**
 * A scene with one of every cascade shape: a knot on each shafted type, a leaf
 * on a twig and on a stick, a brace spanning two models, a nested branch, and
 * a kickstand grafted from another model.
 *
 * Self-contained: the golden fixture is local-only scaffolding.
 */
function fixture(): DragonfruitImportFormat {
    return {
        version: 1,
        meta: { source: 'round-trip', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [root('root-a', MODEL_A, 0), root('root-b', MODEL_B, 20), root('ks-root-a', MODEL_A, 3)],
        [TRUNKS]: [
            { id: 'trunk-a', modelId: MODEL_A, rootId: 'root-a', segments: [seg('seg-ta', 4)], contactCone: cone('cone-ta', 12) },
            { id: 'trunk-b', modelId: MODEL_B, rootId: 'root-b', segments: [seg('seg-tb', 4)], contactCone: cone('cone-tb', 12) },
        ],
        [BRANCHES]: [
            { id: 'branch-a', modelId: MODEL_A, parentKnotId: 'knot-a', segments: [seg('seg-ba', 6)], contactCone: cone('cone-ba', 16) },
            { id: 'branch-nested', modelId: MODEL_A, parentKnotId: 'knot-on-branch', segments: [seg('seg-bn', 7)], contactCone: cone('cone-bn', 17) },
        ],
        [LEAVES]: [
            { id: 'leaf-a', modelId: MODEL_A, parentKnotId: 'knot-a', contactCone: cone('cone-la', 14) },
            { id: 'leaf-on-twig', modelId: MODEL_A, parentKnotId: 'knot-on-twig', contactCone: cone('cone-lw', 15) },
            { id: 'leaf-on-stick', modelId: MODEL_A, parentKnotId: 'knot-on-stick', contactCone: cone('cone-ls', 16) },
        ],
        [TWIGS]: [{ id: 'twig-a', modelId: MODEL_A, segments: [seg('seg-wa', 8)], contactDiskA: cone('disk-wa1', 8), contactDiskB: cone('disk-wa2', 13) }],
        [STICKS]: [{ id: 'stick-a', modelId: MODEL_A, segments: [seg('seg-sa', 9)], contactConeA: cone('cone-sa1', 9), contactConeB: cone('cone-sa2', 14) }],
        [BRACES]: [
            { id: 'brace-a', modelId: MODEL_A, startKnotId: 'knot-a', endKnotId: 'knot-b', profile: { diameter: 0.8 } },
            { id: 'brace-ks', modelId: MODEL_A, startKnotId: 'knot-on-kickstand', endKnotId: 'knot-on-branch', profile: { diameter: 0.8 } },
        ],
        [STUMPS]: [{
            id: 'anchor-a', modelId: MODEL_A,
            rootPos: { x: 5, y: 0, z: 0 }, rootBaseDiameter: 2, rootTopDiameter: 1, rootHeight: 1,
            joint: { id: 'anchor-a-joint', pos: { x: 5, y: 0, z: 1 }, diameter: 1 },
            segments: [seg('seg-aa', 3)], contactCone: cone('cone-aa', 7),
        }],
        knots: [
            knotOn('knot-a', 'seg-ta', 4.5), knotOn('knot-b', 'seg-tb', 4.5),
            knotOn('knot-on-branch', 'seg-ba', 6.5), knotOn('knot-on-twig', 'seg-wa', 8.4),
            knotOn('knot-on-stick', 'seg-sa', 9.6), knotOn('knot-on-anchor', 'seg-aa', 1.5),
            knotOn('knot-on-kickstand', 'seg-ka', 2.5),
        ],
        [KICKSTANDS]: [{
            root: root('ks-root-a', MODEL_A, 3),
            hostKnot: knotOn('ks-knot-a', 'seg-ta', 3.5),
            kickstand: {
                id: 'ks-a', modelId: MODEL_A, rootId: 'ks-root-a', hostKnotId: 'ks-knot-a',
                hostSegmentId: 'seg-ta', hostMinT: 0.2, segments: [seg('seg-ka', 2)],
                profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1.2, terminalEndDiameterMm: 0.8 },
            },
        }],
    } as unknown as DragonfruitImportFormat;
}

function load() {
    resetStore();
    loadFromImportFormat(fixture());
}

/**
 * The types whose entity rides nothing. The restore order depends on it: a
 * hosted entity cannot come back before the thing it rides.
 */
const SHAFTS_RIDING_NOTHING = SUPPORT_TYPES.filter(
    (descriptor) => descriptor.hasSegments && hostKnotFieldsFor(descriptor.id).length === 0,
);

/** Replays a snapshot the way the history handlers do, through `restoreToCollection`. */
function restore(snapshot: Record<string, unknown>) {
    const list = (field: string) => (snapshot[field] as unknown[] | undefined) ?? [];
    const one = (field: string) => snapshot[field] as never;
    // The field an entity arrives under is its declared shape's `self`.
    const seed = (collection: SupportCollectionKey) =>
        one(removalShapeFor(typeIdForCollection(collection)).self);
    const putBack = (collection: SupportCollectionKey, entity: unknown) => {
        if (entity) restoreToCollection(collection, entity);
    };

    for (const root of list('roots')) putBack('roots', root);
    putBack('roots', one('root'));

    // Hosts first: a hosted entity cannot come back before the thing it rides.
    for (const descriptor of SHAFTS_RIDING_NOTHING) {
        putBack(descriptor.location.key, seed(descriptor.location.key));
    }

    for (const knot of list('knots')) putBack('knots', knot);
    putBack('knots', one('knot'));
    putBack('knots', one('startKnot'));
    putBack('knots', one('endKnot'));

    // Branches come back ONLY via the list, matching the real handler -- which
    // also bails when the branch list is empty. Reading a `branch` field here
    // would hide a seed dropped from the list.
    for (const branch of list(BRANCHES)) putBack(BRANCHES, branch);

    for (const leaf of list(LEAVES)) putBack(LEAVES, leaf);
    putBack(LEAVES, seed(LEAVES));

    for (const brace of list(BRACES)) putBack(BRACES, brace);
    putBack(BRACES, seed(BRACES));

    for (const build of list(KICKSTANDS)) putBack(KICKSTANDS, build);
    putBack(KICKSTANDS, snapshot.build);
}

/**
 * A removal case: the prose name, the collection the fixture seeds the entity
 * in, and that entity's id.
 *
 * The collection is the one the registry declares for the type the row is about
 * -- derived at the top of this file, never spelled -- and `typeIdForCollection`
 * turns it back into that type. The fixture ids are arbitrary strings.
 */
const CASES: [string, SupportCollectionKey, string][] = [
    ['removeTrunk (deep cascade)', TRUNKS, 'trunk-a'],
    ['removeTrunk (far side)', TRUNKS, 'trunk-b'],
    ['removeBranch', BRANCHES, 'branch-a'],
    ['removeLeaf', LEAVES, 'leaf-a'],
    ['removeTwig', TWIGS, 'twig-a'],
    ['removeStick', STICKS, 'stick-a'],
    ['removeBrace', BRACES, 'brace-a'],
    ['removeAnchor', STUMPS, 'anchor-a'],
    ['removeKickstand', KICKSTANDS, 'ks-a'],
];

test('every declared type has a removal case', () => {
    // The table must cover every declared type. A type may hold more than one
    // row -- trunk does: deep cascade and far side.
    const covered = CASES.map(([, collection]) => typeIdForCollection(collection));
    assert.deepEqual(
        SUPPORT_TYPES.map((descriptor) => descriptor.id).filter((id) => !covered.includes(id)),
        [],
        'every declared type is covered by a removal case',
    );
});

for (const [name, collection, entityId] of CASES) {
    test(`${name}: its snapshot rebuilds what it removed`, () => {
        load();
        const before = census();

        const snapshot = removeSupportEntity(
            typeIdForCollection(collection),
            entityId,
        ) as unknown as Record<string, unknown> | null;
        assert.ok(snapshot, 'the remover should report what it took');

        const after = census();
        const removedAnything = SUPPORT_COLLECTION_KEYS.some((key) => after[key] < before[key]);
        assert.ok(removedAnything, 'the removal should have deleted something');

        restore(snapshot);
        assert.deepEqual(census(), before, 'restoring the snapshot should undo the removal');
    });
}

test('a removal reports every collection it emptied', () => {
    // The counts above would still match if a remover deleted an entity and
    // reported it under the wrong field, so check the removed ids by name.
    load();
    const beforeState = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const beforeIds = new Set<string>();
    for (const key of SUPPORT_COLLECTION_KEYS) {
        for (const id of Object.keys(beforeState[key] ?? {})) beforeIds.add(`${key}:${id}`);
    }

    const snapshot = removeSupportEntity(typeIdForCollection(TRUNKS), 'trunk-a') as unknown as Record<string, unknown>;
    restore(snapshot);

    const afterState = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    for (const key of SUPPORT_COLLECTION_KEYS) {
        for (const id of Object.keys(beforeState[key] ?? {})) {
            assert.ok(afterState[key]?.[id], `${key}:${id} was not restored`);
        }
    }
});
