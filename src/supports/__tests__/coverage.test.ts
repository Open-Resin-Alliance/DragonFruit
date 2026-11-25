import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    collectSupportTips,
    computeRegionCoverage,
    findUncoveredClusters,
    buildGapFillCandidates,
    coverageRadiusForArea,
    TIP_COVERAGE_RADIUS_MM,
    REGION_COVERAGE_TARGET,
} from '../autoSupport/coverage';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { HIGH_LEVERAGE_SPAN_MM } from '../autoSupport/supportSpan';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import type { ContactCone, ContactDiskProfile } from '../SupportPrimitives/ContactCone/types';
import type { ContactDisk, SupportState, Vec3 } from '../types';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rectRegion(id: string, minX: number, maxX: number, minY: number, maxY: number, z: number = 10): DetectedIsland {
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = minX; x <= maxX; x += 0.25) {
        for (let y = minY; y <= maxY; y += 0.25) {
            contactVoxels.push({ x, y, z });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, z),
        baseZ: z,
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

test('a thin uncovered sliver below the area floor still counts as a gap when it spans', () => {
    // 5mm × 0.25mm bare line = 1.31mm², under MIN_GAP_CLUSTER_MM2 (1.5) but a
    // 5mm unsupported span. The old area-only floor dropped it.
    const voxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -2.5; x <= 2.5 + 1e-9; x += 0.25) voxels.push({ x, y: 0, z: 10 });
    const region: DetectedIsland = {
        ...rectRegion('sliver', -2.5, 2.5, 0, 0),
        areaMm2: 1.3125,
        contactVoxels: footprintFromPoints(voxels),
    };
    const tips = [{ x: 0, y: -10, z: 10 }];
    const clusters = findUncoveredClusters(region, tips);
    assert.equal(clusters.length, 1, 'thin long bare sliver is a gap cluster');
    assert.ok(5 >= HIGH_LEVERAGE_SPAN_MM);

    const candidates = buildGapFillCandidates([region], createDefaultAutoSupportSettings(), tips);
    assert.ok(candidates.some((c) => c.id.startsWith('gap-sliver')), 'sliver gets a gap candidate');
});

test('a covered region with a long free span still gets one span contact', () => {
    // 8×2mm sloped strip, tips 15mm below: grown 4.5mm discs cover every cell
    // (coverage target met) but the centre is 4.12mm from the nearest holding
    // tip, so the cantilever needs a contact of its own.
    const region: DetectedIsland = {
        ...rectRegion('bridge', -4, 4, -1, 1, 10),
        areaMm2: 16,
        overhangAngleDeg: 35,
    };
    const tips = [
        { x: -4, y: 0, z: -5 },
        { x: 4, y: 0, z: -5 },
    ];
    assert.ok(computeRegionCoverage(region, tips) >= REGION_COVERAGE_TARGET, 'coverage target met');

    const candidates = buildGapFillCandidates([region], createDefaultAutoSupportSettings(), tips);
    const span = candidates.filter((c) => c.id.startsWith('span-bridge'));
    assert.equal(span.length, 1, 'exactly one span contact at the longest free span');
    assert.ok(Math.abs(span[0].tipPos.x) < 0.3, 'span contact sits at the strip centre');
});

test('coverage target constant is below 1 so edge voxels do not force infinite fill', () => {
    assert.ok(REGION_COVERAGE_TARGET > 0 && REGION_COVERAGE_TARGET < 1);
});

test('tip influence grows with height above the tip on sloped overhangs and stays tight on flats', () => {
    const slopedRegion = { ...rectRegion('o0', -10, 10, -10, 10), overhangAngleDeg: 35 };
    // Same center tip at the sloped region plane: 3mm disc.
    const flat = computeRegionCoverage(slopedRegion, [{ x: 0, y: 0, z: 10 }]);
    // Same tip 15mm below the sloped region: capped +1.5mm growth -> 4.5mm disc (~2.25× area).
    const grown = computeRegionCoverage(slopedRegion, [{ x: 0, y: 0, z: -5 }]);
    assert.ok(grown > flat * 2, `grown coverage ${grown} > 2× flat ${flat}`);
    const expected = (Math.PI * 4.5 * 4.5) / 400;
    assert.ok(Math.abs(grown - expected) < 0.02, `grown coverage ${grown} ≈ ${expected}`);

    // Flat ceiling (0°): zero upward growth so lower tips never falsely cover higher flats.
    const flatCeiling = { ...rectRegion('f0', -10, 10, -10, 10), overhangAngleDeg: 0 };
    const flatAtZ = computeRegionCoverage(flatCeiling, [{ x: 0, y: 0, z: 10 }]);
    const flatBelow = computeRegionCoverage(flatCeiling, [{ x: 0, y: 0, z: -5 }]);
    assert.equal(flatBelow, flatAtZ, 'flat overhang does not grow influence upward with diffZ');
});

