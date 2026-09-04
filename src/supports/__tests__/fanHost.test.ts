import assert from 'node:assert/strict';
import test from 'node:test';

import { pickFanHost, leafPathCrossesSupports, collectFanShaftPoints, fanLeafToTrunk, findMergeHost, buildConsolidationBranch, type FanShaftPoint } from '../autoSupport/autoPlace';
import type { SupportState } from '../types';

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, knots: {},
        selectedId: null, selectedCategory: null,
        hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    };
}

function trunkWithShaft(trunkId: string, x: number, y: number, z0: number, z1: number, diameter = 1): SupportState {
    const s = emptySnapshot();
    s.trunks[trunkId] = {
        id: trunkId,
        modelId: 'm',
        rootId: `r-${trunkId}`,
        segments: [{
            id: `seg-${trunkId}`,
            diameter,
            bottomJoint: { id: `${trunkId}-b`, pos: { x, y, z: z0 }, diameter: diameter + 0.2 },
            topJoint: { id: `${trunkId}-t`, pos: { x, y, z: z1 }, diameter: diameter + 0.2 },
        }],
    };
    return s;
}

const sp = (trunkId: string, x: number, y: number, z: number): FanShaftPoint => ({
    trunkId,
    pos: { x, y, z },
    diameter: 1,
});

const REGULAR_FAN = 5;
const GRID_FAN = 2.5;

test('nearest shaft wins', () => {
    const points = [sp('t1', 0, 0, 10), sp('t2', 6, 0, 10)];
    const picked = pickFanHost(points, new Set(), { x: 1, y: 0, z: 10 }, REGULAR_FAN, GRID_FAN);
    assert.equal(picked?.sp.trunkId, 't1');
});

test('grid trunk hosts fans when close enough (tight radius)', () => {
    const grid = new Set(['g1']);
    const points = [sp('g1', 0, 0, 10), sp('r1', 8, 0, 10)];
    const picked = pickFanHost(points, grid, { x: 2, y: 0, z: 10 }, REGULAR_FAN, GRID_FAN);
    assert.equal(picked?.sp.trunkId, 'g1', '2mm from the grid shaft → attach to the grid trunk');
});

test('falls back to the nearest regular trunk when the grid host is too far', () => {
    const grid = new Set(['g1']);
    const points = [sp('g1', 0, 0, 10), sp('r1', 4, 0, 10)];
    // Target 3mm from the grid shaft (> 2.5 tight cap) but 1mm from a
    // regular trunk — the long grid-host leaf is refused, the regular host wins.
    const picked = pickFanHost(points, grid, { x: 3, y: 0, z: 10 }, REGULAR_FAN, GRID_FAN);
    assert.equal(picked?.sp.trunkId, 'r1');
});

test('no host qualifies within the radii', () => {
    const grid = new Set(['g1']);
    const points = [sp('g1', 0, 0, 10), sp('r1', 9, 0, 10)];
    // 3mm from the grid shaft (beyond the tight cap) and 6mm from the
    // regular shaft (beyond the regular fan radius) → nothing.
    assert.equal(pickFanHost(points, grid, { x: 3, y: 0, z: 10 }, REGULAR_FAN, GRID_FAN), null);
});

test('regular fan radius still bounds non-grid hosts', () => {
    const points = [sp('t1', 0, 0, 10)];
    assert.equal(pickFanHost(points, new Set(), { x: 6, y: 0, z: 10 }, REGULAR_FAN, GRID_FAN), null);
});

test('leaf crossing another trunk shaft is detected', () => {
    // Host trunk at x=0; a fan from its shaft (0,0,5) to an island at (0,0,25)
    // passes straight through a second trunk at x=0, z 8..20.
    const draft = trunkWithShaft('host', 0, 0, 1, 30);
    draft.trunks['other'] = {
        id: 'other',
        modelId: 'm',
        rootId: 'r-other',
        segments: [{
            id: 'seg-other',
            diameter: 1,
            bottomJoint: { id: 'o-b', pos: { x: 0, y: 0, z: 8 }, diameter: 1.2 },
            topJoint: { id: 'o-t', pos: { x: 0, y: 0, z: 20 }, diameter: 1.2 },
        }],
    };

    assert.equal(
        leafPathCrossesSupports({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 25 }, 0.25, draft, 'host'),
        true,
        'the fan path passes through the other trunk shaft',
    );
});

