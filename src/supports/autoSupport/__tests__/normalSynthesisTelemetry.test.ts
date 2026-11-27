import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '../../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../../volumeAnalysis/Islands/types';
import { accelerateGeometry, initializeBVH } from '../../../utils/bvh';
import { clearHistory } from '../../../history/historyStore';
import { resetKickstandsInState, resetStore } from '../../state';
import { getSettings, setSettings } from '../../Settings/state';
import { createDefaultSettings } from '../../Settings/types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { SupportState, Vec3 } from '../../types';
import { collectFanShaftPoints, computeAutoSupportPlan, fanLeafToHost } from '../autoPlace';
import { closestSurfaceNormal } from '../closestSurfaceNormal';
import { generateGridCandidates } from '../gridPlacement';
import { computeNormalSynthesisMetrics } from '../normalSynthesisTelemetry';
import { createDefaultAutoSupportSettings } from '../settings';
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

function collectBottomTriangleIds(mesh: THREE.Mesh, minDownDot = 0.9): number[] {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const ids: number[] = [];
    for (let f = 0; f < triCount; f++) {
        const i0 = index ? index.getX(f * 3) : f * 3;
        const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
        const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);
        n.crossVectors(b.clone().sub(a), c.clone().sub(a)).applyMatrix3(normalMatrix).normalize();
        if (-n.z >= minDownDot) ids.push(f);
    }
    return ids;
}

