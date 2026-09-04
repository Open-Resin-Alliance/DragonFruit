import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    computeRegionCoverage,
    findUncoveredClusters,
    buildGapFillCandidates,
    TIP_COVERAGE_RADIUS_MM,
    REGION_COVERAGE_TARGET,
} from '../autoSupport/coverage';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rectRegion(id: string, minX: number, maxX: number, minY: number, maxY: number): DetectedIsland {
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = minX; x <= maxX; x += 0.25) {
        for (let y = minY; y <= maxY; y += 0.25) {
            contactVoxels.push({ x, y, z: 10 });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 10),
        baseZ: 10,
        areaMm2: (maxX - minX) * (maxY - minY),
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(contactVoxels),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('coverage is 0 without tips and ~1 with dense tips', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    assert.equal(computeRegionCoverage(region, []), 0);

    // Dense tip grid at 2mm spacing over the whole footprint.
    const tips = [];
    for (let x = -9; x <= 9; x += 2) {
        for (let y = -9; y <= 9; y += 2) {
            tips.push({ x, y, z: 10 });
        }
    }
    const cov = computeRegionCoverage(region, tips);
    assert.ok(cov > 0.99, `dense tips cover ~everything, got ${cov}`);
});

test('coverage is footprint-aware (a corner tip does not cover the far side)', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    // One tip at the center covers ~7% of a 20×20 footprint with a 3mm disc.
    const cov = computeRegionCoverage(region, [{ x: 0, y: 0, z: 10 }]);
    const expected = (Math.PI * TIP_COVERAGE_RADIUS_MM * TIP_COVERAGE_RADIUS_MM) / 400;
    assert.ok(Math.abs(cov - expected) < 0.01, `center tip coverage ${cov} ≈ ${expected}`);
});

test('findUncoveredClusters returns clusters away from covered areas', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    // Tip at the center: uncovered voxels form one big cluster (square minus
    // disc is connected), with a centroid pulled off-center toward -x/-y.
    const clusters = findUncoveredClusters(region, [{ x: 5, y: 5, z: 10 }]);
    assert.equal(clusters.length, 1, 'one connected uncovered region');
    const c = clusters[0];
    assert.ok(c.x < 3 && c.y < 3, `centroid pulled away from the tip (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);
    assert.ok(Math.abs(c.z - 10) < 1e-6, 'cluster carries the surface Z');
});

test('no tips → no gap clusters (the main grid handles the region)', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    assert.deepEqual(findUncoveredClusters(region, []), []);
});

test('buildGapFillCandidates creates standalone grid-point candidates for under-covered regions', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    const settings = createDefaultAutoSupportSettings();
    const candidates = buildGapFillCandidates([region], settings, [{ x: 0, y: 0, z: 10 }]);

    assert.ok(candidates.length >= 1, 'under-covered region gets gap-fill candidates');
    assert.ok(candidates.every((c) => c.gridPoint === true), 'gap-fill points are standalone trunks');
    assert.deepEqual(candidates[0].tipNormal, { x: 0, y: 0, z: -1 }, 'region normal carried');
});

test('fully covered region gets no gap-fill candidates', () => {
    const region = rectRegion('o0', -10, 10, -10, 10);
    const tips = [];
    for (let x = -9; x <= 9; x += 2) {
        for (let y = -9; y <= 9; y += 2) {
            tips.push({ x, y, z: 10 });
        }
    }
    const settings = createDefaultAutoSupportSettings();
    const candidates = buildGapFillCandidates([region], settings, tips);
    assert.equal(candidates.length, 0, 'coverage target met → no fill');
});

test('coverage target constant is below 1 so edge voxels do not force infinite fill', () => {
    assert.ok(REGION_COVERAGE_TARGET > 0 && REGION_COVERAGE_TARGET < 1);
});
