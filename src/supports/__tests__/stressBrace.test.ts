import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { addTargetedStressBraces } from '../autoBracing/autoBrace';
import { promoteOverloadedLeaf } from '../autoSupport/autoPlace';
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