test('leaf beside another trunk does not cross', () => {
    // The second trunk is 5mm away in X — the vertical fan stays clear.
    const draft = trunkWithShaft('host', 0, 0, 1, 30);
    draft.trunks['other'] = {
        id: 'other',
        modelId: 'm',
        rootId: 'r-other',
        segments: [{
            id: 'seg-other',
            diameter: 1,
            bottomJoint: { id: 'o-b', pos: { x: 5, y: 0, z: 8 }, diameter: 1.2 },
            topJoint: { id: 'o-t', pos: { x: 5, y: 0, z: 20 }, diameter: 1.2 },
        }],
    };

    assert.equal(
        leafPathCrossesSupports({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 25 }, 0.25, draft, 'host'),
        false,
        '5mm clearance is beyond leaf radius + shaft radius',
    );
});

test('host trunk itself is excluded from the crossing check', () => {
    const draft = trunkWithShaft('host', 0, 0, 1, 30);
    assert.equal(
        leafPathCrossesSupports({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 25 }, 0.25, draft, 'host'),
        false,
        'the leaf attaches to its own shaft — never flagged',
    );
});

test('collectFanShaftPoints samples every segment endpoint', () => {
    const draft = trunkWithShaft('t1', 0, 0, 0, 19);
    const points = collectFanShaftPoints(draft);

    assert.equal(points.length, 11, '10 samples + the top endpoint');
    const zs = points.map((p) => Math.round(p.pos.z * 10) / 10);
    assert.deepEqual(zs, [0, 1.9, 3.8, 5.7, 7.6, 9.5, 11.4, 13.3, 15.2, 17.1, 19]);
    assert.ok(points.every((p) => p.trunkId === 't1'));
});

test('buildConsolidationBranch attaches a routed branch to a host shaft', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    const pool = collectFanShaftPoints(draft);
    const result = buildConsolidationBranch({
        tip: { x: 3, y: 0, z: 15 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        pool,
        pruned: draft,
        mesh: undefined,
        radiusMm: 8,
        maxAttachments: 12,
        knotId: 'con-branch-1',
    });
    assert.ok(result, 'branch built on the host shaft');
    if (result) {
        assert.equal(Object.keys(result.draft.branches).length, 1, 'one branch');
        assert.equal(Object.keys(result.draft.knots).length, 1, 'one knot');
        const branch = Object.values(result.draft.branches)[0];
        assert.equal(branch.origin, 'overhang', 'branch carries the overhang origin');
    }
});

test('collectFanShaftPoints excludes anchor-origin trunks', () => {
    // Anchors are load-bearing standalone pillars — never fan hosts.
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    draft.trunks['anchor'] = {
        id: 'anchor',
        modelId: 'm',
        rootId: 'r-anchor',
        origin: 'anchor',
        segments: [{
            id: 'seg-anchor',
            diameter: 1,
            bottomJoint: { id: 'a-b', pos: { x: 10, y: 0, z: 0 }, diameter: 1.2 },
            topJoint: { id: 'a-t', pos: { x: 10, y: 0, z: 19 }, diameter: 1.2 },
        }],
    };
    const points = collectFanShaftPoints(draft);
    assert.ok(points.length > 0, 'regular trunks still provide shaft points');
    assert.ok(points.every((p) => p.trunkId === 'host'),
        'anchor-origin trunks are not in the fan host pool');
});

