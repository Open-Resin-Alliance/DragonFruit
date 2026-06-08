import assert from 'node:assert/strict';
import test from 'node:test';

import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import {
    buildTrunkDataFromPlacement,
    type TrunkBuildInput,
} from '../SupportTypes/Trunk/trunkBuilder';

function makeInput(): TrunkBuildInput {
    return {
        tipPos: { x: 0, y: 0, z: 12 },
        tipNormal: { x: 0, y: 0, z: 1 },
        modelId: 'model-1',
        overrides: {
            rootsDiskHeightMm: 1,
            rootsConeHeightMm: 1,
        },
    };
}

function makePlacement(overrides: Partial<TrunkPlacementResult> = {}): TrunkPlacementResult {
    return {
        basePos: { x: 0, y: 0, z: 0 },
        socketPos: { x: 0, y: 0, z: 10 },
        unsnappedBottomPos: { x: 0, y: 0, z: 0 },
        snappedNodeKey: null,
        joints: [],
        constructionJoints: [],
        ...overrides,
    };
}

test('buildTrunkDataFromPlacement preserves solver-authored construction joints', () => {
    const authoredConstruction = [{ x: 0, y: 0, z: 6 }];
    const built = buildTrunkDataFromPlacement(
        makeInput(),
        makePlacement({ constructionJoints: authoredConstruction }),
    );

    assert.deepEqual(built.route.constructionJoints, authoredConstruction);
    assert.equal(built.route.joints.length, 0);
});

test('buildTrunkDataFromPlacement does not invent construction joints for routed supports', () => {
    const routeJoints = [{ x: 1, y: 0, z: 7 }];
    const built = buildTrunkDataFromPlacement(
        makeInput(),
        makePlacement({
            socketPos: { x: 1, y: 0, z: 10 },
            joints: routeJoints,
            constructionJoints: [],
        }),
    );

    assert.deepEqual(built.route.joints, routeJoints);
    assert.deepEqual(built.route.constructionJoints, []);
    assert.equal(built.trunk.segments.length, 2);
});

test('buildTrunkDataFromPlacement still inserts a construction joint for straight supports without one', () => {
    const built = buildTrunkDataFromPlacement(makeInput(), makePlacement());

    assert.equal(built.route.joints.length, 0);
    assert.equal(built.route.constructionJoints.length, 1);
    assert.equal(built.trunk.segments.length, 2);
});

test('buildTrunkDataFromPlacement preserves a solver-authored offset socket in the cone geometry', () => {
    const built = buildTrunkDataFromPlacement(
        makeInput(),
        makePlacement({
            socketPos: { x: 2, y: 0, z: 10 },
        }),
    );

    assert.deepEqual(built.route.socketPos, { x: 2, y: 0, z: 10 });
    assert.equal(built.trunk.contactCone.pos.x, 0);
    assert.equal(built.trunk.contactCone.pos.y, 0);
    assert.equal(built.trunk.contactCone.normal.x > 0, true);
});

    test('buildTrunkDataFromPlacement normalizes routed joints into a strictly rising base-to-socket chain', () => {
        const built = buildTrunkDataFromPlacement(
            makeInput(),
            makePlacement({
                socketPos: { x: 0, y: 0, z: 15 },
                joints: [
                    { x: 0, y: 0, z: 10 },
                    { x: 0, y: 0, z: 5 },
                ],
                constructionJoints: [],
            }),
        );

        assert.deepEqual(built.route.joints, [
            { x: 0, y: 0, z: 5 },
            { x: 0, y: 0, z: 10 },
        ]);

        const segmentTops = built.trunk.segments.map((segment) => segment.topJoint?.pos.z ?? built.route.socketPos.z);
        assert.deepEqual(segmentTops, [5, 10, 15]);
    });
