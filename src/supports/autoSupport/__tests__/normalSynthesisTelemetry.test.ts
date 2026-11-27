import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '../../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../../volumeAnalysis/Islands/types';
import { accelerateGeometry, initializeBVH } from '../../../utils/bvh';
import { clearHistory } from '../../../history/historyStore';
import { resetKickstandsInState, resetStore } from '../../state';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { SupportState, Vec3 } from '../../types';
import { computeAutoSupportPlan } from '../autoPlace';
import { computeNormalSynthesisMetrics } from '../normalSynthesisTelemetry';
import type { NormalSynthesisSupportKind } from '../types';
import { parseArgs } from '../../../../scripts/bench-auto-supports';

const ALL_KINDS: readonly NormalSynthesisSupportKind[] = [
    'trunk',
    'branch',
    'leaf',
    'consolidationLeaf',
    'stump',
    'stick',
];

function emptySupportState(): SupportState {
    return {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        stumps: {},
        kickstands: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
    };
}

function makeDiskProfile(overrides?: Partial<Extract<SupportTipProfile, { type: 'disk' }>>): SupportTipProfile {
    return {
        type: 'disk',
        contactDiameterMm: 0.2,
        bodyDiameterMm: 0.5,
        lengthMm: 1.2,
        penetrationMm: 0.05,
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.35,
        standoffAngleThreshold: Math.PI / 4,
        ...overrides,
    };
}

function makeCone(
    id: string,
    normal: Vec3,
    surfaceNormal?: Vec3,
    diskLengthOverride?: number,
    profile: SupportTipProfile = makeDiskProfile(),
): ContactCone {
    return {
        id,
        pos: { x: 0, y: 0, z: 10 },
        normal,
        ...(surfaceNormal ? { surfaceNormal } : {}),
        ...(diskLengthOverride !== undefined ? { diskLengthOverride } : {}),
        profile,
    };
}

function dirFromDownAndAzimuth(leanDeg: number, azimuthDeg = 0): Vec3 {
    const leanRad = (leanDeg * Math.PI) / 180;
    const azRad = (azimuthDeg * Math.PI) / 180;
    return {
        x: Math.sin(leanRad) * Math.cos(azRad),
        y: Math.sin(leanRad) * Math.sin(azRad),
        z: -Math.cos(leanRad),
    };
}

test('computeNormalSynthesisMetrics returns zeroed metrics on empty state', () => {
    const state = emptySupportState();
    const metrics = computeNormalSynthesisMetrics(state, 'model-empty');

    assert.equal(metrics.mode, 'raw');
    assert.equal(metrics.leafCapOrbit, false);
    assert.deepEqual(metrics.overall, {
        count: 0,
        minMm: 0,
        p50Mm: 0,
        p90Mm: 0,
        p99Mm: 0,
        maxMm: 0,
        meanMm: 0,
        flushCount: 0,
        angleDrivenCount: 0,
        collisionDrivenCount: 0,
        extendedOver025Count: 0,
        maxClamped035Count: 0,
    });
    for (const kind of ALL_KINDS) {
        assert.deepEqual(metrics.byKind[kind], metrics.overall);
    }
    assert.deepEqual(metrics.coneDeviationFromSurfaceDeg, {
        count: 0,
        p50Deg: 0,
        p90Deg: 0,
        p99Deg: 0,
        maxDeg: 0,
        meanDeg: 0,
    });
    assert.deepEqual(metrics.surfaceLeanFromDownDeg, {
        downward0To30Count: 0,
        oblique30To60Count: 0,
        steep60To90Count: 0,
        upwardOver90Count: 0,
    });
    assert.equal(metrics.consolidationCandidates, 0);
    assert.equal(metrics.consolidationConvertedLeaves, 0);
    assert.equal(metrics.consolidationConvertedBranches, 0);
    assert.equal(metrics.consolidationBlockedCount, 0);
});