function makeOpenBentSheetMesh(): THREE.Mesh {
    // Open 2-triangle sheet facing +Z (flat x in [-5, 0] at z=12) meeting a 60°-sloped flank
    // (x in [0, 2.5] dropping to z = 12 - 2.5*sqrt(3)): upward rays pass from behind -> downHit runs.
    const dropZ = 2.5 * Math.sqrt(3);
    const positions = new Float32Array([
        // Flat triangle 1: (-5,-5,12) -> (0,-5,12) -> (0,5,12), normal (0,0,1)
        -5, -5, 12,
        0, -5, 12,
        0, 5, 12,
        // Flat triangle 2: (-5,-5,12) -> (0,5,12) -> (-5,5,12), normal (0,0,1)
        -5, -5, 12,
        0, 5, 12,
        -5, 5, 12,
        // 60° flank triangle 1: (0,-5,12) -> (2.5,-5,12-dropZ) -> (2.5,5,12-dropZ), normal (sqrt(3)/2, 0, 0.5)
        0, -5, 12,
        2.5, -5, 12 - dropZ,
        2.5, 5, 12 - dropZ,
        // 60° flank triangle 2: (0,-5,12) -> (2.5,5,12-dropZ) -> (0,5,12), normal (sqrt(3)/2, 0, 0.5)
        0, -5, 12,
        2.5, 5, 12 - dropZ,
        0, 5, 12,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('computeAutoSupportPlan --normal-synthesis raw matches Arm 0 placement/metrics while default resolves to bisector', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
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
        const planRaw = computeAutoSupportPlan(
            islands,
            'arm0-m',
            { debugSkipAutoBracing: true, normalSynthesisMode: 'raw', leafCapOrbit: false },
            undefined,
            mesh,
        );
        const planUiOff = computeAutoSupportPlan(
            islands,
            'arm0-m',
            { debugSkipAutoBracing: true, smoothContactNormals: false },
            undefined,
            mesh,
        );
        const planNoopDefault = computeAutoSupportPlan([], 'arm0-m', {}, undefined, mesh);
        const planNoopOverride = computeAutoSupportPlan([], 'arm0-m', { normalSynthesisMode: 'crease-lock', leafCapOrbit: true }, undefined, mesh);

        assert.ok(planDefault && planRaw && planUiOff && planNoopDefault && planNoopOverride);
        assert.ok(planDefault.analytics.normalSynthesisMetrics);
        assert.ok(planRaw.analytics.normalSynthesisMetrics);
        assert.ok(planUiOff.analytics.normalSynthesisMetrics);
        assert.ok(planNoopDefault.analytics.normalSynthesisMetrics);
        assert.ok(planNoopOverride.analytics.normalSynthesisMetrics);

        assert.equal(planDefault.analytics.normalSynthesisMetrics.mode, 'bisector');
        assert.equal(planDefault.analytics.normalSynthesisMetrics.leafCapOrbit, false);

        assert.equal(planRaw.analytics.normalSynthesisMetrics.mode, 'raw');
        assert.equal(planRaw.analytics.normalSynthesisMetrics.leafCapOrbit, false);
        assert.ok(planRaw.analytics.normalSynthesisMetrics.overall.count > 0);
        assert.equal(
            planRaw.analytics.normalSynthesisMetrics.surfaceLeanFromDownDeg.downward0To30Count,
            planRaw.analytics.normalSynthesisMetrics.overall.count,
        );
        assert.equal(planRaw.analytics.normalSynthesisMetrics.surfaceLeanFromDownDeg.oblique30To60Count, 0);

        assert.equal(planUiOff.analytics.normalSynthesisMetrics.mode, 'raw');
        assert.equal(planUiOff.analytics.normalSynthesisMetrics.leafCapOrbit, false);
        assert.deepEqual(planUiOff.result.placed, planRaw.result.placed);
        assert.deepEqual(planUiOff.analytics.normalSynthesisMetrics, planRaw.analytics.normalSynthesisMetrics);

        assert.equal(planNoopDefault.analytics.normalSynthesisMetrics.mode, 'bisector');
        assert.equal(planNoopDefault.analytics.normalSynthesisMetrics.leafCapOrbit, false);
        assert.equal(planNoopDefault.analytics.normalSynthesisMetrics.overall.count, 0);

        assert.equal(planNoopOverride.analytics.normalSynthesisMetrics.mode, 'crease-lock');
        assert.equal(planNoopOverride.analytics.normalSynthesisMetrics.leafCapOrbit, true);
        assert.equal(planNoopOverride.analytics.normalSynthesisMetrics.overall.count, 0);
    } finally {
        setSettings(prevSettings);
    }
});

test('bisector synthesizes normals across multi-triangle features (upHit, downHit outward-before-negate, and closestSurfaceNormal)', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // 1) Underside upHit near 90° box crease: x=4.95 is 0.05 mm from +X wall at x=5.
        const boxGeo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
        boxGeo.translate(0, 0, 17);
        boxGeo.computeVertexNormals();
        accelerateGeometry(boxGeo);
        const boxMesh = new THREE.Mesh(boxGeo);
        boxMesh.updateMatrixWorld(true);

        const edgeUpIsland: DetectedIsland[] = [
            {
                id: 'edge-up',
                source: 'voxel',
                class: 'voxelOnly',
                isDetached: true,
                contact: new THREE.Vector3(4.95, 0, 12),
                baseZ: 12,
                areaMm2: 0.5,
            },
        ];

        const baseOverride = {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        };
        const planRaw = computeAutoSupportPlan(
            edgeUpIsland,
            'feat-up',
            { ...baseOverride, normalSynthesisMode: 'raw', leafCapOrbit: false },
            undefined,
            boxMesh,
        );
        const planBisector = computeAutoSupportPlan(
            edgeUpIsland,
            'feat-up',
            { ...baseOverride, normalSynthesisMode: 'bisector', leafCapOrbit: false },
            undefined,
            boxMesh,
        );

        assert.ok(planRaw && planBisector);
        const rawMetrics = planRaw.analytics.normalSynthesisMetrics!;
        const bisMetrics = planBisector.analytics.normalSynthesisMetrics!;
        assert.equal(rawMetrics.mode, 'raw');
        assert.equal(bisMetrics.mode, 'bisector');

        const rawTrunk = Object.values(planRaw.support.trunks)[0];
        const bisTrunk = Object.values(planBisector.support.trunks)[0];
        assert.ok(rawTrunk?.contactCone?.surfaceNormal && bisTrunk?.contactCone?.surfaceNormal);
        assert.ok(Math.abs(rawTrunk.contactCone.surfaceNormal.x) < 1e-6, 'raw keeps flat bottom normal');
        assert.ok(rawTrunk.contactCone.surfaceNormal.z < -0.99);
        assert.ok(
            bisTrunk.contactCone.surfaceNormal.x > 0.5 && bisTrunk.contactCone.surfaceNormal.z < -0.5,
            `bisector must tilt ~45° toward +X wall, got (${bisTrunk.contactCone.surfaceNormal.x.toFixed(3)}, ${bisTrunk.contactCone.surfaceNormal.y.toFixed(3)}, ${bisTrunk.contactCone.surfaceNormal.z.toFixed(3)})`,
        );
        assert.equal(rawMetrics.surfaceLeanFromDownDeg.oblique30To60Count, 0);
        assert.ok(bisMetrics.surfaceLeanFromDownDeg.oblique30To60Count >= 1);

        // 2) Top-surface downHit via fanLeafToHost (L4079): synthesize outward (z > 0) BEFORE negating.
        const sheetMesh = makeOpenBentSheetMesh();
        const hostState = emptySupportState();
        hostState.roots['r-sheet'] = {
            id: 'r-sheet',
            modelId: 'feat-down',
            transform: { pos: { x: -2, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
            diameter: 2,
            diskHeight: 0.5,
            coneHeight: 1.0,
        };
        hostState.trunks['t-sheet'] = {
            id: 't-sheet',
            modelId: 'feat-down',
            rootId: 'r-sheet',
            segments: [
                {
                    id: 'seg-sheet',
                    diameter: 1.0,
                    bottomJoint: { id: 'j0', pos: { x: -2, y: 0, z: 1.5 }, diameter: 1.0 },
                    topJoint: { id: 'j1', pos: { x: -2, y: 0, z: 10 }, diameter: 1.0 },
                },
            ],
            contactCone: makeCone('c-sheet', { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }),
        };
        const sheetPool = collectFanShaftPoints(hostState);
        const fanDownRaw = fanLeafToHost(
            { x: -0.05, y: 0, z: 12 },
            'feat-down',
            sheetPool,
            new Set(),
            'k-down-raw',
            6,
            6,
            45,
            6,
            hostState,
            sheetMesh,
            'island',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'raw' },
        );
        const fanDownBis = fanLeafToHost(
            { x: -0.05, y: 0, z: 12 },
            'feat-down',
            sheetPool,
            new Set(),
            'k-down-bis',
            6,
            6,
            45,
            6,
            hostState,
            sheetMesh,
            'island',
            'steepest',
            undefined,
            undefined,
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'bisector' },
        );
        assert.equal(fanDownRaw.ok, true);
        assert.equal(fanDownBis.ok, true);
        if (fanDownRaw.ok && fanDownBis.ok && fanDownRaw.kind === 'leaf' && fanDownBis.kind === 'leaf') {
            const rawLeafSn = fanDownRaw.draft.leaves[fanDownRaw.entityId]?.contactCone?.surfaceNormal;
            const bisLeafSn = fanDownBis.draft.leaves[fanDownBis.entityId]?.contactCone?.surfaceNormal;
            assert.ok(rawLeafSn && bisLeafSn);
            assert.ok(Math.abs(rawLeafSn.x) < 1e-6 && rawLeafSn.z < -0.99);
            // Outward raw (0,0,1) bisected with 60° flank (sqrt(3)/2, 0, 0.5) -> outward (0.5, 0, sqrt(3)/2),
            // then negated to (-0.5, 0, -sqrt(3)/2).
            assert.ok(
                bisLeafSn.x < -0.35 && bisLeafSn.z < -0.7,
                `downHit must synthesize outward normal before negating, got (${bisLeafSn.x.toFixed(3)}, ${bisLeafSn.y.toFixed(3)}, ${bisLeafSn.z.toFixed(3)})`,
            );
        }

        // 3) closestSurfaceNormal defaults to raw when omitted and synthesizes when options provided.
        const rawClosest = closestSurfaceNormal(boxMesh, new THREE.Vector3(4.95, 0, 12));
        const bisClosest = closestSurfaceNormal(boxMesh, new THREE.Vector3(4.95, 0, 12), {
            mode: 'bisector',
            contactRadiusMm: 0.2,
        });
        assert.ok(rawClosest && bisClosest);
        assert.ok(Math.abs(rawClosest.x) < 1e-6 && rawClosest.z < -0.99);
        assert.ok(bisClosest.x > 0.5 && bisClosest.z < -0.5);
    } finally {
        setSettings(prevSettings);
    }
});

