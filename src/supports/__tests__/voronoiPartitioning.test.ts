import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionSupportsWithVoronoi, type VoronoiSupportNode } from '../autoBracing/voronoiPartitioning';

function makeNodes(): VoronoiSupportNode[] {
    // Far apart on purpose: no finite neighbor radius below 100mm connects them.
    return [
        { supportId: 'support-a', modelId: 'model-1', point: { x: 0, y: 0 } },
        { supportId: 'support-b', modelId: 'model-1', point: { x: 100, y: 0 } },
        { supportId: 'support-c', modelId: 'model-1', point: { x: 200, y: 0 } },
    ];
}

// seedSpacingMm is huge so the seed grid contributes a single seed; grouping is
// then driven purely by adjacency + island fallback, which is what the
// NaN-bucket regression corrupts.
const SEED_SETTINGS = { seedSpacingMm: 1000, seedJitterMm: 0 };

test('partitionSupportsWithVoronoi groups nodes within a finite neighbor distance', () => {
    const near: VoronoiSupportNode[] = [
        { supportId: 'support-a', modelId: 'model-1', point: { x: 0, y: 0 } },
        { supportId: 'support-b', modelId: 'model-1', point: { x: 2, y: 0 } },
        { supportId: 'support-c', modelId: 'model-1', point: { x: 4, y: 0 } },
    ];

    const groups = partitionSupportsWithVoronoi(near, { ...SEED_SETTINGS, maxNeighborDistanceMm: 5 });

    assert.deepEqual(groups, [['support-a', 'support-b', 'support-c']]);
});

test('partitionSupportsWithVoronoi keeps distant nodes apart', () => {
    const groups = partitionSupportsWithVoronoi(makeNodes(), { ...SEED_SETTINGS, maxNeighborDistanceMm: 5 });

    assert.equal(groups.length, 3);
    for (const group of groups) assert.equal(group.length, 1);
});

test('partitionSupportsWithVoronoi does not merge distant nodes when maxNeighborDistanceMm is NaN', () => {
    // Regression: NaN used to collapse every node into a single "NaN:NaN"
    // spatial bucket with an always-passing distance filter, connecting the
    // whole model into one adjacency clique (O(N^2) + one giant group).
    const groups = partitionSupportsWithVoronoi(makeNodes(), {
        ...SEED_SETTINGS,
        maxNeighborDistanceMm: Number.NaN,
    });

    assert.equal(groups.length, 3, `expected 3 singleton groups, got ${JSON.stringify(groups)}`);
    for (const group of groups) assert.equal(group.length, 1);
});