test('computeNormalSynthesisMetrics computes H1-H4 distributions, R-7 quantiles, lean buckets, and model isolation', () => {
    const state = emptySupportState();

    // 1) trunk: lean 0 deg, dev 0 deg, flush -> effective 0.100 mm
    state.trunks['t-1'] = {
        id: 't-1',
        modelId: 'm1',
        rootId: 'r-1',
        segments: [],
        contactCone: makeCone('c-t1', dirFromDownAndAzimuth(0), dirFromDownAndAzimuth(0)),
    };

    // 2) branch: lean 45 deg, dev 63 deg -> angleThickness 0.225 mm (<= 0.25)
    state.branches['b-1'] = {
        id: 'b-1',
        modelId: 'm1',
        parentKnotId: 'k-1',
        segments: [],
        contactCone: makeCone('c-b1', dirFromDownAndAzimuth(-18), dirFromDownAndAzimuth(45)),
    };

    // 3) regular leaf: lean 75 deg, dev 72 deg -> angleThickness 0.2875 mm (> 0.25, < 0.35)
    state.leaves['l-reg'] = {
        id: 'l-reg',
        modelId: 'm1',
        parentKnotId: 'k-1',
        contactCone: makeCone('c-l1', dirFromDownAndAzimuth(3), dirFromDownAndAzimuth(75)),
    };

    // 4) consolidation leaf: lean 100 deg, dev 0 deg, diskLengthOverride 0.30 mm -> collision-driven (> 0.25, < 0.35)
    state.leaves['l-con'] = {
        id: 'l-con',
        modelId: 'm1',
        parentKnotId: 'k-1',
        contactCone: makeCone('c-l2', dirFromDownAndAzimuth(100), dirFromDownAndAzimuth(100), 0.30),
    };

    // 5) stump: lean 90 deg (inclusive steep60To90), dev 85 deg -> angleThickness 0.350 mm (>= 0.35)
    state.stumps['sp-1'] = {
        id: 'sp-1',
        modelId: 'm1',
        rootPos: { x: 0, y: 0, z: 0 },
        rootBaseDiameter: 1,
        rootTopDiameter: 0.6,
        rootHeight: 1,
        joint: { id: 'j-1', pos: { x: 0, y: 0, z: 1 }, diameter: 0.6 },
        segments: [],
        contactCone: makeCone('c-sp1', dirFromDownAndAzimuth(5), dirFromDownAndAzimuth(90)),
    };

    // Distractor 1: another modelId (must be excluded)
    state.trunks['t-other'] = {
        id: 't-other',
        modelId: 'other-model',
        rootId: 'r-other',
        segments: [],
        contactCone: makeCone('c-other', dirFromDownAndAzimuth(0), dirFromDownAndAzimuth(0), 0.35),
    };

    // Distractor 2: disk-only twig on same model (must be excluded)
    state.twigs['tw-1'] = {
        id: 'tw-1',
        modelId: 'm1',
        segments: [],
        contactDiskA: {
            id: 'd-a',
            pos: { x: 0, y: 0, z: 5 },
            surfaceNormal: { x: 0, y: 0, z: -1 },
            coneAxis: { x: 0, y: 0, z: -1 },
            diskLengthOverride: 0.35,
            profile: {
                type: 'disk',
                diskThicknessMm: 0.1,
                maxStandoffMm: 0.35,
                standoffAngleThreshold: Math.PI / 4,
            },
            contactDiameterMm: 0.2,
        },
        contactDiskB: {
            id: 'd-b',
            pos: { x: 0, y: 0, z: 6 },
            surfaceNormal: { x: 0, y: 0, z: 1 },
            coneAxis: { x: 0, y: 0, z: 1 },
            profile: {
                type: 'disk',
                diskThicknessMm: 0.1,
                maxStandoffMm: 0.35,
                standoffAngleThreshold: Math.PI / 4,
            },
            contactDiameterMm: 0.2,
        },
    };

    const metrics = computeNormalSynthesisMetrics(state, 'm1', {
        mode: 'bisector',
        leafCapOrbit: true,
        consolidationLeafIds: new Set(['l-con', 'l-other-ignored']),
        consolidationCandidates: 7,
        consolidationConvertedLeaves: 1,
        consolidationConvertedBranches: 2,
        consolidationBlockedCount: 3,
    });

    assert.equal(metrics.mode, 'bisector');
    assert.equal(metrics.leafCapOrbit, true);
    assert.deepEqual(metrics.overall, {
        count: 5,
        minMm: 0.1,
        p50Mm: 0.2875,
        p90Mm: 0.33,
        p99Mm: 0.348,
        maxMm: 0.35,
        meanMm: 0.2525,
        flushCount: 1,
        angleDrivenCount: 3,
        collisionDrivenCount: 1,
        extendedOver025Count: 3,
        maxClamped035Count: 1,
    });

    // byKind parity with overall
    assert.equal(metrics.byKind.trunk.count, 1);
    assert.equal(metrics.byKind.trunk.flushCount, 1);
    assert.equal(metrics.byKind.branch.count, 1);
    assert.equal(metrics.byKind.branch.angleDrivenCount, 1);
    assert.equal(metrics.byKind.leaf.count, 1);
    assert.equal(metrics.byKind.leaf.angleDrivenCount, 1);
    assert.equal(metrics.byKind.consolidationLeaf.count, 1);
    assert.equal(metrics.byKind.consolidationLeaf.collisionDrivenCount, 1);
    assert.equal(metrics.byKind.stump.count, 1);
    assert.equal(metrics.byKind.stump.maxClamped035Count, 1);
    assert.equal(metrics.byKind.stick.count, 0);

    const sumByKind = (pick: (k: NormalSynthesisSupportKind) => number): number =>
        ALL_KINDS.reduce((sum, kind) => sum + pick(kind), 0);

    assert.equal(sumByKind((k) => metrics.byKind[k].count), metrics.overall.count);
    assert.equal(sumByKind((k) => metrics.byKind[k].flushCount), metrics.overall.flushCount);
    assert.equal(sumByKind((k) => metrics.byKind[k].angleDrivenCount), metrics.overall.angleDrivenCount);
    assert.equal(sumByKind((k) => metrics.byKind[k].collisionDrivenCount), metrics.overall.collisionDrivenCount);
    assert.equal(sumByKind((k) => metrics.byKind[k].extendedOver025Count), metrics.overall.extendedOver025Count);
    assert.equal(sumByKind((k) => metrics.byKind[k].maxClamped035Count), metrics.overall.maxClamped035Count);
    assert.equal(
        metrics.overall.flushCount + metrics.overall.angleDrivenCount + metrics.overall.collisionDrivenCount,
        metrics.overall.count,
    );

    assert.deepEqual(metrics.coneDeviationFromSurfaceDeg, {
        count: 5,
        p50Deg: 63,
        p90Deg: 79.8,
        p99Deg: 84.48,
        maxDeg: 85,
        meanDeg: 44,
    });

    assert.deepEqual(metrics.surfaceLeanFromDownDeg, {
        downward0To30Count: 1,
        oblique30To60Count: 1,
        steep60To90Count: 2,
        upwardOver90Count: 1,
    });

    assert.equal(metrics.consolidationCandidates, 7);
    assert.equal(metrics.consolidationConvertedLeaves, 1);
    assert.equal(metrics.consolidationConvertedBranches, 2);
    assert.equal(metrics.consolidationBlockedCount, 3);
});