test('gridPlacement.generateGridCandidates synthesizes grid tipNormals when bisector is active and gates devTools', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    initializeBVH();

    try {
        const geometry = new THREE.BoxGeometry(10, 10, 6).toNonIndexed();
        geometry.translate(0, 0, 15);
        geometry.computeVertexNormals();
        accelerateGeometry(geometry);
        const mesh = new THREE.Mesh(geometry);
        mesh.updateMatrixWorld(true);

        const bottomTriIds = collectBottomTriangleIds(mesh);
        assert.ok(bottomTriIds.length >= 2);

        const points: { x: number; y: number }[] = [];
        for (let x = -5; x <= 5; x += 0.25) {
            for (let y = -5; y <= 5; y += 0.25) {
                points.push({ x, y });
            }
        }
        const island: DetectedIsland = {
            id: 'grid-box',
            source: 'overhang',
            contact: new THREE.Vector3(0, 0, 12),
            baseZ: 12,
            areaMm2: 100,
            surfaceNormal: { x: 0, y: 0, z: -1 },
            triangleIds: bottomTriIds,
            contactVoxels: footprintFromPoints(points),
        };

        const rawCands = generateGridCandidates(
            [island],
            { ...createDefaultAutoSupportSettings(), normalSynthesisMode: 'raw' },
            mesh,
        );
        assert.ok(rawCands.length > 0);
        for (const c of rawCands) {
            assert.ok(Math.hypot(c.tipNormal.x, c.tipNormal.y) < 1e-6 && c.tipNormal.z < -0.99);
        }

        const bisCands = generateGridCandidates(
            [island],
            { ...createDefaultAutoSupportSettings(), smoothContactNormals: true, normalSynthesisPreset: 'bisector' },
            mesh,
        );
        assert.equal(bisCands.length, rawCands.length);
        const tilted = bisCands.filter((c) => Math.hypot(c.tipNormal.x, c.tipNormal.y) > 0.05);
        assert.ok(tilted.length > 0, 'boundary grid candidates near 90° walls must synthesize tilted tipNormals under bisector');

        // devTools overrides must apply ONLY when devToolsEnabled === true
        const defaults = createDefaultSettings();
        setSettings({
            ...defaults,
            devToolsEnabled: false,
            devTools: { ...defaults.devTools, normalCreaseThresholdDeg: 60 },
        });
        const devOffCands = generateGridCandidates(
            [island],
            { ...createDefaultAutoSupportSettings(), smoothContactNormals: true, normalSynthesisPreset: 'bisector' },
            mesh,
        );
        assert.ok(
            devOffCands.some((c) => Math.hypot(c.tipNormal.x, c.tipNormal.y) > 0.05),
            'normalCreaseThresholdDeg=60 ignored when devToolsEnabled=false',
        );

        setSettings({
            ...defaults,
            devToolsEnabled: true,
            devTools: { ...defaults.devTools, normalCreaseThresholdDeg: 60 },
        });
        const devOnCands = generateGridCandidates(
            [island],
            { ...createDefaultAutoSupportSettings(), smoothContactNormals: true, normalSynthesisPreset: 'bisector' },
            mesh,
        );
        for (const c of devOnCands) {
            assert.ok(
                Math.hypot(c.tipNormal.x, c.tipNormal.y) < 1e-6,
                'normalCreaseThresholdDeg=60 rejects 90° wall when devToolsEnabled=true',
            );
        }
    } finally {
        setSettings(prevSettings);
    }
});