test('coverageRadiusForArea shrinks discs on large regions', () => {
    assert.equal(coverageRadiusForArea(0), TIP_COVERAGE_RADIUS_MM, 'empty area keeps base');
    assert.equal(coverageRadiusForArea(8), TIP_COVERAGE_RADIUS_MM, 'cell reference keeps base');
    assert.equal(coverageRadiusForArea(32), TIP_COVERAGE_RADIUS_MM / 2, '32mm² halves the radius');
    assert.equal(coverageRadiusForArea(400), TIP_COVERAGE_RADIUS_MM / 2, 'floored at half radius');
});
test('gap-fill packs large flats denser than small sloped regions', () => {
    // 4mm tip grid over a 20×20 footprint: on a small steep overhang (3mm bridge
    // radius) the discs overlap to full coverage → no fills; on a large flat
    // (1.5mm area-shrunk radius) only ~44% is covered → fills emitted.
    const tips = [];
    for (let x = -10; x <= 10; x += 4) {
        for (let y = -10; y <= 10; y += 4) {
            tips.push({ x, y, z: 10 });
        }
    }
    const settings = createDefaultAutoSupportSettings();
    const smallGaps = buildGapFillCandidates(
        [{ ...rectRegion('small', -10, 10, -10, 10), areaMm2: 4, overhangAngleDeg: 35 }], settings, tips);
    const bigGaps = buildGapFillCandidates(
        [{ ...rectRegion('big', -10, 10, -10, 10), areaMm2: 400, overhangAngleDeg: 0 }], settings, tips);
    assert.equal(smallGaps.length, 0, 'small sloped region fully covered at 3mm discs');
    assert.ok(bigGaps.length > 0, 'large flat needs fills at 1.5mm discs');
});

function makeCone(id: string, pos: Vec3): ContactCone {
    return {
        id,
        pos,
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: DEFAULT_TIP_PROFILE,
    };
}

const DISK_PROFILE: ContactDiskProfile = {
    type: 'disk',
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
};

function makeDisk(id: string, pos: Vec3): ContactDisk {
    return {
        id,
        pos,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        coneAxis: { x: 0, y: 0, z: -1 },
        profile: DISK_PROFILE,
        contactDiameterMm: 0.36,
    };
}

test('collectSupportTips walks all contact-bearing support types, selects upper bridge tips only, and scopes by modelId', () => {
    const state: SupportState = {
        roots: {},
        knots: {},
        trunks: {
            'tr-a': { id: 'tr-a', modelId: 'model-a', rootId: 'r1', segments: [], contactCone: makeCone('c-tr-a', { x: 1, y: 0, z: 20 }) },
            'tr-b': { id: 'tr-b', modelId: 'model-b', rootId: 'r2', segments: [], contactCone: makeCone('c-tr-b', { x: 1, y: 5, z: 30 }) },
        },
        branches: {
            'br-a': { id: 'br-a', modelId: 'model-a', parentKnotId: 'k1', segments: [], contactCone: makeCone('c-br-a', { x: 2, y: 0, z: 22 }) },
        },
        leaves: {
            'lf-a': { id: 'lf-a', modelId: 'model-a', parentKnotId: 'k2', contactCone: makeCone('c-lf-a', { x: 3, y: 0, z: 24 }) },
        },
        stumps: {
            'st-a': {
                id: 'st-a',
                modelId: 'model-a',
                rootPos: { x: 4, y: 0, z: 0 },
                rootBaseDiameter: 2,
                rootTopDiameter: 1,
                rootHeight: 1,
                joint: { id: 'j1', pos: { x: 4, y: 0, z: 1 }, diameter: 0.8 },
                segments: [],
                contactCone: makeCone('c-st-a', { x: 4, y: 0, z: 4 }),
            },
        },
        sticks: {
            'sk-a': {
                id: 'sk-a',
                modelId: 'model-a',
                segments: [],
                contactConeA: makeCone('c-sk-a-lo', { x: 5, y: 0, z: 6 }),
                contactConeB: makeCone('c-sk-a-hi', { x: 5, y: 0, z: 18 }),
            },
            'sk-b': {
                id: 'sk-b',
                modelId: 'model-b',
                segments: [],
                // Un-canonicalized literal (lower field has higher Z) to verify higher-Z fallback too.
                contactConeA: makeCone('c-sk-b-hi', { x: 5, y: 5, z: 28 }),
                contactConeB: makeCone('c-sk-b-lo', { x: 5, y: 5, z: 7 }),
            },
        },
        twigs: {
            'tw-a': {
                id: 'tw-a',
                modelId: 'model-a',
                segments: [],
                contactDiskA: makeDisk('d-tw-a-lo', { x: 6, y: 0, z: 8 }),
                contactDiskB: makeDisk('d-tw-a-hi', { x: 6, y: 0, z: 14 }),
            },
            'tw-b': {
                id: 'tw-b',
                modelId: 'model-b',
                segments: [],
                contactDiskA: makeDisk('d-tw-b-lo', { x: 6, y: 5, z: 9 }),
                contactDiskB: makeDisk('d-tw-b-hi', { x: 6, y: 5, z: 26 }),
            },
        },
        braces: {
            'bc-a': { id: 'bc-a', modelId: 'model-a', startKnotId: 'k1', endKnotId: 'k2', profile: { diameter: 0.5 } },
        },
        kickstands: {},
        selectedId: null,
        hoveredId: null,
    };

    const tipsA = collectSupportTips(state, 'model-a');
    const zA = tipsA.map((t) => t.z).sort((a, b) => a - b);
    assert.deepEqual(
        zA,
        [4, 14, 18, 20, 22, 24],
        'model-a includes trunk, branch, leaf, stump, stick upper (18), and twig upper (14), excluding lower feet (6, 8) and model-b',
    );

    const tipsAll = collectSupportTips(state);
    const zAll = tipsAll.map((t) => t.z).sort((a, b) => a - b);
    assert.deepEqual(
        zAll,
        [4, 14, 18, 20, 22, 24, 26, 28, 30],
        'unscoped call collects upper tips across both models while excluding all lower landing feet (6, 7, 8, 9)',
    );
});