test('computeNormalSynthesisMetrics includes both stick contactCones, skips sphere cones, and falls back when surfaceNormal absent', () => {
    const state = emptySupportState();
    state.sticks['stick-1'] = {
        id: 'stick-1',
        modelId: 'm1',
        segments: [],
        contactConeA: makeCone('ca', dirFromDownAndAzimuth(0)),
        contactConeB: makeCone('cb', dirFromDownAndAzimuth(120), dirFromDownAndAzimuth(120), 0.28),
    };
    state.trunks['t-sphere'] = {
        id: 't-sphere',
        modelId: 'm1',
        rootId: 'r-s',
        segments: [],
        contactCone: makeCone(
            'cs',
            dirFromDownAndAzimuth(0),
            dirFromDownAndAzimuth(0),
            undefined,
            {
                type: 'sphere',
                sphereRadiusRatio: 1.5,
                contactDiameterMm: 0.3,
                bodyDiameterMm: 0.6,
                lengthMm: 1.2,
                penetrationMm: 0.05,
            },
        ),
    };

    const metrics = computeNormalSynthesisMetrics(state, 'm1');
    assert.equal(metrics.overall.count, 2);
    assert.equal(metrics.byKind.stick.count, 2);
    assert.equal(metrics.byKind.stick.flushCount, 1);
    assert.equal(metrics.byKind.stick.collisionDrivenCount, 1);
    assert.equal(metrics.byKind.trunk.count, 0);
    assert.equal(metrics.surfaceLeanFromDownDeg.downward0To30Count, 1);
    assert.equal(metrics.surfaceLeanFromDownDeg.upwardOver90Count, 1);
});

