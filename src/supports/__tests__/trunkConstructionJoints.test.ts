import assert from 'node:assert/strict';
import test from 'node:test';

import {
    normalizeFirstConstructionJoint,
    withCentralStraightSupportJoint,
} from '../SupportTypes/Trunk/trunkConstructionJoints';

test('withCentralStraightSupportJoint returns no construction joint when the support is too short', () => {
    const joints = withCentralStraightSupportJoint({
        basePos: { x: 1, y: 2, z: 0 },
        rootTopZ: 2,
        socketPos: { x: 1, y: 2, z: 3.4 },
    });

    assert.deepEqual(joints, []);
});

test('withCentralStraightSupportJoint inserts a vertical construction joint for tall straight supports', () => {
    const joints = withCentralStraightSupportJoint({
        basePos: { x: 1, y: 2, z: 0 },
        rootTopZ: 2,
        socketPos: { x: 1, y: 2, z: 10 },
    });

    assert.equal(joints.length, 1);
    assert.equal(joints[0]?.x, 1);
    assert.equal(joints[0]?.y, 2);
    assert.equal(joints[0]?.z, 7.2);
});

test('normalizeFirstConstructionJoint preserves solver-authored construction joints', () => {
    const authored = [{ x: 3, y: 4, z: 5 }];
    const joints = normalizeFirstConstructionJoint({
        basePos: { x: 0, y: 0, z: 0 },
        rootTopZ: 2,
        socketPos: { x: 0, y: 0, z: 10 },
        routeJoints: [],
        constructionJoints: authored,
    });

    assert.deepEqual(joints, authored);
});

test('normalizeFirstConstructionJoint does not invent an extra construction joint for routed supports', () => {
    const joints = normalizeFirstConstructionJoint({
        basePos: { x: 0, y: 0, z: 0 },
        rootTopZ: 2,
        socketPos: { x: 0, y: 0, z: 10 },
        routeJoints: [{ x: 0, y: 1, z: 7 }],
        constructionJoints: [],
    });

    assert.deepEqual(joints, []);
});

test('normalizeFirstConstructionJoint inserts a first vertical construction joint for straight supports without one', () => {
    const joints = normalizeFirstConstructionJoint({
        basePos: { x: 5, y: 6, z: 0 },
        rootTopZ: 2,
        socketPos: { x: 5, y: 6, z: 10 },
        routeJoints: [],
        constructionJoints: [],
    });

    assert.equal(joints.length, 1);
    assert.equal(joints[0]?.x, 5);
    assert.equal(joints[0]?.y, 6);
    assert.equal(joints[0]?.z, 7.2);
});
