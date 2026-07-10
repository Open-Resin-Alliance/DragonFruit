import assert from 'node:assert/strict';
import test from 'node:test';

import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import {
    isCachedPlacementReusable,
    PLACEMENT_ERROR_CACHE_TTL_MS,
} from '../SupportTypes/Trunk/trunkBuilder';

function makePlacement(overrides: Partial<TrunkPlacementResult> = {}): TrunkPlacementResult {
    return {
        basePos: { x: 0, y: 0, z: 0 },
        socketPos: { x: 0, y: 0, z: 10 },
        joints: [],
        constructionJoints: [],
        ...overrides,
    };
}

test('successful placements stay reusable regardless of age', () => {
    const entry = { result: makePlacement(), cachedAt: 0 };
    assert.equal(isCachedPlacementReusable(entry, PLACEMENT_ERROR_CACHE_TTL_MS * 1000), true);
});

test('error placements are reusable within the TTL', () => {
    const entry = { result: makePlacement({ error: 'COLLISION_WITH_MODEL' as TrunkPlacementResult['error'] }), cachedAt: 1000 };
    assert.equal(isCachedPlacementReusable(entry, 1000 + PLACEMENT_ERROR_CACHE_TTL_MS), true);
});

test('error placements expire after the TTL so hover re-solves instead of pinning stale "blocked" verdicts', () => {
    const entry = { result: makePlacement({ error: 'COLLISION_WITH_MODEL' as TrunkPlacementResult['error'] }), cachedAt: 1000 };
    assert.equal(isCachedPlacementReusable(entry, 1000 + PLACEMENT_ERROR_CACHE_TTL_MS + 1), false);
});