test('bench-auto-supports parseArgs handles defaults, order independence, and invalid flags', () => {
    const defaults = parseArgs([]);
    assert.deepEqual(defaults.settings, {});

    const flagsBeforeSettings = parseArgs([
        '--normal-synthesis', 'crease-lock',
        '--leaf-cap-orbit', 'off',
        '--settings', '{"areaPerSupportMm2":20,"normalSynthesisMode":"raw","leafCapOrbit":true}',
    ]);
    assert.deepEqual(flagsBeforeSettings.settings, {
        areaPerSupportMm2: 20,
        normalSynthesisMode: 'crease-lock',
        leafCapOrbit: false,
    });

    const settingsBeforeFlags = parseArgs([
        '--settings', '{"areaPerSupportMm2":12}',
        '--normal-synthesis', 'macro-smooth',
        '--leaf-cap-orbit', 'on',
    ]);
    assert.deepEqual(settingsBeforeFlags.settings, {
        areaPerSupportMm2: 12,
        normalSynthesisMode: 'macro-smooth',
        leafCapOrbit: true,
    });

    assert.throws(() => parseArgs(['--normal-synthesis', 'invalid-mode']), /normal-synthesis/);
    assert.throws(() => parseArgs(['--leaf-cap-orbit', 'maybe']), /leaf-cap-orbit/);
    assert.throws(() => parseArgs(['--normal-synthesis']), /needs a value/);
    assert.throws(() => parseArgs(['--leaf-cap-orbit']), /needs a value/);
});

