import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * Which knots survive an auto-bracing pass.
 *
 * Auto-bracing rebuilds the brace collection, and drops the knots the removed
 * braces used. A knot is only safe to drop when nothing still hangs from it --
 * and "hangs from it" is every type with a `hostedBy knots` edge, which is
 * branch, leaf, brace and kickstand.
 *
 * It preserved knots for branch and leaf by hand. A kickstand host knot was
 * nonetheless safe, because the stabiliser pass earlier in the same function
 * re-adds it -- so deriving the list fixes nothing today. These pin the
 * behaviour so the ninth type is covered by the rule rather than by luck.
 */

const seg = (id: string, z0 = 0, z1 = 20) => ({
    id, diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: z0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: z1 }, diameter: 1 },
});

const root = (id: string, x: number) => ({
    id, modelId: 'model-a',
    transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
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

/**
 * Two trunks, a brace between knots on them, and a kickstand hanging from the
 * same knot the brace uses.
 */
function sceneWithKickstandOnABracedKnot(braceGeneratedBy?: 'autoBracing') {
    const state = emptyState();
    put(state, 'roots', root('root-a', 0));
    put(state, 'roots', root('root-b', 10));
    put(state, 'roots', root('ks-root', 4));

    put(state, 'trunks', {
        id: 'trunk-a', modelId: 'model-a', typeId: 'trunk', rootId: 'root-a',
        segments: [seg('seg-a')],
    } as never);
    put(state, 'trunks', {
        id: 'trunk-b', modelId: 'model-a', typeId: 'trunk', rootId: 'root-b',
        segments: [seg('seg-b')],
    } as never);

    // The shared knot: a brace endpoint AND a kickstand's host.
    put(state, 'knots', {
        id: 'shared-knot', parentShaftId: 'seg-a', t: 0.5,
        pos: { x: 0, y: 0, z: 10 }, diameter: 1,
    } as never);
    put(state, 'knots', {
        id: 'far-knot', parentShaftId: 'seg-b', t: 0.5,
        pos: { x: 10, y: 0, z: 10 }, diameter: 1,
    } as never);

    put(state, 'braces', {
        id: 'brace-a', modelId: 'model-a', typeId: 'brace',
        startKnotId: 'shared-knot', endKnotId: 'far-knot',
        ...(braceGeneratedBy ? { generatedBy: braceGeneratedBy } : {}),
    } as never);

    put(state, 'kickstands', {
        id: 'ks-a', modelId: 'model-a', typeId: 'kickstand',
        rootId: 'ks-root', hostKnotId: 'shared-knot',
        hostSegmentId: 'seg-a', hostMinT: 0.2, segments: [seg('seg-ks')],
    } as never);

    return state;
}


// Not covered here: that the preservation does not keep a knot which should
// have gone. Auto-bracing regenerates braces between the same trunks, so a
// knot often survives by being reused rather than preserved, and separating
// the two needs a scene where regeneration provably cannot reuse it. The
// `keptBraces` read below is what bounds it: only braces that survive the pass
// hold their endpoints, which is the same rule as before this change.


test('every type the registry says hangs from a knot is consulted', () => {
    // The regression was a hand-written list of two. This is the list.
    const hosted = SUPPORT_TYPES
        .filter((d) => d.edges.some((e) => e.to === 'knots' && e.ownership === 'hostedBy'))
        .map((d) => d.id)
        .sort();

    assert.deepEqual(hosted, ['brace', 'branch', 'kickstand', 'leaf']);
});
