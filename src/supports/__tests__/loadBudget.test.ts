/**
 * The load budget is report only, so its tests are about the numbers it prints:
 * what an island is responsible for, what its supports are credited with, and
 * which way the difference points.
 *
 * Units are mm² of unsupported surface on both sides, with a support credited the
 * area the run's own density knob assigns one of its band. A structure support at
 * `areaPerSupportMm2` 10 is therefore worth exactly 10, which is what makes these
 * assertions readable rather than arbitrary.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { computeLoadBudget } from '../autoSupport/loadBudget';
import { footprintFromPoints, type VoxelFootprint } from '../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

const AREA_PER_SUPPORT_MM2 = 10;

/** A square footprint centred on (x, y), sampled on the detector's 0.25 mm grid. */
function square(x: number, y: number, sizeMm: number, z: number): VoxelFootprint {
    const points: { x: number; y: number; z: number }[] = [];
    const half = sizeMm / 2;
    for (let dx = -half; dx <= half + 1e-9; dx += 0.25) {
        for (let dy = -half; dy <= half + 1e-9; dy += 0.25) points.push({ x: x + dx, y: y + dy, z });
    }
    return footprintFromPoints(points);
}

function island(overrides: Partial<DetectedIsland> & { id: string; baseZ: number }): DetectedIsland {
    return {
        source: 'overhang',
        class: 'voxelOnly',
        contact: new THREE.Vector3(0, 0, overrides.baseZ),
        ...overrides,
    } as DetectedIsland;
}

test('demand is an island own area plus what sits above it', () => {
    const lower = island({ id: 'lower', baseZ: 10, areaMm2: 100, contactVoxels: square(0, 0, 10, 10) });
    const upper = island({ id: 'upper', baseZ: 20, areaMm2: 16, contactVoxels: square(0, 0, 4, 20) });
    const budget = computeLoadBudget({
        islands: [lower, upper],
        contacts: [],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        toppleCoverageNeeded: false,
    });

    const lowerRow = budget.rows.find((row) => row.islandId === 'lower')!;
    const upperRow = budget.rows.find((row) => row.islandId === 'upper')!;
    assert.equal(upperRow.demandMm2, 16, 'the upper island carries only itself');
    assert.equal(lowerRow.demandMm2, 116, 'the lower one also carries everything landing on it');
    assert.equal(budget.totalDemandMm2, 132);
    assert.equal(budget.totalCapacityMm2, 0, 'nothing placed yet, nothing credited');
});

test('a support is credited the area the density knob assigns its band', () => {
    const lower = island({ id: 'lower', baseZ: 10, areaMm2: 100, contactVoxels: square(0, 0, 10, 10) });
    const upper = island({ id: 'upper', baseZ: 20, areaMm2: 16, contactVoxels: square(0, 0, 4, 20) });
    const budget = computeLoadBudget({
        islands: [lower, upper],
        contacts: [
            { tip: { x: 0, y: 0, z: 10 }, preset: 'structure' },
            { tip: { x: 3, y: 3, z: 20 }, preset: 'anchor' },
        ],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        toppleCoverageNeeded: false,
    });

    const anchor = (1.4 / 1.0) ** 2 * AREA_PER_SUPPORT_MM2;
    assert.equal(budget.totalCapacityMm2, AREA_PER_SUPPORT_MM2 + anchor);

    // The structure support landed on the platform and the anchor on the patch
    // above it, so the rows read: 116 - 10 short, and 16 - 19.6 slack.
    const lowerRow = budget.rows.find((row) => row.islandId === 'lower')!;
    const upperRow = budget.rows.find((row) => row.islandId === 'upper')!;
    assert.equal(lowerRow.deficitMm2, 106);
    assert.equal(Math.round(upperRow.deficitMm2 * 10) / 10, -3.6);
    assert.equal(budget.islandsInDeficit, 1, 'the lower one is in deficit');
    assert.equal(budget.wouldAdd, 11, 'eleven supports at the structure band');
    assert.equal(
        budget.islandsInSurplus,
        0,
        '3.6mm² of slack is under half a support, so it is not called cullable',
    );
    assert.equal(budget.worst?.islandId, 'lower');
});

test('an island with no area of its own is never counted as surplus', () => {
    const minima = island({ id: 'minima', baseZ: 10, source: 'minima' });
    const patch = island({ id: 'patch', baseZ: 10, areaMm2: 4, contactVoxels: square(0, 0, 2, 10) });
    const budget = computeLoadBudget({
        islands: [minima, patch],
        contacts: [{ tip: { x: 0, y: 0, z: 10 }, preset: 'detail' }],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        toppleCoverageNeeded: false,
    });

    assert.equal(budget.islandsWithoutArea, 1);
    assert.equal(budget.wouldCull, 0, 'a minima carries no area, so it cannot be redundant');
    assert.ok(!budget.rows.some((row) => row.islandId === 'minima'), 'and it gets no row');
});

test('the topple channel charges a patch by its drag share, and only when the verdict asks', () => {
    const patch = island({
        id: 'steep', baseZ: 10, areaMm2: 100, contactVoxels: square(0, 0, 10, 10),
        dragMomentMm3: 500, steepFlat: true,
    });
    const withoutVerdict = computeLoadBudget({
        islands: [patch],
        contacts: [],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        poseDragMomentMm3: 1000,
        toppleCoverageNeeded: false,
    });
    const withVerdict = computeLoadBudget({
        islands: [patch],
        contacts: [],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        poseDragMomentMm3: 1000,
        toppleCoverageNeeded: true,
    });

    assert.equal(withoutVerdict.rows[0].demandMm2, 100, 'a stable pose charges nothing extra');
    assert.equal(withVerdict.rows[0].demandMm2, 150, 'half the pose drag is charged half the forest demand');
});

test('a contact that lands on no footprint is credited to nothing', () => {
    const patch = island({ id: 'patch', baseZ: 10, areaMm2: 4, contactVoxels: square(0, 0, 2, 10) });
    const budget = computeLoadBudget({
        islands: [patch],
        contacts: [
            { tip: { x: 0, y: 0, z: 10 }, preset: 'structure' },
            { tip: { x: 500, y: 500, z: 10 }, preset: 'structure' },
        ],
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        toppleCoverageNeeded: false,
    });

    assert.equal(budget.totalCapacityMm2, AREA_PER_SUPPORT_MM2, 'only the contact on the patch counts');
});