test('computeAutoSupportPlan preserves Arm 0 placement across normalSynthesisMode/leafCapOrbit and emits telemetry', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    const geometry = new THREE.BoxGeometry(12, 12, 6);
    geometry.translate(0, 0, 15);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);

    const points: { x: number; y: number }[] = [];
    for (let x = -5; x <= 5; x += 0.5) {
        for (let y = -5; y <= 5; y += 0.5) {
            points.push({ x, y });
        }
    }
    const islands: DetectedIsland[] = [
        {
            id: 'slab-1',
            source: 'overhang',
            contact: new THREE.Vector3(0, 0, 12),
            baseZ: 12,
            areaMm2: 144,
            surfaceNormal: { x: 0, y: 0, z: -1 },
            contactVoxels: footprintFromPoints(points),
        },
    ];

    const planDefault = computeAutoSupportPlan(islands, 'arm0-m', { debugSkipAutoBracing: true }, undefined, mesh);
    const planRawOff = computeAutoSupportPlan(
        islands,
        'arm0-m',
        { debugSkipAutoBracing: true, normalSynthesisMode: 'raw', leafCapOrbit: false },
        undefined,
        mesh,
    );
    const planBisectorOn = computeAutoSupportPlan(
        islands,
        'arm0-m',
        { debugSkipAutoBracing: true, normalSynthesisMode: 'bisector', leafCapOrbit: true },
        undefined,
        mesh,
    );
    const planNoop = computeAutoSupportPlan([], 'arm0-m', { normalSynthesisMode: 'bisector', leafCapOrbit: true }, undefined, mesh);

    assert.ok(planDefault && planRawOff && planBisectorOn && planNoop);
    assert.ok(planDefault.analytics.normalSynthesisMetrics, 'default run emits normalSynthesisMetrics');
    assert.ok(planRawOff.analytics.normalSynthesisMetrics, 'raw/off run emits normalSynthesisMetrics');
    assert.ok(planBisectorOn.analytics.normalSynthesisMetrics, 'bisector/on run emits normalSynthesisMetrics');
    assert.ok(planNoop.analytics.normalSynthesisMetrics, 'noopPlan emits normalSynthesisMetrics');

    assert.equal(planDefault.analytics.normalSynthesisMetrics.mode, 'raw');
    assert.equal(planDefault.analytics.normalSynthesisMetrics.leafCapOrbit, false);
    assert.equal(planRawOff.analytics.normalSynthesisMetrics.mode, 'raw');
    assert.equal(planRawOff.analytics.normalSynthesisMetrics.leafCapOrbit, false);
    assert.equal(planBisectorOn.analytics.normalSynthesisMetrics.mode, 'bisector');
    assert.equal(planBisectorOn.analytics.normalSynthesisMetrics.leafCapOrbit, true);

    assert.equal(planNoop.analytics.normalSynthesisMetrics.mode, 'bisector');
    assert.equal(planNoop.analytics.normalSynthesisMetrics.leafCapOrbit, true);
    assert.equal(planNoop.analytics.normalSynthesisMetrics.overall.count, 0);

    // Arm 0 placement invariance: placed counts and cone telemetry match identically across flags
    assert.deepEqual(planBisectorOn.result.placed, planRawOff.result.placed);
    assert.deepEqual(planDefault.result.placed, planRawOff.result.placed);
    assert.ok(planRawOff.analytics.normalSynthesisMetrics.overall.count > 0);
    assert.deepEqual(
        planBisectorOn.analytics.normalSynthesisMetrics.overall,
        planRawOff.analytics.normalSynthesisMetrics.overall,
    );
    assert.deepEqual(
        planBisectorOn.analytics.normalSynthesisMetrics.byKind,
        planRawOff.analytics.normalSynthesisMetrics.byKind,
    );
    assert.deepEqual(
        planBisectorOn.analytics.normalSynthesisMetrics.coneDeviationFromSurfaceDeg,
        planRawOff.analytics.normalSynthesisMetrics.coneDeviationFromSurfaceDeg,
    );
    assert.deepEqual(
        planBisectorOn.analytics.normalSynthesisMetrics.surfaceLeanFromDownDeg,
        planRawOff.analytics.normalSynthesisMetrics.surfaceLeanFromDownDeg,
    );
    assert.equal(
        planBisectorOn.analytics.normalSynthesisMetrics.consolidationCandidates,
        planRawOff.analytics.normalSynthesisMetrics.consolidationCandidates,
    );
    assert.equal(
        planBisectorOn.analytics.normalSynthesisMetrics.consolidationConvertedLeaves,
        planRawOff.analytics.normalSynthesisMetrics.consolidationConvertedLeaves,
    );
    assert.equal(
        planBisectorOn.analytics.normalSynthesisMetrics.consolidationConvertedBranches,
        planRawOff.analytics.normalSynthesisMetrics.consolidationConvertedBranches,
    );
    assert.equal(
        planBisectorOn.analytics.normalSynthesisMetrics.consolidationBlockedCount,
        planRawOff.analytics.normalSynthesisMetrics.consolidationBlockedCount,
    );
});