test('findMergeHost never returns an anchor-origin trunk', () => {
    // A tip 0.5 mm from the anchor shaft's bottom joint would merge without
    // the exclusion (joint within the 4 mm radius) — with it, no host.
    const draft = trunkWithShaft('island', 0, 0, 0, 19);
    draft.trunks['anchor'] = {
        id: 'anchor',
        modelId: 'm',
        rootId: 'r-anchor',
        origin: 'anchor',
        segments: [{
            id: 'seg-anchor',
            diameter: 1,
            bottomJoint: { id: 'a-b', pos: { x: 10, y: 0, z: 0 }, diameter: 1.2 },
            topJoint: { id: 'a-t', pos: { x: 10, y: 0, z: 19 }, diameter: 1.2 },
        }],
    };
    assert.equal(findMergeHost({ x: 10.5, y: 0, z: 3 }, 'm', draft), null,
        'anchor trunks are not merge hosts');
    const islandHost = findMergeHost({ x: 0.5, y: 0, z: 3 }, 'm', draft);
    assert.ok(islandHost && islandHost.trunkId === 'island',
        'a regular island trunk in range still hosts merges');
});

test('fanLeafToTrunk attaches a leaf at reach beyond the merge radius', () => {
    // Target 4.3 mm from the shaft: outside the 4 mm gridless merge radius,
    // inside the 5 mm fan radius, valid angle — the fan path is the only way
    // this becomes a leaf instead of a standalone trunk.
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    const shaftPoints = [sp('host', 0, 0, 12.5)];
    const target = { x: 4.3, y: 0, z: 15 };

    const fan = fanLeafToTrunk(target, 'm', shaftPoints, new Set(), 'fan-test', 5, 2.5, 60, 12, draft, undefined);

    assert.equal(fan.ok, true, 'fan succeeds (4.3 mm < 5 mm fan radius)');
    if (fan.ok) {
        assert.equal(fan.trunkId, 'host');
        assert.equal(Object.keys(fan.draft.leaves).length, 1, 'one leaf attached');
        assert.equal(Object.keys(fan.draft.knots).length, 1, 'knot attached to the shaft');
        const knot = Object.values(fan.draft.knots)[0];
        assert.ok(knot.diameter !== undefined && Math.abs(knot.diameter - (1.0 + 0.125)) < 1e-9,
            `knot data sizes to render at the trunk-joint diameter (${knot.diameter}, renders 1.025)`);
    }
});

test('fanLeafToTrunk refuses when no shaft is in range', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    const fan = fanLeafToTrunk(
        { x: 20, y: 0, z: 15 }, 'm', [sp('host', 0, 0, 12.5)], new Set(), 'fan-test', 5, 2.5, 60, 12, draft, undefined,
    );

    assert.equal(fan.ok, false);
    if (!fan.ok) assert.equal(fan.reason, 'noHost');
});

test('fanLeafToTrunk refuses steep angles', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    const fan = fanLeafToTrunk(
        // 2 mm vertical drop, 4.3 mm lateral → 65° — steeper than the limit.
        { x: 4.3, y: 0, z: 13 }, 'm', [sp('host', 0, 0, 11)], new Set(), 'fan-test', 5, 2.5, 60, 12, draft, undefined,
    );

    assert.equal(fan.ok, false);
    if (!fan.ok) assert.equal(fan.reason, 'angle');
});

test('fanLeafToTrunk prefers the steepest sample over the nearest', () => {
    // Two eligible samples on one shaft: a shallow one just below the tip
    // (nearest — the old code picked this, the "knot at the junction" look)
    // and a deep one at a steep rise. The steep one must win.
    const draft = trunkWithShaft('host', 0, 0, 0, 19);
    const fan = fanLeafToTrunk(
        { x: 2, y: 0, z: 15 }, 'm',
        [sp('host', 0, 0, 13.7), sp('host', 0, 0, 11.0)],
        new Set(), 'fan-test', 5, 2.5, 60, 12, draft, undefined,
    );

    assert.equal(fan.ok, true, 'steep sample is within the fan radius');
    if (fan.ok) {
        const knot = Object.values(fan.draft.knots)[0];
        assert.ok(Math.abs(knot.pos.z - 11.0) < 1e-6,
            `knot snapped to the steep sample (z=${knot.pos.z})`);
        assert.ok(Math.abs(fan.angleDeg - 26.565) < 0.01,
            `reports the steep angle (${fan.angleDeg.toFixed(2)}°)`);
    }
});