test('autoPlace L5225 self-support wall filter stays invariant between raw and macro-smooth', () => {
    const prevSettings = getSettings();
    setSettings(createDefaultSettings());
    resetStore();
    resetKickstandsInState();
    clearHistory();
    initializeBVH();

    try {
        // Box rotated +50° around X: original bottom face (-Z) tilts to 50° inclination (>45.5° self-supporting),
        // meeting original -Y face (40° inclination) at a 90° crease.
        // Contact 0.15 mm onto the 50° flank sits well inside macro-smooth radius (0.75-2.5 mm), so synthesizing
        // inside L5225 would average 50° and 40° to ~5° and falsely keep the island.
        const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
        geo.rotateX(THREE.MathUtils.degToRad(50));
        geo.translate(0, 0, 15);
        geo.computeVertexNormals();
        accelerateGeometry(geo);
        const mesh = new THREE.Mesh(geo);
        mesh.updateMatrixWorld(true);

        const rad50 = THREE.MathUtils.degToRad(50);
        const yLocal = -4.85;
        const zLocal = -5;
        const contactY = yLocal * Math.cos(rad50) - zLocal * Math.sin(rad50);
        const contactZ = yLocal * Math.sin(rad50) + zLocal * Math.cos(rad50) + 15;

        const steepFlankIsland: DetectedIsland = {
            id: 'steep-50',
            source: 'voxel',
            class: 'voxelOnly',
            isDetached: false,
            interior: false,
            contact: new THREE.Vector3(0, contactY, contactZ),
            baseZ: contactZ,
            areaMm2: 0.5,
        };

        const overrideBase = {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        };
        const planRaw = computeAutoSupportPlan(
            [steepFlankIsland],
            'wall-raw',
            { ...overrideBase, normalSynthesisMode: 'raw', leafCapOrbit: false },
            undefined,
            mesh,
        );
        const planMacro = computeAutoSupportPlan(
            [steepFlankIsland],
            'wall-macro',
            { ...overrideBase, normalSynthesisMode: 'macro-smooth', leafCapOrbit: false },
            undefined,
            mesh,
        );

        assert.ok(planRaw && planMacro);
        assert.equal(planRaw.result.status, 'no-candidates');
        assert.equal(planMacro.result.status, 'no-candidates');
        assert.deepEqual(planMacro.result.placed, planRaw.result.placed);
    } finally {
        setSettings(prevSettings);
    }
});
