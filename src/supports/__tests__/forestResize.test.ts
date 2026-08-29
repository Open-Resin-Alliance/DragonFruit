import assert from 'node:assert/strict';
import test from 'node:test';

import { computeForestDiameterProfile } from '../SupportTypes/Trunk/TrunkReplacement/maxConnectedDiameter';
import type { Branch, Knot, Roots, SupportState, Trunk } from '../types';

function createRoot(id: string, modelId: string, x: number, y = 0): Roots {
    return {
        id,
        modelId,
        transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function createTrunk(id: string, modelId: string, rootId: string, segmentId: string, x: number, y = 0, topZ = 10, shaftDia = 0.8): Trunk {
    return {
        id,
        modelId,
        rootId,
        segments: [
            {
                id: segmentId,
                diameter: shaftDia,
                bottomJoint: { id: `${segmentId}-bottom`, pos: { x, y, z: 1 }, diameter: shaftDia + 0.2 },
                topJoint: { id: `${segmentId}-top`, pos: { x, y, z: topZ }, diameter: shaftDia + 0.2 },
            },
        ],
    };
}

function createBranch(id: string, modelId: string, parentKnotId: string, diameter: number): Branch {
    return {
        id,
        modelId,
        parentKnotId,
        segments: [{ id: `${id}-seg`, diameter }],
    };
}

function createEmptySnapshot(): SupportState {
    return {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        anchors: {},
        knots: {},
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };
}

test('lone trunk keeps its placed diameter', () => {
    const s = createEmptySnapshot();
    s.roots['r1'] = createRoot('r1', 'm', 0);
    s.trunks['t1'] = createTrunk('t1', 'm', 'r1', 'seg-1', 0, 0, 10, 0.8);

    const resized = computeForestDiameterProfile(s);
    assert.equal(resized.trunks['t1'].segments[0].diameter, 0.8, 'no branches → no thickening');
});

test('a trunk carrying four branches thickens to the branch diameter below the knots', () => {
    const s = createEmptySnapshot();
    s.roots['r1'] = createRoot('r1', 'm', 0);
    s.trunks['t1'] = createTrunk('t1', 'm', 'r1', 'seg-1', 0, 0, 10, 0.8);

    const knot: Knot = { id: 'k1', parentShaftId: 'seg-1', t: 0.5, pos: { x: 0, y: 0, z: 5.5 }, diameter: 1.0 };
    s.knots['k1'] = knot;
    for (let i = 0; i < 4; i++) {
        s.branches[`b${i}`] = createBranch(`b${i}`, 'm', 'k1', 1.0);
    }

    const resized = computeForestDiameterProfile(s);
    const segments = resized.trunks['t1'].segments;
    assert.ok(segments.length >= 2, `shaft split at the branch knot (${segments.length} segments)`);
    // Bottom segment (below the 1.0mm branch attachments) matches the
    // fattest member — no per-attachment growth (a count-based bulge read
    // as a thick shaft under a thin canopy on uniform chunk trees).
    assert.equal(segments[0].diameter, 1.0, 'below the branch knots → branch demand');
    assert.equal(segments[segments.length - 1].diameter, 0.8, 'tip section stays at placed diameter');

    // The knot is rehosted onto the split segment at t=1 without moving.
    const k = resized.knots['k1'];
    assert.ok(k, 'knot survives');
    assert.equal(k.t, 1);
    assert.deepEqual(k.pos, { x: 0, y: 0, z: 5.5 }, 'knot position unchanged');
});

test('a trunk hosting fan leaves thickens to the leaf diameter', () => {
    const s = createEmptySnapshot();
    s.roots['r1'] = createRoot('r1', 'm', 0);
    s.trunks['t1'] = createTrunk('t1', 'm', 'r1', 'seg-1', 0, 0, 10, 0.8);

    // Auto fan/merge knots carry no `t` — the demand must still apply to
    // the knot's segment.
    s.knots['k1'] = { id: 'k1', parentShaftId: 'seg-1', pos: { x: 0, y: 0, z: 5.5 }, diameter: 0.9 };
    for (let i = 0; i < 4; i++) {
        s.leaves[`l${i}`] = {
            id: `l${i}`,
            modelId: 'm',
            parentKnotId: 'k1',
            contactCone: {
                id: `cone-${i}`,
                pos: { x: 0, y: 0, z: 8 },
                normal: { x: 0, y: 0, z: 1 },
                profile: {
                    type: 'disk',
                    contactDiameterMm: 0.4,
                    bodyDiameterMm: 1.0,
                    lengthMm: 2.5,
                    penetrationMm: 0,
                    diskThicknessMm: 0.1,
                    maxStandoffMm: 1.5,
                    standoffAngleThreshold: Math.PI / 4,
                },
            },
        };
    }

    const resized = computeForestDiameterProfile(s);
    const trunk = resized.trunks['t1'];
    assert.ok(trunk.segments.every((seg) => seg.diameter >= 1.0 - 1e-9),
        `leaf host thickens to the leaf body diameter (${trunk.segments[0].diameter})`);
});

test('forest resize is deterministic and pure', () => {
    const make = () => {
        const s = createEmptySnapshot();
        s.roots['r1'] = createRoot('r1', 'm', 0);
        s.trunks['t1'] = createTrunk('t1', 'm', 'r1', 'seg-1', 0, 0, 10, 0.8);
        s.knots['k1'] = { id: 'k1', parentShaftId: 'seg-1', t: 0.5, pos: { x: 0, y: 0, z: 5.5 }, diameter: 1.0 };
        s.branches['b1'] = createBranch('b1', 'm', 'k1', 1.0);
        return s;
    };

    const a = computeForestDiameterProfile(make());
    const b = computeForestDiameterProfile(make());
    // Segment ids from the split are UUIDs — determinism is geometric.
    const stripIds = (o: unknown): string => JSON.stringify(o, (k, v) => (k === 'id' ? undefined : v));
    assert.equal(stripIds(a), stripIds(b));

    // The input snapshot is untouched (pure).
    const input = make();
    const inputSegDia = input.trunks['t1'].segments[0].diameter;
    computeForestDiameterProfile(input);
    assert.equal(input.trunks['t1'].segments[0].diameter, inputSegDia, 'input not mutated');
});
