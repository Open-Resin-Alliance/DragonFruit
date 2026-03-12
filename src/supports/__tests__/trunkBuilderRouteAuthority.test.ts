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
