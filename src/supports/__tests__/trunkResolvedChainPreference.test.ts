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

test('resolved-chain comparison prefers a more vertical upper span over fewer joints', () => {
    const routed = getResolvedChainMetrics(
        socketPos,
        [
            { x: 0.2, y: 0, z: 8.5 },
            { x: 2.2, y: 0, z: 5 },
        ],
        rootTopTarget,
    );
    const straight = getResolvedChainMetrics(socketPos, [], rootTopTarget);

    assert.equal(isResolvedChainReplacementBetter(straight, routed), false);
    assert.equal(isResolvedChainReplacementBetter(routed, straight), true);
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

test('simplifyJointsSDF keeps the early upper-span drop while removing lower zig-zag joints', () => {
    const sdf = {
        segmentBlocked: () => false,
    } as any;
    const topPreservingJoint = { x: 0.2, y: 0, z: 8.5 };

    const simplified = simplifyJointsSDF(
        [
            topPreservingJoint,
            { x: 2.2, y: 0, z: 5 },
            { x: 1.8, y: 0, z: 3.8 },
        ],
        socketPos,
        { x: 4, y: 0, z: 2 },
        sdf,
        0.5,
        80,
    );

    assert.deepEqual(simplified, [topPreservingJoint]);
});
