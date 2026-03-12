import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getDefaultSnappedValidity,
    getResolvedSnappedNodeKey,
    getResolvedSnappedRootPos,
    getResolvedSnappedValidity,
    hasResolvedSnappedRoot,
} from '../SupportTypes/Trunk/trunkRouteResolution';
import type { SnappedTrunkRouteResult, TrunkRouteResult } from '../SupportTypes/Trunk/trunkRouteTypes';

function makeRoute(overrides: Partial<TrunkRouteResult> = {}): TrunkRouteResult {
    return {
        kind: 'straight',
        basePos: { x: 0, y: 0, z: 0 },
        socketPos: { x: 0, y: 0, z: 10 },
        unsnappedBottomPos: { x: 0, y: 0, z: 0 },
        joints: [],
        constructionJoints: [],
        validity: 'valid',
        ...overrides,
    };
}

test('default snapped validity mirrors route validity states', () => {
    assert.equal(getDefaultSnappedValidity(makeRoute({ validity: 'valid' })), 'valid');
    assert.equal(getDefaultSnappedValidity(makeRoute({ validity: 'route_invalid' })), 'invalid_assisted');
    assert.equal(getDefaultSnappedValidity(makeRoute({ validity: 'hard_invalid' })), 'hard_invalid');
});

test('resolved snapped helpers return null or fallback values when snapped metadata is absent', () => {
    const route = makeRoute();
    const fallbackRootPos = { x: 3, y: 4, z: 0 };

    assert.equal(getResolvedSnappedNodeKey(route), null);
    assert.equal(hasResolvedSnappedRoot(route), false);
    assert.equal(getResolvedSnappedValidity(route), null);
    assert.deepEqual(getResolvedSnappedRootPos(route, fallbackRootPos), fallbackRootPos);
});

test('resolved snapped helpers return authored snapped metadata when present', () => {
    const route: SnappedTrunkRouteResult = {
        ...makeRoute({ validity: 'route_invalid' }),
        snappedRootPos: { x: 7, y: 8, z: 0 },
        snappedNodeKey: '2,3',
        snappedValidity: 'invalid_assisted',
    };

    assert.equal(getResolvedSnappedNodeKey(route), '2,3');
    assert.equal(hasResolvedSnappedRoot(route), true);
    assert.equal(getResolvedSnappedValidity(route), 'invalid_assisted');
    assert.deepEqual(getResolvedSnappedRootPos(route, { x: 0, y: 0, z: 0 }), route.snappedRootPos);
});