test('upper-shelf tips more than 1mm above a lower overhang do not claim downward coverage even at dx=dy=0', () => {
    const regionAt12 = rectRegion('shelf12', -2, 2, -2, 2, 12);
    // Directly above center voxel (0, 0, 12) at z = 24 -> tip.z - vz = 12 > 1.0 -> zero coverage.
    assert.equal(computeRegionCoverage(regionAt12, [{ x: 0, y: 0, z: 24 }]), 0);

    // With another distant tip so tips.length > 0, all Z=12 voxels remain uncovered.
    const clusters = findUncoveredClusters(regionAt12, [
        { x: 0, y: 0, z: 24 },
        { x: 50, y: 50, z: 12 },
    ]);
    assert.equal(clusters.length, 1, 'lower shelf remains a single uncovered cluster beneath upper-shelf tip');
    assert.ok(Math.abs(clusters[0].x) < 1e-6 && Math.abs(clusters[0].y) < 1e-6, 'cluster centroid stays at (0, 0)');
    assert.equal(clusters[0].z, 12);

    // Local sloped-surface tolerance (tip.z - vz <= 1.0, e.g. vz = 10.0, tip.z = 10.8) still covers normally.
    const slopedRegion = rectRegion('slope10', -10, 10, -10, 10, 10);
    const slopedCov = computeRegionCoverage(slopedRegion, [{ x: 0, y: 0, z: 10.8 }]);
    assert.ok(slopedCov > 0, `expected sloped surface within 1mm tolerance to stay covered, got ${slopedCov}`);
});

test('buildGapFillCandidates emits rescue candidates even when zero tips were placed on an exterior overhang', () => {
    const region = rectRegion('rescue0', -5, 5, -5, 5, 10);
    const settings = createDefaultAutoSupportSettings();
    const candidates = buildGapFillCandidates([region], settings, []);

    assert.ok(candidates.length >= 1, 'zero-tip exterior overhang still receives >= 1 gap-fill rescue candidate');
    assert.equal(candidates[0].gridPoint, true);
    assert.equal(candidates[0].zHeight, 10);
});

test('perimeter-first fill puts contacts on a long flat foot end to end', () => {
    const region = rectRegion('foot', -5, 5, -1, 1, 12);
    region.perimeterLoops = [[[-5, -1, 12], [5, -1, 12], [5, 1, 12], [-5, 1, 12]]];
    region.overhangAngleDeg = 40;
    const settings = createDefaultAutoSupportSettings();
    const candidates = buildGapFillCandidates([region], settings, []);
    const xs = candidates.map((candidate) => candidate.tipPos.x);
    assert.ok(Math.min(...xs) <= -4.5, `toe gets a contact (min x ${Math.min(...xs)})`);
    assert.ok(Math.max(...xs) >= 4.5, `heel gets a contact (max x ${Math.max(...xs)})`);
    assert.ok(candidates.length >= 5, `perimeter sampled (${candidates.length} candidates)`);
    assert.ok(candidates.length <= 12, 'bounded per region');
    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const a = candidates[i].tipPos;
            const b = candidates[j].tipPos;
            assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 1.0, 'contacts are spaced, not stacked');
        }
    }
});

test('perimeter fill skips the stretch already covered by a tip', () => {
    const region = rectRegion('foot', -5, 5, -1, 1, 12);
    region.perimeterLoops = [[[-5, -1, 12], [5, -1, 12], [5, 1, 12], [-5, 1, 12]]];
    region.overhangAngleDeg = 40;
    const settings = createDefaultAutoSupportSettings();
    const candidates = buildGapFillCandidates([region], settings, [{ x: 0, y: 0, z: 12 }]);
    assert.ok(candidates.length > 0, 'the uncovered ends still need contacts');
    assert.ok(candidates.every((candidate) => Math.abs(candidate.tipPos.x) > 1.0),
        'nothing is placed inside the covered middle');
});
