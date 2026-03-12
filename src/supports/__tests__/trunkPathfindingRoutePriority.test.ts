import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BestCostEntry,
    getLengthAwareMaxAngleFromVerticalDeg,
    isBetterSearchState,
} from '../PlacementLogic/smartPlacementSearchUtils';

function makeSearchState(overrides: Partial<BestCostEntry> = {}): BestCostEntry {
    return {
        score: 100,
        totalLength: 12,
        totalLateral: 4,
        verticalDrop: 8,
        bestSnapDistance: 1,
        jointCount: 1,
        ...overrides,
    };
}

test('search-state comparison allows extra joints when they materially improve route quality', () => {
    const current = makeSearchState({
        score: 120,
        totalLength: 14,
        totalLateral: 6,
        verticalDrop: 7,
        bestSnapDistance: 2,
        jointCount: 1,
    });
    const candidate = makeSearchState({
        score: 96,
        totalLength: 10,
        totalLateral: 3,
        verticalDrop: 10,
        bestSnapDistance: 0.5,
        jointCount: 2,
    });

    assert.equal(isBetterSearchState(candidate, current), true);
});

test('search-state comparison uses fewer joints only after higher-priority route metrics tie', () => {
    const current = makeSearchState({ jointCount: 1 });
    const candidate = makeSearchState({ jointCount: 2 });

    assert.equal(isBetterSearchState(candidate, current), false);
});

test('search-state comparison rejects a fewer-joint candidate when it worsens a higher-priority metric', () => {
    const current = makeSearchState({
        bestSnapDistance: 1,
        jointCount: 2,
    });
    const candidate = makeSearchState({
        bestSnapDistance: 1.25,
        jointCount: 1,
    });

    assert.equal(isBetterSearchState(candidate, current), false);
});

test('length-aware upper-span rule tightens after 5 mm and clamps to the minimum floor', () => {
    assert.equal(getLengthAwareMaxAngleFromVerticalDeg(5, 60), 60);
    assert.equal(getLengthAwareMaxAngleFromVerticalDeg(8, 60), 51);
    assert.equal(getLengthAwareMaxAngleFromVerticalDeg(30, 60), 15);
});
