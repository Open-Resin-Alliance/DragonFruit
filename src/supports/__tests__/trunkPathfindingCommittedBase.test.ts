import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNearestCandidateNodeKeys } from '../PlacementLogic/Grid/nearestCandidateNodeKeys';
import { resolveCommittedBaseCandidate } from '../PlacementLogic/Pathfinding/SmartPlacementV2';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';

function makeOpenSdf(overrides?: Partial<Pick<SDFCache, 'distanceAt' | 'isBlocked' | 'segmentBlocked'>>): SDFCache {
    return {
        cellSize: 0.5,
        distanceAt: () => Infinity,
        isBlocked: () => false,
        segmentBlocked: () => false,
        ...overrides,
    } as SDFCache;
}

test('resolveCommittedBaseCandidate falls through to a farther snapped node when the nearest base is blocked', () => {
    const sdf = makeOpenSdf({
        distanceAt: (x: number, y: number) => (Math.abs(x) < 0.001 && Math.abs(y) < 0.001 ? 0 : Infinity),
    });

    const resolved = resolveCommittedBaseCandidate({
        preferredBottomPos: { x: 0, y: 0, z: 0 },
        lastSegmentStart: { x: 0, y: 0, z: 6 },
        rootTopZ: 3,
        gridEnabled: true,
        spacingMm: 4,
        maxNearestNodeSearchRings: 1,
        sdf,
        diskHeight: 1,
        coneHeight: 2,
        rootsRadius: 1.5,
        shaftRadius: 0.75,
        clearance: 0.8,
        buildNearestCandidateNodeKeys,
    });

    assert.ok(resolved);
    assert.deepEqual(resolved?.basePos, { x: -4, y: 0, z: 0 });
    assert.equal(resolved?.nodeKey, '-1,0');
});

test('resolveCommittedBaseCandidate rejects snapped nodes whose final inbound segment is blocked', () => {
    const sdf = makeOpenSdf({
        segmentBlocked: (_ax: number, _ay: number, _az: number, bx: number) => Math.abs(bx - 4) < 0.001,
    });

    const resolved = resolveCommittedBaseCandidate({
        preferredBottomPos: { x: 0, y: 0, z: 0 },
        lastSegmentStart: { x: 0, y: 0, z: 6 },
        rootTopZ: 3,
        gridEnabled: true,
        spacingMm: 4,
        maxNearestNodeSearchRings: 1,
        sdf,
        diskHeight: 1,
        coneHeight: 2,
        rootsRadius: 1.5,
        shaftRadius: 0.75,
        clearance: 0.8,
        buildNearestCandidateNodeKeys: () => ['1,0'],
    });

    assert.equal(resolved, null);
});

test('resolveCommittedBaseCandidate prefers a farther snapped base when it makes the bottom-most shaft straighter', () => {
    const sdf = makeOpenSdf();

    const resolved = resolveCommittedBaseCandidate({
        preferredBottomPos: { x: 0.2, y: 0, z: 0 },
        lastSegmentStart: { x: 4, y: 0, z: 6 },
        rootTopZ: 3,
        gridEnabled: true,
        spacingMm: 4,
        maxNearestNodeSearchRings: 1,
        sdf,
        diskHeight: 1,
        coneHeight: 2,
        rootsRadius: 1.5,
        shaftRadius: 0.75,
        clearance: 0.8,
        buildNearestCandidateNodeKeys: () => ['0,0', '1,0'],
    });

    assert.ok(resolved);
    assert.deepEqual(resolved?.basePos, { x: 4, y: 0, z: 0 });
    assert.equal(resolved?.inboundLateralMm, 0);
});
