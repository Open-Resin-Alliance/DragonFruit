import assert from 'node:assert/strict';
import test from 'node:test';

import { collectFanShaftPoints, fanLeafToTrunk, rehostLegacyKnots, validateAndCullOrphans } from '../autoSupport/autoPlace';
import type { SupportState } from '../types';

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, knots: {},
        selectedId: null, selectedCategory: null,
        hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;
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
    } as unknown as SupportState['trunks'][string];
    (s as unknown as { roots: Record<string, unknown> }).roots[`r-${trunkId}`] = {
        id: `r-${trunkId}`,
        transform: { pos: { x, y, z: 0 } },
    } as unknown as SupportState['roots'][string];
    return s;
}

test('rehostLegacyKnots converts trunkId parent to segmentId', () => {
    const draft = trunkWithShaft('t1', 0, 0, 0, 10);
    // Legacy knot that points at trunkId, not segment
    (draft.knots as Record<string, unknown>)['k1'] = {
        id: 'k1',
        parentShaftId: 't1',
        pos: { x: 0, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];

    const rehosted = rehostLegacyKnots(draft);
    const knot = rehosted.knots['k1'];
    assert.equal(knot.parentShaftId, 'seg-t1', 'rehosted to segment id');
    assert.ok(typeof knot.t === 'number' && knot.t >= 0 && knot.t <= 1, 't computed');
});

test('fanLeafToTrunk creates knot with segmentId and t (not trunkId)', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 10);
    const pool = collectFanShaftPoints(draft);
    assert.ok(pool.length > 0 && pool[0].segmentId, 'pool has segmentId');
    assert.ok(typeof pool[0].t === 'number', 'pool has t');

    const result = fanLeafToTrunk(
        { x: 1, y: 0, z: 9 },
        'm',
        pool,
        new Set(),
        'knot-test',
        5,
        2.5,
        60,
        10,
        draft,
        undefined,
    );
    assert.equal(result.ok, true, 'leaf should attach');
    if (result.ok) {
        const knot = result.draft.knots['knot-test'];
        assert.ok(knot, 'knot exists');
        assert.equal(knot.parentShaftId, 'seg-host', 'knot parent is segment id, not trunk id');
        assert.ok(typeof knot.t === 'number', 'knot has t');
        // Validate passes (no drift, not missing)
        const validated = validateAndCullOrphans(result.draft, undefined);
        assert.equal(validated.orphans.length, 0, 'valid leaf not orphaned');
        assert.ok(validated.draft.leaves[result.leafId], 'leaf remains after validation');
    }
});

test('validateAndCullOrphans culls drifted knot (>0.5mm off shaft)', () => {
    const draft = trunkWithShaft('t1', 0, 0, 0, 10);
    // Knot drifted 2mm off shaft
    (draft.knots as Record<string, unknown>)['k-drift'] = {
        id: 'k-drift',
        parentShaftId: 'seg-t1',
        t: 0.5,
        pos: { x: 2, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];
    (draft.leaves as Record<string, unknown>)['leaf-drift'] = {
        id: 'leaf-drift',
        modelId: 'm',
        parentKnotId: 'k-drift',
        contactCone: { id: 'c', pos: { x: 2, y: 0, z: 6 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: cleaned, orphans } = validateAndCullOrphans(draft, undefined);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].reason, 'drift');
    assert.equal(cleaned.leaves['leaf-drift'], undefined, 'drifted leaf culled');
    assert.equal(cleaned.knots['k-drift'], undefined, 'drifted knot removed when unused');
});

test('validateAndCullOrphans reports cross but keeps leaf (non-destructive)', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 10);
    // Second trunk that the leaf will cross
    const other = trunkWithShaft('other', 1, 0, 0, 10);
    const merged: SupportState = {
        ...emptySnapshot(),
        trunks: { ...draft.trunks, ...other.trunks },
        roots: { ...(draft.roots as Record<string, unknown>), ...(other.roots as Record<string, unknown>) } as SupportState['roots'],
        knots: {},
        leaves: {},
        branches: {}, twigs: {}, sticks: {}, braces: {}, anchors: {},
        selectedId: null, selectedCategory: null, hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;

    // Knot on host at (0,0,5), leaf tip at (2,0,6) — path passes near other trunk at (1,0)
    (merged.knots as Record<string, unknown>)['k-cross'] = {
        id: 'k-cross',
        parentShaftId: 'seg-host',
        t: 0.5,
        pos: { x: 0, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];
    (merged.leaves as Record<string, unknown>)['leaf-cross'] = {
        id: 'leaf-cross',
        modelId: 'm',
        parentKnotId: 'k-cross',
        contactCone: { id: 'c', pos: { x: 2, y: 0, z: 6 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: kept, orphans } = validateAndCullOrphans(merged, undefined);
    // Cross is reported but not culled (kept for backward compat with existing tests)
    assert.ok(orphans.some((o) => o.reason === 'cross'), 'cross reported');
    assert.ok(kept.leaves['leaf-cross'], 'cross leaf kept (reported, not culled)');
});
