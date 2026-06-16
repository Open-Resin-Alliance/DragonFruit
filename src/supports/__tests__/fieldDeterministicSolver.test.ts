import assert from 'node:assert/strict';
import test from 'node:test';

import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { solveDeterministicFieldPath } from '../PlacementLogic/Pathfinding/FieldDeterministicSolver';

function mockGradientForDistanceAt(distanceAt: (x: number, y: number, z: number) => number) {
    return (x: number, y: number, z: number) => {
        const d = distanceAt(x, y, z);
        const h = 0.05;
        const dXPlus = distanceAt(x + h, y, z);
        const dXMinus = distanceAt(x - h, y, z);
        const dYPlus = distanceAt(x, y + h, z);
        const dYMinus = distanceAt(x, y - h, z);
        const dZPlus = distanceAt(x, y, z + h);
        const dZMinus = distanceAt(x, y, z - h);

        let gx = 0, gy = 0, gz = 0;
        if (dXPlus !== Infinity && dXMinus !== Infinity) gx = (dXPlus - dXMinus) / (2 * h);
        if (dYPlus !== Infinity && dYMinus !== Infinity) gy = (dYPlus - dYMinus) / (2 * h);
        if (dZPlus !== Infinity && dZMinus !== Infinity) gz = (dZPlus - dZMinus) / (2 * h);

        const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const gradient = len > 1e-6 ? { x: gx / len, y: gy / len, z: gz / len } : { x: 0, y: 0, z: 0 };
        return { distance: d, gradient };
    };
}

function makeOpenSdf(): SDFCache {
    return {
        cellSize: 0.5,
        distanceAt: () => Infinity,
        distanceAtTrilinear: () => Infinity,
        distanceAndGradientAt: () => ({ distance: Infinity, gradient: { x: 0, y: 0, z: 0 } }),
        isBlocked: () => false,
        segmentBlocked: () => false,
    } as unknown as SDFCache;
}

test('FieldDeterministicSolver: descends straight down in open space', () => {
    const startPos = { x: 0, y: 0, z: 100 };
    const goalZ = 0;

    const result = solveDeterministicFieldPath(makeOpenSdf(), startPos, goalZ, {
        clearanceMm: 1.0,
        marginMm: 2.0,
        stepMm: 1.0,
        maxLateralMm: 30.0,
    });

    assert.equal(result.reached, true);
    assert.equal(result.stagnated, false);
    // Path should simplify straight to the goal since open space is immediately clear
    assert.deepEqual(result.path, [
        { x: 0, y: 0, z: 100 },
        { x: 0, y: 0, z: 0 },
    ]);
});

test('FieldDeterministicSolver: routes around sphere obstacle and triggers early vertical drop', () => {
    const obstacleCenter = { x: 0, y: 0, z: 50 };
    const obstacleRadius = 15;
    const clearance = 2.0;

    const distanceAt = (x: number, y: number, z: number) => {
        const dx = x - obstacleCenter.x;
        const dy = y - obstacleCenter.y;
        const dz = z - obstacleCenter.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) - obstacleRadius;
    };

    const mockSdf = {
        cellSize: 0.5,
        distanceAt,
        distanceAtTrilinear: distanceAt,
        distanceAndGradientAt: mockGradientForDistanceAt(distanceAt),
        segmentBlocked: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cl: number) => {
            const steps = 30;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const px = ax + (bx - ax) * t;
                const py = ay + (by - ay) * t;
                const pz = az + (bz - az) * t;
                const dx = px - obstacleCenter.x;
                const dy = py - obstacleCenter.y;
                const dz = pz - obstacleCenter.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - obstacleRadius;
                if (d < cl) return true;
            }
            return false;
        }
    } as unknown as SDFCache;

    // Start offset slightly to steer one way
    const startPos = { x: 0.5, y: 0.0, z: 90 };
    const goalZ = 10;

    const result = solveDeterministicFieldPath(mockSdf, startPos, goalZ, {
        clearanceMm: clearance,
        marginMm: 3.0,
        stepMm: 1.0,
        maxLateralMm: 30.0,
    });

    assert.equal(result.reached, true, 'Should successfully route and reach goalZ');
    assert.equal(result.stagnated, false);

    // Verify clearance is respected at all waypoints
    for (const pt of result.path) {
        const d = mockSdf.distanceAt(pt.x, pt.y, pt.z);
        assert.ok(d >= clearance - 0.05, `Distance ${d} at (${pt.x}, ${pt.y}, ${pt.z}) should respect clearance`);
    }

    // Verify that the final segment drops vertically
    const finalPt = result.path[result.path.length - 1];
    const prevPt = result.path[result.path.length - 2];
    assert.equal(finalPt.x, prevPt.x, 'Final segment must have identical X coordinate');
    assert.equal(finalPt.y, prevPt.y, 'Final segment must have identical Y coordinate');
    assert.equal(finalPt.z, goalZ, 'Final point should reach the goal Z');
});

test('FieldDeterministicSolver: smart placement honors fieldDeterministic settings', () => {
    const THREE = require('three');
    const { initializeBVH, accelerateGeometry } = require('../../utils/bvh');
    const { calculateSmartPlacementV2 } = require('../PlacementLogic/Pathfinding/SmartPlacementV2');
    const { setSettings } = require('../Settings/state');
    const { createDefaultSettings } = require('../Settings/types');

    initializeBVH();
    const settings = createDefaultSettings();
    settings.roots.diskHeightMm = 1.0;
    settings.roots.coneHeightMm = 1.0;
    settings.roots.diameterMm = 3.0;
    settings.shaft.diameterMm = 1.5;
    settings.devToolsEnabled = true;
    settings.devTools.fieldDeterministic = true; // Enable field deterministic solver
    setSettings(settings);

    // Create a sphere obstacle at {x:0, y:0, z:5} with radius 2
    const geometry = new THREE.SphereGeometry(2, 16, 16);
    accelerateGeometry(geometry);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, 5);
    mesh.updateMatrixWorld(true);

    const result = calculateSmartPlacementV2({
        tipPos: { x: 0.5, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        tipProfile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 1.2,
            penetrationMm: 0.05,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.35,
            standoffAngleThreshold: Math.PI / 4,
        },
        modelId: 'model-field-det-test',
        mesh,
        rootsTopZ: 2,
    });

    assert.equal(result.error, undefined);
    assert.ok(result.joints && result.joints.length > 0, 'Should route around obstacle');
});
