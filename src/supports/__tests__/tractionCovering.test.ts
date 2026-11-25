import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import {
    FORCE_COVERING_DEFAULTS,
    forceDrivenContactCount,
    selectForceCoveragePoints,
} from '../autoSupport/tractionCovering';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

function slabIsland(sizeX = 10, sizeY = 10, z = 20): DetectedIsland {
    const voxels: Array<{ x: number; y: number; z?: number }> = [];
    for (let x = -sizeX / 2; x <= sizeX / 2 + 1e-9; x += 0.25) {
        for (let y = -sizeY / 2; y <= sizeY / 2 + 1e-9; y += 0.25) {
            voxels.push({ x, y, z });
        }
    }
    return {
        id: 'slab',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, z),
        baseZ: z,
        areaMm2: sizeX * sizeY,
        contactVoxels: footprintFromPoints(voxels),
    };
}

test('force deficit yields a capacity-based contact count', () => {
    assert.equal(forceDrivenContactCount(0, 10), 0);
    assert.equal(forceDrivenContactCount(1, 10), 1, 'any deficit needs at least one contact');
    assert.equal(forceDrivenContactCount(21, 10), 3, 'ceil(deficit / capacity)');
    assert.equal(forceDrivenContactCount(100, 0), 0, 'no capacity, no derivation');
});

test('new contacts spread over the traction field instead of stacking', () => {
    const island = slabIsland();
    const points = selectForceCoveragePoints(
        island,
        [{ x: 0, y: 0, demandN: 30, capacityN: 10 }],
        [{ x: -4.5, y: -4.5 }, { x: 4.5, y: 4.5 }],
        2,
        { minSpacingMm: FORCE_COVERING_DEFAULTS.minSpacingMm },
    );
    assert.equal(points.length, 2);
    for (const p of points) {
        assert.ok(Math.abs(p.x) <= 5.01 && Math.abs(p.y) <= 5.01, 'point stays on the footprint');
        assert.ok(Math.abs(p.z - 20) < 1e-6, 'footprint Z carried');
        for (const tip of [{ x: -4.5, y: -4.5 }, { x: 4.5, y: 4.5 }]) {
            assert.ok(Math.hypot(p.x - tip.x, p.y - tip.y) >= FORCE_COVERING_DEFAULTS.minSpacingMm - 1e-6,
                'new point keeps the spacing from existing tips');
        }
    }
    assert.ok(Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
        >= FORCE_COVERING_DEFAULTS.minSpacingMm - 1e-6,
    'the two new points keep the spacing from each other');
});

test('a point-only island falls back to its contact', () => {
    const island: DetectedIsland = {
        id: 'point', source: 'minima',
        contact: new THREE.Vector3(1, 2, 30), baseZ: 30, areaMm2: 0.01,
    };
    const points = selectForceCoveragePoints(
        island,
        [{ x: 1, y: 2, demandN: 5, capacityN: 2 }],
        [],
        1,
    );
    assert.equal(points.length, 1);
    assert.deepEqual({ x: points[0].x, y: points[0].y, z: points[0].z }, { x: 1, y: 2, z: 30 });
});
