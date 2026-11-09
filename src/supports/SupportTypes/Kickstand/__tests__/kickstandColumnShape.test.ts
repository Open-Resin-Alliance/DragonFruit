import assert from 'node:assert/strict';
import test from 'node:test';

import { buildKickstandData } from '../kickstandBuilder';
import type { KickstandBuildInput } from '../types';

/**
 * The grid-snapped placement from the bug report: a host 2.84mm up, with the
 * root pushed to the neighbouring grid node 3.43mm away. The chain overshoots
 * the host and the terminal run doubles back down to reach it.
 */
const GRID_SNAPPED_LOW_HOST: KickstandBuildInput = {
    modelId: 'model-1',
    rootPos: { x: 12, y: 16, z: 0 },
    host: {
        segmentId: 'shaft-1',
        supportKind: 'trunk',
        t: 0.0096770214952281,
        pos: { x: 9.096829382802428, y: 14.180691801174177, z: 2.8379237189740247 },
        diameterMm: 1.3,
    },
};

test('a grid column that doubles back to reach its host is refused', () => {
    const build = buildKickstandData(GRID_SNAPPED_LOW_HOST);
    assert.equal(build.error, 'ANGLE_TOO_STEEP');
});

test('a column rising straight to a host above it is allowed', () => {
    const build = buildKickstandData({
        modelId: 'model-1',
        rootPos: { x: 0, y: 0, z: 0 },
        host: {
            segmentId: 'shaft-1',
            supportKind: 'trunk',
            t: 0.5,
            pos: { x: 0, y: 0, z: 20 },
            diameterMm: 2,
        },
    });
    assert.equal(build.error, undefined);
});

test('the limit comes from the shaft setting', () => {
    // A lean the 80deg default allows, refused once the setting tightens.
    const leaning: KickstandBuildInput = {
        modelId: 'model-1',
        rootPos: { x: 0, y: 0, z: 0 },
        host: {
            segmentId: 'shaft-1',
            supportKind: 'trunk',
            t: 0.5,
            pos: { x: 8, y: 0, z: 20 },
            diameterMm: 2,
        },
    };
    assert.equal(buildKickstandData(leaning).error, undefined);
    assert.equal(
        buildKickstandData({ ...leaning, maxShaftAngleDeg: 5 }).error,
        'ANGLE_TOO_STEEP',
    );
});
