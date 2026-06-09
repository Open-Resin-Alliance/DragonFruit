import assert from 'node:assert/strict';
import test from 'node:test';

import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { solvePotentialField } from '../PlacementLogic/Pathfinding/PotentialFieldSolver';
import { gridAStar } from '../PlacementLogic/Pathfinding/GridAStar';

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

test('PotentialFieldSolver: descends straight down in open space and simplifies to 1 segment', () => {
    const startPos = { x: 0, y: 0, z: 100 };
    const goalZ = 0;

    const result = solvePotentialField(makeOpenSdf(), startPos, goalZ, {
        clearanceMm: 0.8,
        simplify: true,
    });

    assert.equal(result.reached, true);
    assert.equal(result.stagnated, false);
    // Simplified path should be start -> end
    assert.deepEqual(result.path, [
        { x: 0, y: 0, z: 100 },
        { x: 0, y: 0, z: 0 },
    ]);
});

test('PotentialFieldSolver: routes around an obstacle and maintains clearance', () => {
    const obstacleCenter = { x: 0, y: 0, z: 50 };
    const obstacleRadius = 15;
    const clearance = 2.0;

    // A spherical obstacle. Distance function: dist = ||P - C|| - R
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
            // Sample points along segment
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

    // Start directly above the sphere
    const startPos = { x: 0.5, y: 0.0, z: 90 };
    const goalZ = 10;

    const result = solvePotentialField(mockSdf, startPos, goalZ, {
        clearanceMm: clearance,
        marginMm: 3.0,
        repulsionStrength: 10.0,
        stepMm: 1.0,
        maxSteps: 300,
        simplify: true,
    });

    assert.equal(result.reached, true, 'Should successfully route around sphere and reach goalZ');
    assert.equal(result.stagnated, false);

    // Verify clearance is respected at all waypoints
    for (const pt of result.path) {
        const d = mockSdf.distanceAt(pt.x, pt.y, pt.z);
        // Allow a small numeric tolerance (e.g. 0.05mm) for trilinear/discrete approximation
        assert.ok(d >= clearance - 0.05, `Path point {${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)}} distance ${d.toFixed(2)} must be >= clearance ${clearance}`);
    }
});

test('PotentialFieldSolver: stagnates in a closed cavity/cup', () => {
    const clearance = 2.0;

    // SDF that returns 0 (penetrated/blocked) for Z <= 50, and 10 everywhere else.
    // This creates an impassable floor at Z = 50.
    const distanceAt = (x: number, y: number, z: number) => {
        if (z <= 50) return 0;
        return 10;
    };

    const mockSdf = {
        cellSize: 0.5,
        distanceAt,
        distanceAtTrilinear: distanceAt,
        distanceAndGradientAt: mockGradientForDistanceAt(distanceAt),
        segmentBlocked: () => false,
    } as unknown as SDFCache;

    const startPos = { x: 0, y: 0, z: 100 };
    const goalZ = 0;

    const result = solvePotentialField(mockSdf, startPos, goalZ, {
        clearanceMm: clearance,
        marginMm: 2.0,
        repulsionStrength: 10.0,
        stepMm: 1.0,
        maxSteps: 150,
    });

    assert.equal(result.reached, false, 'Should not reach Z = 0');
    assert.equal(result.stagnated, true, 'Should stagnate above the floor');
    assert.ok(result.stagnationPos !== undefined);
    assert.ok(result.stagnationPos.z >= 48, 'Stagnation position should be near or above the floor Z=50');
});

test('PotentialFieldSolver vs GridAStar Benchmark (Performance comparison)', () => {
    const obstacleCenter = { x: 0, y: 0, z: 50 };
    const obstacleRadius = 12;
    const clearance = 1.0;

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
            const steps = 15;
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

    const startPos = { x: 0.1, y: 0.0, z: 80 };
    const goalZ = 10;

    // 1. Benchmark PotentialFieldSolver
    const t0 = performance.now();
    let pfResult = null;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
        pfResult = solvePotentialField(mockSdf, startPos, goalZ, {
            clearanceMm: clearance,
            marginMm: 2.0,
            repulsionStrength: 5.0,
            stepMm: 1.0,
            simplify: true,
        });
    }
    const t1 = performance.now();
    const pfTimePerRun = (t1 - t0) / runs;

    // 2. Benchmark GridAStar
    const t2 = performance.now();
    let astarResult = null;
    for (let i = 0; i < runs; i++) {
        astarResult = gridAStar(mockSdf, startPos, goalZ, {
            clearanceMm: clearance,
            maxLateralMm: 30,
            maxExpansions: 10000,
            stepMm: 1.0,
            endpointOnlyCollisionCheck: true,
        });
    }
    const t3 = performance.now();
    const astarTimePerRun = (t3 - t2) / runs;

    console.log(`\n=== Solver Performance Benchmark (averages over ${runs} runs) ===`);
    console.log(`Potential Field Solver: ${pfTimePerRun.toFixed(3)} ms per route (reached: ${pfResult?.reached})`);
    console.log(`Grid A* Pathfinder:      ${astarTimePerRun.toFixed(3)} ms per route (reached: ${astarResult?.reached}, expansions: ${astarResult?.expansions})`);
    console.log(`=================================================================\n`);

    assert.equal(pfResult?.reached, true);
    // The Potential Field solver should be faster because it doesn't build/expand/sort a priority queue heap
    assert.ok(pfTimePerRun < astarTimePerRun * 3, 'Potential Field solver should be reasonably fast');
});

test('PotentialFieldSolver: calculateSmartPlacementV2 honors potential field setting and routes successfully', () => {
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
    settings.shaft.routingAlgorithm = 'potential'; // Enable potential field solver
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
        modelId: 'model-pf-test',
        mesh,
        rootsTopZ: 2,
    });

    console.log('[TEST] calculateSmartPlacementV2 result:', {
        error: result.error,
        joints: result.joints,
        basePos: result.basePos,
    });

    assert.equal(result.error, undefined);
    assert.ok(result.joints && result.joints.length > 0, 'Should have joints routing around the sphere');
});

