import assert from 'node:assert/strict';
import test from 'node:test';

import { solveElasticChain, type ElasticChainInitialState } from '../PlacementLogic/ElasticChainSolver';

const DEFAULT_MAX_ANGLE_DEG = 80;

function makeChain(): ElasticChainInitialState {
    return {
        branchId: 'branch-1',
        knotPos: { x: 0, y: 0, z: 0 },
        joints: [
            // Rises from the knot: forward IK pass must push this joint up
            // when the knot is dragged above the max-angle envelope.
            { id: 'j1', pos: { x: 10, y: 0, z: 5 } },
        ],
    };
}

// Raising the knot to z=20 forces j1 above its original z once the
// max-angle slope constraint is applied: required z = 20 + 10 / tan(angle).
const RAISED_TARGET = { x: 0, y: 0, z: 20 };

test('solveElasticChain enforces the max-angle constraint for finite angles', () => {
    const result = solveElasticChain(RAISED_TARGET, makeChain(), DEFAULT_MAX_ANGLE_DEG);

    const expectedZ = 20 + 10 / Math.tan((DEFAULT_MAX_ANGLE_DEG * Math.PI) / 180);
    assert.equal(result.isLocked, true);
    assert.ok(Math.abs(result.jointPositions['j1'].z - expectedZ) < 1e-6);
});

test('solveElasticChain treats NaN maxAngleDeg like the default 80 degrees', () => {
    const expected = solveElasticChain(RAISED_TARGET, makeChain(), DEFAULT_MAX_ANGLE_DEG);
    const actual = solveElasticChain(RAISED_TARGET, makeChain(), Number.NaN);

    assert.deepEqual(actual, expected);
    assert.equal(actual.isLocked, true);
});

test('solveElasticChain treats undefined maxAngleDeg like the default 80 degrees', () => {
    const expected = solveElasticChain(RAISED_TARGET, makeChain(), DEFAULT_MAX_ANGLE_DEG);
    const actual = solveElasticChain(RAISED_TARGET, makeChain(), undefined as unknown as number);

    assert.deepEqual(actual, expected);
    assert.equal(actual.isLocked, true);
});

test('solveElasticChain always returns finite joint positions', () => {
    for (const angle of [Number.NaN, Number.POSITIVE_INFINITY, -10, 0, 45, 90, 200]) {
        const result = solveElasticChain(RAISED_TARGET, makeChain(), angle);
        assert.ok(Number.isFinite(result.knotPos.z), `knot z finite for angle ${angle}`);
        assert.ok(Number.isFinite(result.jointPositions['j1'].z), `joint z finite for angle ${angle}`);
    }
});
