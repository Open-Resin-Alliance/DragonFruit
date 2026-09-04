import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getResolvedChainMetrics,
    isResolvedChainReplacementBetter,
    simplifyJointsSDF,
} from '../PlacementLogic/Pathfinding/SmartPlacementV2';
import type { Vec3 } from '../types';

const socketPos: Vec3 = { x: 0, y: 0, z: 12 };
const rootTopTarget: Vec3 = { x: 3, y: 0, z: 2 };

test('resolved-chain comparison prefers fewer joints when the upper-span angle stays within limits', () => {
    const routed = getResolvedChainMetrics(
        socketPos,
        [
            { x: 0.2, y: 0, z: 8.5 },
            { x: 2.2, y: 0, z: 5 },
        ],
        rootTopTarget,
    );
    const straight = getResolvedChainMetrics(socketPos, [], rootTopTarget);

    // Weighted scorer: dropping both joints saves the exponential joint
    // penalty (2.5²·20 vs 20), which outweighs the steeper first segment
    // (16.7° vs 3.3°) as long as it stays within the angle limit.
    assert.equal(isResolvedChainReplacementBetter(straight, routed), true);
    assert.equal(isResolvedChainReplacementBetter(routed, straight), false);
});

test('resolved-chain comparison still allows fewer joints when upper-span quality is not worsened', () => {
    const current = getResolvedChainMetrics(
        socketPos,
        [{ x: 0.1, y: 0, z: 7 }],
        { x: 0.2, y: 0, z: 2 },
    );
    const straighter = getResolvedChainMetrics(socketPos, [], { x: 0.15, y: 0, z: 2 });

    assert.equal(isResolvedChainReplacementBetter(straighter, current), true);
});

test('simplifyJointsSDF collapses clear zig-zag joint clusters', () => {
    const sdf = {
        segmentBlocked: () => false,
    } as any;

    const simplified = simplifyJointsSDF(
        [
            { x: 0.8, y: 0, z: 9 },
            { x: 0.2, y: 0, z: 7 },
            { x: 0.35, y: 0, z: 5 },
        ],
        socketPos,
        { x: 0.25, y: 0, z: 2 },
        sdf,
        0.5,
        80,
    );

    assert.deepEqual(simplified, []);
});

test('simplifyJointsSDF collapses to the joint balancing joints against first-segment angle', () => {
    const sdf = {
        segmentBlocked: () => false,
    } as any;

    // The early upper-span joint (0.2,0,8.5) and the middle joint are
    // collapsed: each removal saves the exponential joint penalty while the
    // first-segment angle stays within the limit. The last joint (1.8,0,3.8)
    // is kept because removing it would steepen the first segment past what
    // the joint savings are worth.
    const simplified = simplifyJointsSDF(
        [
            { x: 0.2, y: 0, z: 8.5 },
            { x: 2.2, y: 0, z: 5 },
            { x: 1.8, y: 0, z: 3.8 },
        ],
        socketPos,
        { x: 4, y: 0, z: 2 },
        sdf,
        0.5,
        80,
    );

    assert.deepEqual(simplified, [{ x: 1.8, y: 0, z: 3.8 }]);
});
