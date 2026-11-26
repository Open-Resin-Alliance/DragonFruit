import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getLastVoronoiSeedMarkers,
    partitionSupportsWithVoronoi,
    type VoronoiSupportNode,
} from '../autoBracing/voronoiPartitioning';

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

test('partitionSupportsWithVoronoi equidistant boundary and island BFS are invariant to UUID strings', () => {
    const diamondPoints = [
        { x: 0, y: 0 },     // 0: seed A
        { x: 2, y: -1.5 },  // 1: neighbor of 0 and 3
        { x: 2, y: 1.5 },   // 2: neighbor of 0 and 3
        { x: 4, y: 0 },     // 3: equidistant 2-hop boundary node between seed A (0,0) and seed B (8,0)
        { x: 8, y: 0 },     // 4: seed B
        { x: 6, y: -1.5 },  // 5: neighbor of 4 and 3
        { x: 6, y: 1.5 },   // 6: neighbor of 4 and 3
    ];

    const runDiamond = (ids: string[]) => {
        const indexById = new Map(ids.map((id, idx) => [id, idx]));
        const nodes: VoronoiSupportNode[] = diamondPoints.map((point, idx) => ({
            supportId: ids[idx],
            modelId: 'model-1',
            point,
        }));
        const groups = partitionSupportsWithVoronoi(nodes, {
            seedSpacingMm: 8,
            seedJitterMm: 0,
            maxNeighborDistanceMm: 3.5,
        });
        const seedIndices = getLastVoronoiSeedMarkers().map((m) => indexById.get(m.supportId));
        const groupIndices = groups.map((g) => g.map((id) => indexById.get(id)));
        return { groupIndices, seedIndices };
    };

    const runSetA = runDiamond([
        'seed-a-0',
        'zzzz-neighbor-a1',
        'yyyy-neighbor-a2',
        'mmmm-boundary-3',
        'seed-b-4',
        '0000-neighbor-b5',
        '1111-neighbor-b6',
    ]);
    const runSetB = runDiamond([
        'seed-a-0',
        '0000-neighbor-a1',
        '1111-neighbor-a2',
        'mmmm-boundary-3',
        'seed-b-4',
        'zzzz-neighbor-b5',
        'yyyy-neighbor-b6',
    ]);

    assert.deepEqual(runSetA.groupIndices, runSetB.groupIndices);
    assert.deepEqual(runSetA.seedIndices, runSetB.seedIndices);

    // Also exercise BFS neighbor order on a symmetric island whose seed comes from
    // island fallback: nodes 2 and 3 are equidistant to centroid (2, 0), so sorting
    // adjacency by raw UUID flips BFS traversal and seed selection.
    const fallbackPoints = [
        { x: -20, y: 0 },  // 0: captures the lone grid seed probe
        { x: -0.5, y: 0 }, // 1: island BFS entry
        { x: 2, y: -2 },   // 2: upper/lower symmetric neighbor (distSq 4 to centroid (2,0))
        { x: 2, y: 2 },    // 3: symmetric neighbor (distSq 4 to centroid (2,0))
        { x: 4.5, y: 0 },  // 4: opposite apex
    ];

    const runFallback = (ids: string[]) => {
        const indexById = new Map(ids.map((id, idx) => [id, idx]));
        const nodes: VoronoiSupportNode[] = fallbackPoints.map((point, idx) => ({
            supportId: ids[idx],
            modelId: 'model-1',
            point,
        }));
        const groups = partitionSupportsWithVoronoi(nodes, {
            seedSpacingMm: 100,
            seedJitterMm: 0,
            maxNeighborDistanceMm: 3.5,
        });
        return {
            groupIndices: groups.map((g) => g.map((id) => indexById.get(id))),
            seedIndices: getLastVoronoiSeedMarkers().map((m) => indexById.get(m.supportId)),
        };
    };

    const fallbackA = runFallback(['anchor-0', 'entry-1', 'zzzz-2', '0000-3', 'apex-4']);
    const fallbackB = runFallback(['anchor-0', 'entry-1', '0000-2', 'zzzz-3', 'apex-4']);
    assert.deepEqual(fallbackA.groupIndices, fallbackB.groupIndices);
    assert.deepEqual(fallbackA.seedIndices, fallbackB.seedIndices);
});

test('partitionSupportsWithVoronoi orders co-located grid nodes deterministically regardless of UUIDs', () => {
    const specs: Array<{ point: { x: number; y: number }; debugPoint?: { x: number; y: number } }> = [
        { point: { x: 4, y: 4 }, debugPoint: { x: 3.8, y: 4.0 } },
        { point: { x: 4, y: 4 }, debugPoint: { x: 4.1, y: 3.9 } },
        { point: { x: 4, y: 4 }, debugPoint: { x: 4.1, y: 3.9 } },
    ];

    const runColocated = (ids: string[]) => {
        const indexById = new Map(ids.map((id, idx) => [id, idx]));
        const nodes: VoronoiSupportNode[] = specs.map((spec, idx) => ({
            supportId: ids[idx],
            modelId: 'model-1',
            point: spec.point,
            debugPoint: spec.debugPoint,
        }));
        const groups = partitionSupportsWithVoronoi(nodes, {
            seedSpacingMm: 8,
            seedJitterMm: 0,
            maxNeighborDistanceMm: 4,
        });
        return {
            groupIndices: groups.map((g) => g.map((id) => indexById.get(id))),
            seedIndices: getLastVoronoiSeedMarkers().map((m) => indexById.get(m.supportId)),
        };
    };

    const orderA = runColocated(['zzzz-1', 'mmmm-2', 'aaaa-3']);
    const orderB = runColocated(['aaaa-1', 'mmmm-2', 'zzzz-3']);

    assert.deepEqual(orderA.groupIndices, orderB.groupIndices);
    assert.deepEqual(orderA.groupIndices, [[0, 1, 2]]);
    assert.deepEqual(orderA.seedIndices, orderB.seedIndices);
});

