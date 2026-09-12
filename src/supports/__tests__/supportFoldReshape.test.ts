import assert from 'node:assert/strict';
import test from 'node:test';

import { planFoldReshape } from '../PlacementLogic/Pathfinding/SmartPlacementV2';
import {
    getLengthAwareMaxAngleFromVerticalDeg,
    segmentAngleFromVerticalDeg,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
} from '../PlacementLogic/smartPlacementSearchUtils';

/**
 * The reported fold: the route reaches a joint at z=14.46, jogs 1.73mm sideways
 * over a 1.00mm drop (60 degrees from vertical), then descends vertically from a
 * joint that already sits over the committed base.
 */
const SOCKET = { x: -3.18, y: -3.47, z: 24.68 };
const UPPER_JOINT = { x: -6.28, y: -1.66, z: 14.46 };
const FOLD_JOINT = { x: -6.83, y: -0.02, z: 13.46 };
const ROOT_TOP = { x: -6.83, y: -0.02, z: 1.5 };
const BASE_XY = { x: -6.83, y: -0.02 };

/** (90 - 60) + 10 detour slack: the base the final chain validation uses. */
const FINAL_VALIDATION_BASE_DEG = 40;
/** 90 - 60: the angle the app configures for routed trunks. */
const CONFIGURED_ROUTED_ANGLE_DEG = 30;

const interiorAngles = (joints: { x: number; y: number; z: number }[], rootTop = ROOT_TOP) => {
    const points = [SOCKET, ...joints, rootTop];
    return points.slice(0, -1).map((_, i) => segmentAngleFromVerticalDeg(points[i]!, points[i + 1]!));
};

test('a 60 degree interior jog is planned away and the reshapes remove the step', () => {
    const plan = planFoldReshape([UPPER_JOINT, FOLD_JOINT], { baseXY: BASE_XY, rootTopTarget: ROOT_TOP });

    assert.ok(plan, 'the jog is recognised as a fold');
    assert.equal(plan.foldEndIndex, 1, 'the fold ends at the second joint');

    const placed = interiorAngles([UPPER_JOINT, FOLD_JOINT]);
    assert.ok(Math.abs(placed[1]! - 60) < 0.5, `the chain as placed carries the step (${placed[1]!.toFixed(1)} degrees)`);

    for (const candidate of plan.candidates) {
        const worst = Math.max(...interiorAngles(candidate.joints, candidate.rootTop));
        assert.ok(worst < 30, `${candidate.name}: worst segment is ${worst.toFixed(1)} degrees, expected a diagonal under 30`);
    }
});

test('the base moves under the joint above the fold and the descent below it is dropped', () => {
    const plan = planFoldReshape([UPPER_JOINT, FOLD_JOINT], { baseXY: BASE_XY, rootTopTarget: ROOT_TOP });

    const baseUnderUpperJoint = plan!.candidates.find((candidate) => candidate.moveBase);
    assert.ok(baseUnderUpperJoint, 'a candidate moves the base');
    assert.deepEqual(baseUnderUpperJoint!.rootTop, { x: UPPER_JOINT.x, y: UPPER_JOINT.y, z: ROOT_TOP.z });
    assert.deepEqual(baseUnderUpperJoint!.joints, [UPPER_JOINT], 'the descent below it is dropped');
});

test('the socket elbow is not a fold', () => {
    // The same 60 degree kink, but as the FIRST segment: that is the socket
    // elbow, a short steep strut under the tip that mainstream slicers emit.
    const elbowJoint = { x: SOCKET.x + 1.5, y: SOCKET.y, z: SOCKET.z - 0.87 };
    const plan = planFoldReshape([elbowJoint], { baseXY: BASE_XY, rootTopTarget: ROOT_TOP });

    assert.equal(plan, null);
});

test('a chain whose interior segments are all near-vertical needs no reshaping', () => {
    const shallowJoint = { x: SOCKET.x - 4, y: SOCKET.y + 3, z: 12 };
    const plan = planFoldReshape([shallowJoint], { baseXY: BASE_XY, rootTopTarget: ROOT_TOP });

    assert.equal(plan, null, 'one slanted segment is not a fold');
});

test('the length-aware tightening never bites below the configured routed-trunk angle', () => {
    const diagonalLengthMm = 12.29;
    const diagonalAngleDeg = segmentAngleFromVerticalDeg(SOCKET, FOLD_JOINT);

    assert.ok(Math.abs(diagonalAngleDeg - 24.1) < 0.2, `diagonal sits at ${diagonalAngleDeg.toFixed(1)} degrees`);
    assert.ok(
        getLengthAwareMaxAngleFromVerticalDeg(diagonalLengthMm, FINAL_VALIDATION_BASE_DEG) < diagonalAngleDeg,
        'without a floor the tightening forbids the diagonal, which is what forced the horizontal step',
    );
    assert.ok(
        getLengthAwareMaxAngleFromVerticalDeg(diagonalLengthMm, FINAL_VALIDATION_BASE_DEG, CONFIGURED_ROUTED_ANGLE_DEG) >= diagonalAngleDeg,
        'floored at the configured angle the diagonal is available',
    );
    assert.ok(
        segmentSatisfiesLengthAwareMaxAngleFromVertical(SOCKET, FOLD_JOINT, FINAL_VALIDATION_BASE_DEG, CONFIGURED_ROUTED_ANGLE_DEG),
        'so the chain can collapse onto it instead of stepping sideways',
    );
});
