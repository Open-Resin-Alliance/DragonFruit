import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { addTargetedStressBraces, BRACE_CANOPY_KEEP_OUT_MM } from '../autoBracing/autoBrace';
import { buttressTrunkWithKickstand, promoteOverloadedLeaf } from '../autoSupport/autoPlace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';

function twoTrunks(distanceMm = 5): SupportState {
    const cone = (x: number, id: string) => ({
        id,
        pos: { x, y: 0, z: 22 },
        normal: { x: 0, y: 0, z: -1 },
        profile: {
            type: 'disk' as const,
            contactDiameterMm: 0.3,
            bodyDiameterMm: 1.0,
            lengthMm: 2.5,
            penetrationMm: 0,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
        },
    });
    const trunk = (id: string, x: number, rootId: string, segId: string) => ({
        id,
        modelId: 'model-a',
        rootId,
        segments: [{
            id: segId,
            diameter: 1.0,
            bottomJoint: { id: `${segId}-b`, pos: { x, y: 0, z: 1 }, diameter: 1.0 },
            topJoint: { id: `${segId}-t`, pos: { x, y: 0, z: 20 }, diameter: 1.0 },
        }],
        contactCone: cone(x, `${id}-c`),
    });
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rA: { id: 'rA', modelId: 'model-a', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 },
            rB: { id: 'rB', modelId: 'model-a', transform: { pos: { x: distanceMm, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 },
        },
        trunks: {
            tA: trunk('tA', 0, 'rA', 'sA'),
            tB: trunk('tB', distanceMm, 'rB', 'sB'),
        },
    } as never;
}

