import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { computeForceBudget, computeForceBudgetFromGraph, collectForceBudgetSurfaces } from '../autoSupport/forceBudget';
import { computeLayerPeelForceAndCop, type SupportGraph } from '../autoSupport/supportGraphStress';
import type { RepresentativeLayer, RepresentativeLayerProfile, StefanPressureField } from '../autoSupport/tractionOptimization';

function uniformField(): StefanPressureField {
    const nx = 4;
    const ny = 4;
    const pressure = new Float32Array(nx * ny).fill(1);
    return {
        minX: 0,
        minY: 0,
        cellMm: 1,
        nx,
        ny,
        pressure,
        peakPressureMm2: 1,
        meanPressureMm2: 1,
        integratedForceMm4: nx * ny,
        maskAreaMm2: nx * ny,
    };
}

function profileAt(zMm: number): RepresentativeLayerProfile {
    const layer: RepresentativeLayer = {
        zMm,
        areaMm2: 16,
        areaJumpRatio: 1,
        clusterSpanCount: 1,
        stefanField: uniformField(),
    };
    return { layers: [layer], peakAreaMm2: 16, sampledPlaneCount: 1 };
}

function flatIsland(): DetectedIsland {
    const points: Array<{ x: number; y: number; z?: number }> = [];
    for (let x = 0; x <= 4; x += 0.5) {
        for (let y = 0; y <= 4; y += 0.5) {
            points.push({ x, y, z: 10 });
        }
    }
    return {
        id: 'flat-16',
        source: 'overhang',
        contact: new THREE.Vector3(2, 2, 10),
        baseZ: 10,
        areaMm2: 16,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(points),
    };
}

const TIPS = [
    { entityId: 'a', pos: { x: 0.5, y: 1.5, z: 9 }, contactDiameterMm: 0.28 },
    { entityId: 'b', pos: { x: 3.5, y: 1.5, z: 9 }, contactDiameterMm: 0.28 },
];

test('splits the layer peel force across tips by nearest-cell area and conserves the total', () => {
    const profile = profileAt(10);
    const layerForceN = computeLayerPeelForceAndCop(profile.layers[0], 16).forceN;
    const report = computeForceBudget({ tips: TIPS, profile, islands: [flatIsland()], strengthMpa: 12 });

    assert.equal(report.rows.length, 2);
    assert.equal(report.layersEvaluated, 1);
    assert.equal(report.unattributedN, 0);
    assert.ok(Math.abs(report.totalDemandN - layerForceN) < 1e-6, 'demand conserves the layer force');
    for (const row of report.rows) {
        assert.ok(Math.abs(row.demandN - layerForceN / 2) < 1e-6, 'each half of the mask is one tip');
        assert.ok(row.utilizationPct < 100);
        assert.equal(row.addPoint, undefined, 'no addition below capacity');
    }
});

test('capacity is the weaker of the contact and the tip entity narrowest member', () => {
    const contactLimited = computeForceBudget({ tips: TIPS.slice(0, 1), profile: profileAt(10), islands: [], strengthMpa: 12 });
    const memberLimited = computeForceBudget({
        tips: [{ ...TIPS[0], memberDiameterMm: 0.2 }],
        profile: profileAt(10),
        islands: [],
        strengthMpa: 12,
    });

    assert.ok(Math.abs(contactLimited.rows[0].capacityN - 12 * Math.PI * 0.14 ** 2) < 1e-6);
    assert.ok(Math.abs(memberLimited.rows[0].capacityN - 12 * Math.PI * 0.1 ** 2) < 1e-6);
    assert.equal(memberLimited.rows[0].memberDiameterMm, 0.2);
});

test('over-budget tips carry an addition point on the down-facing surface in reach', () => {
    const report = computeForceBudget({
        tips: TIPS,
        profile: profileAt(10),
        islands: [flatIsland()],
        strengthMpa: 0.1,
    });

    assert.equal(report.overloadedTips, 2);
    assert.equal(report.skippedNoSurface, 0);
    for (const row of report.rows) {
        assert.ok(row.deficitN > 0);
        assert.ok(row.addPoint, 'addition point present');
        assert.equal(row.addPoint?.islandId, 'flat-16');
        assert.equal(row.addPoint?.steepFlat, false, 'a formation patch is class 1');
        assert.ok(Math.abs(row.addPoint!.pos.z - 10) < 1e-9);
        assert.deepEqual(row.addPoint?.normal, { x: 0, y: 0, z: -1 });
        assert.ok(row.addPoint!.snapMm <= 3.0 + 1e-9);
    }
});

