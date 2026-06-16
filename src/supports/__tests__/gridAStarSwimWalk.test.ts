import assert from 'node:assert/strict';
import test from 'node:test';

import { gridAStar } from '../PlacementLogic/Pathfinding/GridAStar';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import type { Vec3 } from '../types';

function makeMockSdf(
    isBlockedFn: (x: number, y: number, z: number) => boolean,
    distanceAtFn: (x: number, y: number, z: number) => number
): SDFCache {
    return {
        cellSize: 0.5,
        distanceAt: (x: number, y: number, z: number) => distanceAtFn(x, y, z),
        distanceAtWithin: (x: number, y: number, z: number) => distanceAtFn(x, y, z),
        isBlocked: (x: number, y: number, z: number, clearance?: number) => {
            const cl = clearance ?? 1.0;
            return distanceAtFn(x, y, z) < cl;
        },
        segmentBlocked: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, clearance?: number) => {
            const cl = clearance ?? 1.0;
            const steps = 10;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = ax + (bx - ax) * t;
                const y = ay + (by - ay) * t;
                const z = az + (bz - az) * t;
                if (distanceAtFn(x, y, z) < cl) {
                    return true;
                }
            }
            return false;
        },
    } as unknown as SDFCache;
}

test('gridAStar Swim-Walk: routes through swimming medium above safety clearance but below full clearance', () => {
    // Safety clearance is 0.5, full clearance is 1.0
    // Obstacle fills space between Z=4 and Z=6 except for a narrow channel of distance 0.7 (Swimming Medium)
    const sdf = makeMockSdf(
        () => false,
        (x, y, z) => {
            if (z >= 4.0 && z <= 6.0) {
                // If within x in [-1.0, 1.0], return swimming distance 0.7
                if (Math.abs(x) <= 1.0 && Math.abs(y) <= 1.0) {
                    return 0.7; // Swimming Medium (safety 0.5 <= 0.7 < clearance 1.0)
                }
                return 0.2; // Blocked (below safety 0.5)
            }
            return 5.0; // Open space
        }
    );

    const result = gridAStar(sdf, { x: 0, y: 0, z: 10 }, 0, {
        clearanceMm: 1.0,
        shaftRadius: 0.5,
        maxLateralMm: 15.0,
        maxExpansions: 1000,
        stepMm: 1.0,
        endpointOnlyCollisionCheck: false,
    });

    assert.equal(result.reached, true);
    // Path should exist since it swam through the 0.7 clearance channel
    assert.ok(result.path.length >= 2);
});

test('gridAStar Swim-Walk: rejects paths entering below safety clearance', () => {
    // Safety clearance is 0.5. The channel distance is 0.3 (blocked).
    const sdf = makeMockSdf(
        () => false,
        (x, y, z) => {
            if (z >= 4.0 && z <= 6.0) {
                if (Math.abs(x) <= 1.0 && Math.abs(y) <= 1.0) {
                    return 0.3; // Blocked (below safety 0.5)
                }
                return 0.1;
            }
            return 5.0;
        }
    );

    const result = gridAStar(sdf, { x: 0, y: 0, z: 10 }, 0, {
        clearanceMm: 1.0,
        shaftRadius: 0.5,
        maxLateralMm: 15.0,
        maxExpansions: 1000,
        stepMm: 1.0,
        endpointOnlyCollisionCheck: false,
    });

    assert.equal(result.reached, false);
});

test('gridAStar Swim-Walk: prunes search and drops straight down when reaching running medium', () => {
    // Entire space is open (distance = 5.0). It should immediately drop down.
    const sdf = makeMockSdf(
        () => false,
        () => 5.0
    );

    const result = gridAStar(sdf, { x: 0, y: 0, z: 100 }, 0, {
        clearanceMm: 1.0,
        shaftRadius: 0.5,
        maxLateralMm: 15.0,
        maxExpansions: 1000,
        stepMm: 1.0,
        endpointOnlyCollisionCheck: true,
    });

    assert.equal(result.reached, true);
    // Since it immediately drops straight down from the start node, expansions should be extremely low
    assert.ok(result.expansions <= 5);
});