test('a targeted stress brace spans the two requested supports with knots on their shafts', () => {
    const settings = createDefaultAutoBracingSettings();
    const result = addTargetedStressBraces(
        twoTrunks(),
        [{ aEntityId: 'tA', bEntityId: 'tB', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(result.changed, true);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
    assert.equal(Object.keys(result.snapshot.braces).length, 1);
    assert.equal(Object.keys(result.snapshot.knots).length, 2);
    const brace = Object.values(result.snapshot.braces)[0]!;
    const start = result.snapshot.knots[brace.startKnotId]!;
    const end = result.snapshot.knots[brace.endKnotId]!;
    assert.equal(start.parentShaftId, 'sA');
    assert.equal(end.parentShaftId, 'sB');
    assert.ok(Math.abs(start.pos.z - 5) < 1e-9, `low knot at requested height, got ${start.pos.z}`);
    assert.ok(Math.abs(end.pos.z - start.pos.z) < 1e-9, 'a lateral tie is horizontal at the layer');
});

test('a second pass does not duplicate the same brace', () => {
    const settings = createDefaultAutoBracingSettings();
    const first = addTargetedStressBraces(
        twoTrunks(),
        [{ aEntityId: 'tA', bEntityId: 'tB', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );
    const second = addTargetedStressBraces(
        first.snapshot,
        [{ aEntityId: 'tA', bEntityId: 'tB', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(second.added, 0);
    assert.equal(second.reasons.duplicate, 1);
    assert.equal(Object.keys(second.snapshot.braces).length, 1);
});

test('a member action finds a nearby host when no explicit partner is given', () => {
    const settings = createDefaultAutoBracingSettings();
    const result = addTargetedStressBraces(
        twoTrunks(4),
        [{ aEntityId: 'tA', atZMm: 6, near: { x: 0, y: 0, z: 10 } }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(result.added, 1);
    assert.equal(Object.keys(result.snapshot.braces).length, 1);
});

test('no partner within the brace length is skipped, not invented', () => {
    const settings = { ...createDefaultAutoBracingSettings(), maxBraceLengthMm: 1 };
    const result = addTargetedStressBraces(
        twoTrunks(8),
        [{ aEntityId: 'tA', atZMm: 5, near: { x: 0, y: 0, z: 5 } }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(result.added, 0);
    assert.equal(result.changed, false);
    assert.equal(result.reasons.noHost, 1);
});

test('an unknown entity is reported instead of creating an orphan brace', () => {
    const result = addTargetedStressBraces(
        twoTrunks(),
        [{ aEntityId: 'missing', bEntityId: 'tB', atZMm: 5 }],
        createDefaultAutoBracingSettings(),
        new Set(['model-a']),
    );

    assert.equal(result.added, 0);
    assert.equal(result.reasons.noEndpoints, 1);
    assert.equal(Object.keys(result.snapshot.knots).length, 0);
});

test('an overloaded leaf is promoted to a branch on the same host knot', () => {
    const snapshot = twoTrunks();
    const withLeaf = {
        ...snapshot,
        knots: {
            k1: { id: 'k1', parentShaftId: 'sA', t: 0.5, pos: { x: 0, y: 0, z: 10 }, diameter: 1 },
        },
        leaves: {
            l1: {
                id: 'l1',
                modelId: 'model-a',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'l1-c',
                    pos: { x: 0.2, y: 0, z: 15 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: {
                        type: 'disk' as const,
                        contactDiameterMm: 0.3,
                        bodyDiameterMm: 1.0,
                        lengthMm: 2.5,
                        penetrationMm: 0,
                        diskThicknessMm: 0.1,
                        maxStandoffMm: 1.5,
                        standoffAngleThreshold: Math.PI / 4,
                    },
                },
            },
        },
    } as never;

    const result = promoteOverloadedLeaf(withLeaf, 'l1', undefined, {});

    assert.equal(result.promoted, true, result.reason);
    assert.equal(Object.keys(result.draft.leaves).length, 0, 'leaf removed');
    assert.equal(Object.keys(result.draft.branches).length, 1, 'branch added');
    const branch = Object.values(result.draft.branches)[0]!;
    assert.equal(branch.parentKnotId, 'k1', 'same host knot');
    assert.ok(branch.segments.length > 0, 'branch has a real shaft');
});

test('promotion reports a missing leaf instead of mutating the draft', () => {
    const snapshot = twoTrunks();
    const result = promoteOverloadedLeaf(snapshot, 'missing', undefined, {});
    assert.equal(result.promoted, false);
    assert.equal(result.reason, 'missingLeaf');
    assert.equal(result.draft, snapshot);
});

test('a leaf pair resolves to the support trees that host it', () => {
    const base = twoTrunks(5);
    const withLeaves: SupportState = {
        ...base,
        knots: {
            kA: { id: 'kA', parentShaftId: 'sA', pos: { x: 0, y: 0, z: 12 }, diameter: 1 },
            kB: { id: 'kB', parentShaftId: 'sB', pos: { x: 5, y: 0, z: 12 }, diameter: 1 },
        },
        leaves: {
            leafA: {
                id: 'leafA', modelId: 'model-a', parentKnotId: 'kA',
                contactCone: { id: 'cA', pos: { x: 0, y: 0, z: 20 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 0.9, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            },
            leafB: {
                id: 'leafB', modelId: 'model-a', parentKnotId: 'kB',
                contactCone: { id: 'cB', pos: { x: 5, y: 0, z: 20 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 0.9, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            },
        },
    };
    const settings = createDefaultAutoBracingSettings();
    const result = addTargetedStressBraces(
        withLeaves,
        [{ aEntityId: 'leafA', bEntityId: 'leafB', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(result.added, 1);
    assert.equal(result.reasons.noEndpoints ?? 0, 0);
    const brace = Object.values(result.snapshot.braces)[0]!;
    const start = result.snapshot.knots[brace.startKnotId]!;
    const end = result.snapshot.knots[brace.endKnotId]!;
    assert.deepEqual([start.parentShaftId, end.parentShaftId].sort(), ['sA', 'sB']);
});


test('a targeted brace stays below the contact canopy', () => {
    const result = addTargetedStressBraces(
        twoTrunks(),
        [{ aEntityId: 'tA', bEntityId: 'tB', atZMm: 19.8 }],
        createDefaultAutoBracingSettings(),
        new Set(['model-a']),
    );
    assert.equal(result.added, 1);
    const brace = Object.values(result.snapshot.braces)[0]!;
    for (const knotId of [brace.startKnotId, brace.endKnotId]) {
        const knot = result.snapshot.knots[knotId]!;
        assert.ok(knot.pos.z <= 20 - BRACE_CANOPY_KEEP_OUT_MM + 1e-6,
            `brace knot ${knot.pos.z.toFixed(2)} stays ${BRACE_CANOPY_KEEP_OUT_MM}mm below the shaft top`);
    }
});

test('braces meeting the same shaft at the same rung share one knot', () => {
    const base = twoTrunks(4) as unknown as {
        roots: Record<string, unknown>;
        trunks: Record<string, unknown>;
    };
    const withThird = {
        ...(base as object),
        roots: {
            ...base.roots,
            rC: { id: 'rC', modelId: 'model-a', transform: { pos: { x: -4, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 },
        },
        trunks: {
            ...base.trunks,
            tC: {
                id: 'tC', modelId: 'model-a', rootId: 'rC',
                segments: [{
                    id: 'sC', diameter: 1.0,
                    bottomJoint: { id: 'sC-b', pos: { x: -4, y: 0, z: 1 }, diameter: 1.0 },
                    topJoint: { id: 'sC-t', pos: { x: -4, y: 0, z: 20 }, diameter: 1.0 },
                }],
                contactCone: {
                    id: 'tC-c', pos: { x: -4, y: 0, z: 22 }, normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            },
        },
    } as never;
    const settings = createDefaultAutoBracingSettings();

    const first = addTargetedStressBraces(
        withThird,
        [{ aEntityId: 'tA', bEntityId: 'tB', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );
    const second = addTargetedStressBraces(
        first.snapshot,
        [{ aEntityId: 'tA', bEntityId: 'tC', atZMm: 5 }],
        settings,
        new Set(['model-a']),
    );

    assert.equal(second.added, 1);
    const knotsOnA = Object.values(second.snapshot.knots).filter((k) => k.parentShaftId === 'sA');
    assert.equal(knotsOnA.length, 1, 'both braces meet A at one shared knot');
    const braces = Object.values(second.snapshot.braces);
    assert.equal(braces.length, 2);
    const sharedId = knotsOnA[0].id;
    assert.equal(
        braces.filter((b) => b.startKnotId === sharedId || b.endKnotId === sharedId).length,
        2,
        'both braces reference the shared knot',
    );
});


test('a trunk with no brace host gets a plate kickstand at a buttress angle', () => {
    const snapshot = twoTrunks();
    const result = buttressTrunkWithKickstand(snapshot, 'model-a', 'tA', 8);
    assert.equal(result.added, true, 'a buttress is added');
    const kickstand = Object.values(result.draft.kickstands)[0]!;
    assert.equal(kickstand.hostSegmentId, 'sA');
    const knot = result.draft.knots[kickstand.hostKnotId]!;
    assert.equal(knot.parentShaftId, 'sA');
    assert.ok(knot.pos.z <= 20 - 2.5 + 1e-6, 'the host knot stays below the canopy');
    const root = result.draft.roots[kickstand.rootId]!;
    const run = Math.hypot(root.transform.pos.x - knot.pos.x, root.transform.pos.y - knot.pos.y);
    const rise = knot.pos.z - root.transform.pos.z;
    const angleFromVertical = (Math.atan2(run, rise) * 180) / Math.PI;
    assert.ok(angleFromVertical >= 25 && angleFromVertical <= 50,
        `buttress leans 30-45° from vertical (got ${angleFromVertical.toFixed(1)}°)`);

    const again = buttressTrunkWithKickstand(result.draft, 'model-a', 'tA', 8);
    assert.equal(again.added, false, 'one buttress per trunk');
});

test('a capped-shaft strut can reach past the normal brace length', () => {
    const settings = createDefaultAutoBracingSettings();
    const narrow = { ...settings, maxBraceLengthMm: 8 };
    const result = addTargetedStressBraces(
        twoTrunks(12),
        [{ aEntityId: 'tA', atZMm: 8, near: { x: 0, y: 0, z: 8 }, maxSpanMm: 16 }],
        narrow,
        new Set(['model-a']),
    );
    assert.equal(result.added, 1, 'extended reach finds the 12mm neighbour');
    assert.equal(Object.keys(result.snapshot.braces).length, 1);
});

test('a capped shaft may take a second opposing kickstand strut, never a third', () => {
    const first = buttressTrunkWithKickstand(twoTrunks(), 'model-a', 'tA', 8);
    assert.equal(first.added, true);
    const second = buttressTrunkWithKickstand(first.draft, 'model-a', 'tA', 8, undefined, { allowAdditional: true });
    assert.equal(second.added, true, 'the second plate strut is allowed');
    assert.equal(Object.keys(second.draft.kickstands).length, 2);
    const third = buttressTrunkWithKickstand(second.draft, 'model-a', 'tA', 8, undefined, { allowAdditional: true });
    assert.equal(third.added, false, 'never more than two');
});
