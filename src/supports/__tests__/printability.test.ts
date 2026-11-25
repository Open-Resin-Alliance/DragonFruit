/**
 * Live printability is the demand side of the same question the beam solve
 * answers from the supply side: does every overhang footprint actually have a
 * tip under it? Its tests are about the verdict flipping when supports are
 * removed, the uncovered area it puts on the region, and the span proxy that
 * keeps a long unbraced extension visible even when one end is covered.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { evaluatePrintability } from '../autoSupport/printability';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { footprintFromPoints, type VoxelFootprint } from '../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { RepresentativeLayerProfile } from '../autoSupport/tractionOptimization';

const AREA_PER_SUPPORT_MM2 = 10;

function square(x: number, y: number, widthMm: number, heightMm: number, z: number): VoxelFootprint {
    const points: { x: number; y: number; z: number }[] = [];
    for (let dx = -widthMm / 2; dx <= widthMm / 2 + 1e-9; dx += 0.25) {
        for (let dy = -heightMm / 2; dy <= heightMm / 2 + 1e-9; dy += 0.25) {
            points.push({ x: x + dx, y: y + dy, z });
        }
    }
    return footprintFromPoints(points);
}

function overhang(
    id: string,
    baseZ: number,
    footprint: VoxelFootprint,
    overrides: Partial<DetectedIsland> = {},
): DetectedIsland {
    return {
        id,
        source: 'overhang',
        class: 'voxelOnly',
        contact: new THREE.Vector3(0, 0, baseZ),
        baseZ,
        overhangAngleDeg: 40,
        areaMm2: footprint.count * 0.0625,
        contactVoxels: footprint,
        ...overrides,
    } as DetectedIsland;
}

function stateWithTip(x: number, y: number, z: number, modelId = 'm'): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        trunks: {
            t1: {
                id: 't1',
                modelId,
                rootId: 'r1',
                segments: [{ id: 's1', diameter: 1.0 }],
                contactCone: {
                    id: 'c1',
                    pos: { x, y, z },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0 },
                },
            } as never,
        },
    };
}

function emptyState(): SupportState {
    return { ...createEmptySupportCollections(), selectedId: null, hoveredId: null };
}

test('a covered footprint reads ready', () => {
    const region = overhang('o1', 10, square(0, 0, 1, 1, 10));
    const report = evaluatePrintability({
        islands: [region],
        snapshot: stateWithTip(0, 0, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.verdict, 'ready');
    assert.equal(report.uncoveredRegions, 0);
    assert.equal(report.regions.length, 1);
    assert.equal(report.regions[0].coverage, 1, 'the only tip reaches every 1 mm footprint cell');
    assert.ok(report.loadBudget.totalCapacityMm2 > 0, 'the tip credits the region with capacity');
});

test('removing the only support flips the verdict and names the deficit region', () => {
    const region = overhang('o1', 10, square(0, 0, 3, 3, 10));
    const report = evaluatePrintability({
        islands: [region],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.verdict, 'critical', 'every square millimetre is bare and it is big enough to matter');
    assert.equal(report.uncoveredRegions, 1);
    assert.equal(report.regions[0].severity, 'critical');
    assert.equal(report.regions[0].coverage, 0);
    assert.ok(report.regions[0].uncoveredAreaMm2 >= 8);
    assert.equal(report.loadBudget.islandsInDeficit, 1);
    assert.equal(report.worst?.islandId, 'o1');
});

test('a support above the overhang does not hold it', () => {
    const region = overhang('o1', 10, square(0, 0, 1, 1, 10));
    const report = evaluatePrintability({
        islands: [region],
        snapshot: stateWithTip(0, 0, 14),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.regions[0].coverage, 0, 'a tip above the surface cannot hold it down');
    assert.equal(report.maxFreeSpanMm, 10, 'and nothing below is within the span cap');
});

test('a long arm with one tip at its end keeps a high free span', () => {
    const arm = overhang('o1', 20, square(0, 0, 10, 2, 20));
    const report = evaluatePrintability({
        islands: [arm],
        snapshot: stateWithTip(5, 0, 20),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    const region = report.regions[0];
    assert.ok(region.coverage < 0.95, 'one disc cannot cover a 10 mm arm');
    assert.equal(region.freeSpanMm, 10, 'the far end is at the cap');
    assert.equal(region.severity, 'critical', 'most of the arm has nothing under it');
    assert.equal(report.verdict, 'critical');
});

test('a bare toe pad smaller than a tip pair warns instead of crying critical', () => {
    const pad = overhang('o1', 10, square(0, 0, 1, 1, 10));
    const report = evaluatePrintability({
        islands: [pad],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.regions[0].severity, 'warn');
    assert.equal(report.verdict, 'underSupported');
});

test('frame overload alone reports overloaded, and with bare surface reads critical', () => {
    const region = overhang('o1', 10, square(0, 0, 1, 1, 10));
    const covered = evaluatePrintability({
        islands: [region],
        snapshot: stateWithTip(0, 0, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        frame: { maxTipUtilizationPct: 120, maxMemberUtilizationPct: 40 },
    });
    assert.equal(covered.verdict, 'overloaded');

    const bare = evaluatePrintability({
        islands: [overhang('o2', 10, square(0, 0, 3, 3, 10))],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        frame: { maxTipUtilizationPct: 120, maxMemberUtilizationPct: 40 },
    });
    assert.equal(bare.verdict, 'critical', 'no support and an overloaded frame is the worst pair');
});

test('the profile contributes peak peel and area-jump context, not the verdict', () => {
    const field = {
        minX: -1, minY: -1, cellMm: 0.25, nx: 8, ny: 8,
        pressure: new Float32Array(64), peakPressureMm2: 1, meanPressureMm2: 0.8,
        integratedForceMm4: 10, maskAreaMm2: 1,
    };
    const profile: RepresentativeLayerProfile = {
        layers: [
            { zMm: 12, areaMm2: 20, areaJumpRatio: 2.4, clusterSpanCount: 1, stefanField: field },
        ],
        peakAreaMm2: 20,
        sampledPlaneCount: 4,
    };
    const report = evaluatePrintability({
        islands: [overhang('o1', 10, square(0, 0, 1, 1, 10))],
        snapshot: stateWithTip(0, 0, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        profile,
    });

    assert.ok(report.peakPeelForceN > 0);
    assert.equal(report.peakPeelLayerZMm, 12);
    assert.equal(report.peakAreaJumpRatio, 2.4);
    assert.equal(report.verdict, 'ready', 'a real peel peak does not fail a fully supported footprint');
});

test('the model overlay is the Stefan adhesion only', () => {
    const noField = evaluatePrintability({
        islands: [overhang('o1', 10, square(0, 0, 3, 3, 10))],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });
    assert.equal(noField.peelOverlay, undefined, 'no sampled field, nothing painted — coverage is panel data, not surface paint');
});

test('a sampled Stefan field becomes a normalized plan overlay', () => {
    const field = {
        minX: -2, minY: -2, cellMm: 0.25, nx: 16, ny: 16,
        pressure: new Float32Array(256).fill(0.5),
        peakPressureMm2: 1, meanPressureMm2: 1,
        integratedForceMm4: 4, maskAreaMm2: 16,
    };
    field.pressure[0] = 1;
    const report = evaluatePrintability({
        islands: [overhang('o1', 10, square(0, 0, 1, 1, 10))],
        snapshot: stateWithTip(0, 0, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        profile: {
            layers: [{ zMm: 10, areaMm2: 16, areaJumpRatio: 1, clusterSpanCount: 1, stefanField: field }],
            peakAreaMm2: 16,
            sampledPlaneCount: 1,
        },
    });
    const overlay = report.peelOverlay;
    assert.ok(overlay, 'the field creates the overlay');
    assert.ok(overlay.peel.some((value) => value === 255), 'the field is normalized to its own peak');
    assert.ok(overlay.nx >= 8 && overlay.ny >= 8, 'a 4 mm field spans several 0.5 mm texels');
    assert.ok(
        overlay.minX <= 0 && overlay.minY <= 0 && overlay.minX + overlay.cellMm * (overlay.nx - 1) >= 0,
        'the footprint centre is inside the overlay',
    );
});

test('the footprint area is the island\'s, not the voxel count at the 0.25 mm grid', () => {
    // Overhang masks are sampled at the scan's pxMm (0.05 mm here): 900 cells
    // would read as 56 mm² at the voxel detector's cell size, but the region is
    // 3 × 3 mm.
    const points: { x: number; y: number; z: number }[] = [];
    for (let x = -1.5; x <= 1.5 + 1e-9; x += 0.05) {
        for (let y = -1.5; y <= 1.5 + 1e-9; y += 0.05) points.push({ x, y, z: 10 });
    }
    const dense = overhang('dense', 10, footprintFromPoints(points), { areaMm2: 9 });
    const report = evaluatePrintability({
        islands: [dense],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });
    assert.equal(report.regions[0].footprintAreaMm2, 9);
    assert.equal(report.uncoveredAreaMm2, 9, 'bare area is the region area, not the scan pitch squared');
});

test('the peel curve exists with no supports at all', () => {
    const field = {
        minX: -2, minY: -2, cellMm: 0.25, nx: 16, ny: 16,
        pressure: new Float32Array(256).fill(0.5),
        peakPressureMm2: 1, meanPressureMm2: 0.5,
        integratedForceMm4: 2, maskAreaMm2: 16,
    };
    const report = evaluatePrintability({
        islands: [overhang('o1', 10, square(0, 0, 1, 1, 10))],
        snapshot: emptyState(),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
        profile: {
            layers: [{ zMm: 10, areaMm2: 16, areaJumpRatio: 1, clusterSpanCount: 1, stefanField: field }],
            samples: [{ zMm: 10, areaMm2: 16 }, { zMm: 10.05, areaMm2: 20 }],
            peakAreaMm2: 20,
            sampledPlaneCount: 2,
        },
    });
    assert.equal(report.peelCurve.length, 2, 'one point per sampled layer');
    assert.equal(report.peelCurve[0].maxTipUtilPct, 0, 'no tips, no utilization');
    assert.ok(report.peakPeelForceN > 0);
    assert.ok(Math.abs(report.peakPeelLayerZMm - 10.05) < 1e-6, 'peak is the larger per-layer area');
    assert.equal(report.peelCurve.filter((point) => point.critical).length, 1, 'peak layer is marked');
});

test('a tiny uncovered rim inside the bridge span reads ready', () => {
    const pad = overhang('o1', 10, square(0, 0, 0.25, 0.25, 10));
    const report = evaluatePrintability({
        islands: [pad],
        snapshot: stateWithTip(3.8, 0, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.regions[0].severity, 'ok');
    assert.equal(report.uncoveredRegions, 0);
    assert.equal(report.verdict, 'ready');
});

test('a fully covered region is not short because its own budget row has no capacity', () => {
    const pad = overhang('o1', 10, square(0, 0, 1, 1, 10));
    const report = evaluatePrintability({
        islands: [pad],
        snapshot: stateWithTip(0, 2.3, 10),
        modelId: 'm',
        areaPerSupportMm2: AREA_PER_SUPPORT_MM2,
    });

    assert.equal(report.regions[0].coverage, 1);
    assert.equal(report.regions[0].severity, 'ok');
    assert.equal(report.deficientRegions, 0);
    assert.equal(report.verdict, 'ready');
});
