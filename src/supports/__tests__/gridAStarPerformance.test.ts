import assert from 'node:assert/strict';
import test from 'node:test';

import { gridAStar } from '../PlacementLogic/Pathfinding/GridAStar';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';

function makeOpenSdf(): SDFCache {
    return {
        cellSize: 0.5,
        distanceAt: () => Infinity,
        distanceAtWithin: () => Infinity,
        isBlocked: () => false,
        segmentBlocked: () => false,
    } as SDFCache;
}

test('gridAStar descends tall clear spans without lateral fan-out', () => {
    const result = gridAStar(makeOpenSdf(), { x: 0, y: 0, z: 160 }, 0, {
        clearanceMm: 0.8,
        maxLateralMm: 72,
        maxExpansions: 10_000,
        stepMm: 0.5,
        endpointOnlyCollisionCheck: true,
    });

    assert.equal(result.reached, true);
    assert.ok(result.expansions <= 45);
    assert.deepEqual(result.path, [
        { x: 0, y: 0, z: 160 },
        { x: 0, y: 0, z: 0 },
    ]);
});
