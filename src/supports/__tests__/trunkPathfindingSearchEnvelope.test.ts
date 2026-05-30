import assert from 'node:assert/strict';
import test from 'node:test';

import { getSmartPlacementV2SearchEnvelope } from '../PlacementLogic/Pathfinding/SmartPlacementV2';

const makePos = (z: number) => ({ x: 0, y: 0, z });

test('search envelope keeps the historical 60 mm minimum reach for short supports', () => {
    const envelope = getSmartPlacementV2SearchEnvelope({
        socketPos: makePos(20),
        rootTopZ: 0,
        spacingMm: 4,
    });

    assert.equal(envelope.maxTotalLateralMm, 60);
    assert.deepEqual(envelope.rescueSweepRadiiMm.slice(-2), [52, 60]);
});

test('search envelope expands with taller supports and appends the computed outer radius', () => {
    const envelope = getSmartPlacementV2SearchEnvelope({
        socketPos: makePos(25),
        rootTopZ: 0,
        spacingMm: 4,
    });

    assert.equal(envelope.maxTotalLateralMm, 75);
    assert.equal(envelope.rescueSweepRadiiMm.includes(72), true);
    assert.equal(envelope.rescueSweepRadiiMm[envelope.rescueSweepRadiiMm.length - 1], 75);
});

test('search envelope caps very tall supports so the router does not wander unboundedly', () => {
    const envelope = getSmartPlacementV2SearchEnvelope({
        socketPos: makePos(80),
        rootTopZ: 0,
        spacingMm: 4,
    });

    assert.equal(envelope.maxTotalLateralMm, 120);
    assert.equal(envelope.rescueSweepRadiiMm[envelope.rescueSweepRadiiMm.length - 1], 120);
});
