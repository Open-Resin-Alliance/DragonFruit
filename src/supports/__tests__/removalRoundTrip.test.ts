import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addAnchor,
    addBrace,
    addBranch,
    addKnot,
    addLeaf,
    addRoot,
    addStick,
    addTrunk,
    addTwig,
    getSnapshot,
    loadFromImportFormat,
    removeAnchor,
    removeBrace,
    removeBranch,
    removeLeaf,
    removeStick,
    removeSupportEntity,
    removeTrunk,
    removeTwig,
    resetStore,
} from '../state';
import { restoreToCollection, SUPPORT_COLLECTION_KEYS } from '../supportTypeRegistry';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import type { DragonfruitImportFormat } from '../types';

/**
 * Every removal must return enough to rebuild what it deleted.
 *
 * The goldens pin what a cascade REMOVES; they say nothing about whether the
 * returned snapshot can put it back. Converting the removers to one generic
 * walk dropped the seed branch from `removeBranch`'s list, and every golden
 * still passed -- undo would simply have restored one branch fewer.
 *
 * These replay each remover's snapshot the way its history handler does and
 * check the store returns to where it started.
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

/**
 * A scene with one of every cascade shape: a knot on each shafted type, a leaf
 * on a twig and on a stick, a brace spanning two models, a nested branch, and
 * a kickstand grafted from another model.
 *
 * Deliberately self-contained rather than shared with the golden fixture, which
 * is local-only scaffolding and not present in a clean checkout.
 */
function fixture(): DragonfruitImportFormat {
    return {
        version: 1,
        meta: { source: 'round-trip', objectCenter: { x: 0, y: 0, z: 0 } },
        roots: [root('root-a', MODEL_A, 0), root('root-b', MODEL_B, 20), root('ks-root-a', MODEL_A, 3)],
        trunks: [
            { id: 'trunk-a', modelId: MODEL_A, rootId: 'root-a', segments: [seg('seg-ta', 4)], contactCone: cone('cone-ta', 12) },
            { id: 'trunk-b', modelId: MODEL_B, rootId: 'root-b', segments: [seg('seg-tb', 4)], contactCone: cone('cone-tb', 12) },
        ],
        branches: [
            { id: 'branch-a', modelId: MODEL_A, parentKnotId: 'knot-a', segments: [seg('seg-ba', 6)], contactCone: cone('cone-ba', 16) },
            { id: 'branch-nested', modelId: MODEL_A, parentKnotId: 'knot-on-branch', segments: [seg('seg-bn', 7)], contactCone: cone('cone-bn', 17) },
        ],
        leaves: [
            { id: 'leaf-a', modelId: MODEL_A, parentKnotId: 'knot-a', contactCone: cone('cone-la', 14) },
            { id: 'leaf-on-twig', modelId: MODEL_A, parentKnotId: 'knot-on-twig', contactCone: cone('cone-lw', 15) },
            { id: 'leaf-on-stick', modelId: MODEL_A, parentKnotId: 'knot-on-stick', contactCone: cone('cone-ls', 16) },
        ],
        twigs: [{ id: 'twig-a', modelId: MODEL_A, segments: [seg('seg-wa', 8)], contactDiskA: cone('disk-wa1', 8), contactDiskB: cone('disk-wa2', 13) }],
        sticks: [{ id: 'stick-a', modelId: MODEL_A, segments: [seg('seg-sa', 9)], contactConeA: cone('cone-sa1', 9), contactConeB: cone('cone-sa2', 14) }],
        braces: [
            { id: 'brace-a', modelId: MODEL_A, startKnotId: 'knot-a', endKnotId: 'knot-b', profile: { diameter: 0.8 } },
            { id: 'brace-ks', modelId: MODEL_A, startKnotId: 'knot-on-kickstand', endKnotId: 'knot-on-branch', profile: { diameter: 0.8 } },
        ],
        anchors: [{
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
        kickstands: [{
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

/** Replays a snapshot the way the history handlers do. */
function restore(snapshot: Record<string, unknown>) {
    const list = (field: string) => (snapshot[field] as unknown[] | undefined) ?? [];
    const one = (field: string) => snapshot[field] as never;

    if (one('root')) addRoot(one('root'));
    for (const root of list('roots')) addRoot(root as never);

    if (one('trunk')) addTrunk(one('trunk'));
    if (one('twig')) addTwig(one('twig'));
    if (one('stick')) addStick(one('stick'));
    if (one('anchor')) addAnchor(one('anchor'));

    for (const knot of list('knots')) addKnot(knot as never);
    if (one('knot')) addKnot(one('knot'));
    if (one('startKnot')) addKnot(one('startKnot'));
    if (one('endKnot')) addKnot(one('endKnot'));

    // Branches come back ONLY via the list, matching the real handler -- which
    // also bails when `branches` is empty. Reading a `branch` field here would
    // hide a seed dropped from the list.
    for (const branch of list('branches')) addBranch(branch as never);

    for (const leaf of list('leaves')) addLeaf(leaf as never);
    if (one('leaf')) addLeaf(one('leaf'));

    for (const brace of list('braces')) addBrace(brace as never);
    if (one('brace')) addBrace(one('brace'));

    // Through the registered restore, which is what the handlers use.
    for (const build of list('kickstands')) restoreToCollection('kickstands', build);
    if (snapshot.build) restoreToCollection('kickstands', snapshot.build);
}

const CASES: [string, () => Record<string, unknown> | null][] = [
    ['removeTrunk (deep cascade)', () => removeTrunk('trunk-a') as never],
    ['removeTrunk (far side)', () => removeTrunk('trunk-b') as never],
    ['removeBranch', () => removeBranch('branch-a') as never],
    ['removeLeaf', () => removeLeaf('leaf-a') as never],
    ['removeTwig', () => removeTwig('twig-a') as never],
    ['removeStick', () => removeStick('stick-a') as never],
    ['removeBrace', () => removeBrace('brace-a') as never],
    ['removeAnchor', () => removeAnchor('anchor-a') as never],
    ['removeKickstand', () => removeSupportEntity('kickstand', 'ks-a') as never],
];

for (const [name, remove] of CASES) {
    test(`${name}: its snapshot rebuilds what it removed`, () => {
        load();
        const before = census();

        const snapshot = remove();
        assert.ok(snapshot, 'the remover should report what it took');

        const after = census();
        const removedAnything = SUPPORT_COLLECTION_KEYS.some((key) => after[key] < before[key]);
        assert.ok(removedAnything, 'the removal should have deleted something');

        restore(snapshot as Record<string, unknown>);
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

    const snapshot = removeTrunk('trunk-a') as unknown as Record<string, unknown>;
    restore(snapshot);

    const afterState = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    for (const key of SUPPORT_COLLECTION_KEYS) {
        for (const id of Object.keys(beforeState[key] ?? {})) {
            assert.ok(afterState[key]?.[id], `${key}:${id} was not restored`);
        }
    }
});