test('a force-augmented steep flat is tagged as a class-2 add point', () => {
    const steep: DetectedIsland = {
        ...flatIsland(),
        id: 'steep-60',
        steepFlat: true,
        overhangAngleDeg: 60,
        surfaceNormal: { x: 0, y: Math.sin(Math.PI / 3), z: -Math.cos(Math.PI / 3) },
    };
    const report = computeForceBudget({
        tips: TIPS,
        profile: profileAt(10),
        islands: [steep],
        strengthMpa: 0.1,
    });
    assert.equal(report.overloadedTips, 2);
    for (const row of report.rows) {
        assert.equal(row.addPoint?.islandId, 'steep-60');
        assert.equal(row.addPoint?.steepFlat, true);
    }
});

test('collectForceBudgetSurfaces adds eligible steep flats and drops the unusable ones', () => {
    const formation: DetectedIsland = { ...flatIsland(), id: 'formation' };
    const steep60: DetectedIsland = { ...flatIsland(), id: 'steep-60', steepFlat: true, overhangAngleDeg: 60 };
    const steep80: DetectedIsland = { ...flatIsland(), id: 'steep-80', steepFlat: true, overhangAngleDeg: 80 };
    const interior: DetectedIsland = { ...flatIsland(), id: 'interior', steepFlat: true, overhangAngleDeg: 60, interior: true };
    const voxel: DetectedIsland = { ...flatIsland(), id: 'voxel', source: 'voxel', steepFlat: true, overhangAngleDeg: 60 };
    const surfaces = collectForceBudgetSurfaces([formation, steep60, steep80, interior, voxel], [formation]);
    assert.deepEqual(surfaces.map((island) => island.id), ['formation', 'steep-60']);
});

test('a layer with no active tip below it is reported as unattributed, not distributed', () => {
    const report = computeForceBudget({
        tips: TIPS.map((tip) => ({ ...tip, pos: { ...tip.pos, z: 20 } })),
        profile: profileAt(10),
        islands: [flatIsland()],
        strengthMpa: 12,
    });

    assert.equal(report.totalDemandN, 0);
    assert.ok(report.unattributedN > 0);
    assert.equal(report.overloadedTips, 0);
});

test('graph adapter takes contact diameters and the tip entity narrowest member', () => {
    const graph: SupportGraph = {
        nodes: [
            { id: 'n0', pos: { x: 0.5, y: 1.5, z: 9 }, kind: 'tip', fixed: false, entityId: 'leaf-1', tipContactDiameterMm: 0.25 },
            { id: 'n1', pos: { x: 3.5, y: 1.5, z: 9 }, kind: 'tip', fixed: false, entityId: 'leaf-2', tipContactDiameterMm: 0.28 },
        ],
        members: [
            { id: 'm0', entityId: 'leaf-1', entityKind: 'leaf', nodeA: 0, nodeB: 0, lengthMm: 5, diameterMm: 0.2, angleFromVerticalDeg: 0 },
            { id: 'm1', entityId: 'leaf-2', entityKind: 'leaf', nodeA: 1, nodeB: 1, lengthMm: 5, diameterMm: 0.9, angleFromVerticalDeg: 0 },
        ],
        rootCount: 0,
        tipCount: 2,
        braceCount: 0,
    };
    const report = computeForceBudgetFromGraph(graph, profileAt(10), [flatIsland()], 12);

    const byEntity = new Map(report.rows.map((row) => [row.entityId, row]));
    assert.ok(Math.abs(byEntity.get('leaf-1')!.capacityN - 12 * Math.PI * 0.1 ** 2) < 1e-6);
    assert.ok(Math.abs(byEntity.get('leaf-2')!.capacityN - 12 * Math.PI * 0.14 ** 2) < 1e-6);
});

test('report is deterministic and ordered worst-first', () => {
    const input = { tips: TIPS, profile: profileAt(10), islands: [flatIsland()], strengthMpa: 0.1 };
    const first = computeForceBudget(input);
    const second = computeForceBudget(input);

    assert.deepEqual(first, second);
    assert.ok(first.rows[0].utilizationPct >= first.rows[1].utilizationPct);
});
