import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import {
    autoBraceableShaftTypes,
    createEmptySupportCollections,
    isAutoBraceableShaftType,
    lateralStabiliserTypes,
    SUPPORT_TYPES,
} from '../supportTypeRegistry';
import type { Branch, Roots, SupportState, Trunk } from '../types';

/**
 * What auto-bracing may brace, pinned as the DERIVED set so re-narrowing it
 * fails here rather than dropping a type from bracing.
 */

function root(id: string, modelId: string, x: number): Roots {
    return {
        id,
        modelId,
        transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function trunk(id: string, modelId: string, rootId: string, x: number, topZ = 12): Trunk {
    return {
        id,
        typeId: 'trunk',
        modelId,
        rootId,
        segments: [{
            id: `seg-${id}`,
            diameter: 1,
            topJoint: { id: `joint-${id}`, pos: { x, y: 0, z: topZ }, diameter: 1.2 },
        }],
    };
}

/** A branch hanging off a trunk's knot, ending at a model contact. */
function branch(id: string, modelId: string, parentKnotId: string, x: number, y: number): Branch {
    return {
        id,
        typeId: 'branch',
        modelId,
        parentKnotId,
        segments: [{
            id: `seg-${id}`,
            diameter: 1,
            bottomJoint: { id: `bjoint-${id}`, pos: { x: 0, y: 0, z: 8 }, diameter: 1.1 },
            topJoint: { id: `tjoint-${id}`, pos: { x, y, z: 10 }, diameter: 1.1 },
        }],
    } as unknown as Branch;
}

function emptySnapshot(): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null, selectedCategory: null, hoveredId: null,
        hoveredCategory: 'none', interactionWarning: null,
    };
}

test('the braceable set is derived, and holds trunk and branch', () => {
    assert.deepEqual(
        [...autoBraceableShaftTypes()].sort(),
        ['branch', 'trunk'],
        'trunk and branch are the braceable shafts',
    );
    assert.equal(isAutoBraceableShaftType('branch'), true, 'branch must be braceable, not just declared');
    assert.equal(isAutoBraceableShaftType('trunk'), true);
});

test('a lateral stabiliser is NOT a braceable member — it is generated as an extra', () => {
    // Kickstand declares `isAutoBraceable: true` AND has a shaft, so the flag
    // alone would admit it. It is excluded because it is the thing this pass
    // GENERATES, offered beside a group rather than braced as a member of one.
    assert.ok(
        lateralStabiliserTypes().includes('kickstand'),
        'precondition: kickstand registers as a lateral stabiliser',
    );
    assert.equal(isAutoBraceableShaftType('kickstand'), false);
});

test('types with no shaft, or that are not braceable, stay out', () => {
    // Derived from the declared set, so a type added to the registry is covered
    // without editing this.
    const braceable = new Set<string>(autoBraceableShaftTypes());
    const excluded = SUPPORT_TYPES.filter((descriptor) => !braceable.has(descriptor.id));
    assert.ok(excluded.length > 0, 'precondition: some declared type is not braceable');
    for (const descriptor of excluded) {
        assert.equal(
            isAutoBraceableShaftType(descriptor.id),
            false,
            `${descriptor.id} must not be braceable`,
        );
    }
});

/**
 * The behaviour behind the flag.
 *
 * The scene holds branches and NO trunks, so the sample-pool filter alone
 * decides the outcome: the early return reports `skippedSupportCount:
 * samples.length`, which is the branch count only if branches reach the pool.
 * A scene holding a trunk as well would pass whether or not they do.
 */
test('a branch reaches the pass: a branches-only scene reports it as a sample', () => {
    const snapshot = emptySnapshot();
    const modelId = 'model-a';

    // Two branches off a host knot, and deliberately NO trunk: any sample the
    // pass reports can only have come from a branch.
    snapshot.knots['k-host'] = {
        id: 'k-host', parentShaftId: 'seg-absent', t: 0.5,
        pos: { x: 0, y: 0, z: 6 }, diameter: 1.1,
    };
    snapshot.branches['branch-a'] = branch('branch-a', modelId, 'k-host', 3, 0);
    snapshot.branches['branch-b'] = branch('branch-b', modelId, 'k-host', -3, 0);

    const result = buildAutoBracedSnapshot(snapshot, createDefaultAutoBracingSettings());

    assert.equal(
        result.skippedSupportCount,
        2,
        'both branches must be samples the pass accounts for',
    );
    assert.equal(result.generatedBraceCount, 0, 'two is below minGroupSize, so nothing is braced yet');
});
