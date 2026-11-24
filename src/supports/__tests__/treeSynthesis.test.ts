import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import {
    collectBranchFanShaftPoints,
    collectFanShaftPoints,
    computeAutoSupportPlan,
    fanLeafToHost,
    syncContactConeDiameters,
    validateAndCullOrphans,
} from '../autoSupport/autoPlace';
import {
    MIN_TRUNK_SPACING_MM,
    bridgeRadiusForAngleDeg,
} from '../autoSupport/constants';
import {
    computeRegionCoverage,
    coverageRadiusForRegion,
} from '../autoSupport/coverage';
import {
    generateGridCandidates,
    sampleBoundary2D,
    shouldUseDensityGrid,
} from '../autoSupport/gridPlacement';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import {
    findOffsetSilhouetteRoute,
    isTooCloseToExistingTrunk,
    MAX_UNBRACED_BRANCH_SPAN_MM,
    maxEulerBucklingSpanMm,
    maxStableAngleForSpanDeg,
    minStableRiseForLateralMm,
    synthesizeTreeClusters,
} from '../autoSupport/treeSynthesis';
import type { CandidatePoint } from '../autoSupport/types';
import { setSettings, getSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { resetKickstandsInState, resetStore } from '../state';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';

function makeCandidate(
    id: string,
    x: number,
    y: number,
    z: number,
    overrides: Partial<CandidatePoint> = {},
): CandidatePoint {
    return {
        id,
        tipPos: { x, y, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'overhang',
        islandAreaMm2: 1.0,
        zHeight: z,
        priority: 0.5,
        ...overrides,
    };
}

function makeScallopedFootSole(z = 15): DetectedIsland {
    // 4 × 3 mm (12 mm²) scalloped foot sole at Z = 15 mm with sharp toe corners at y = +1.5.
    const voxels: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -2.0; x <= 2.0; x += 0.25) {
        for (let y = -1.5; y <= 1.5; y += 0.25) {
            voxels.push({ x, y, z });
        }
    }
    // Scalloped polygon (CCW) with distinct convex toe peaks along y = +1.5.
    const loop: Array<[number, number, number]> = [
        [-2.0, -1.5, z],
        [2.0, -1.5, z],
        [2.0, 1.5, z],
        [1.0, 0.8, z],
        [0.0, 1.5, z],
        [-1.0, 0.8, z],
        [-2.0, 1.5, z],
    ];
    return {
        id: 'foot-sole',
        source: 'overhang',
        contact: new THREE.Vector3(0, -1.5, z),
        baseZ: z,
        maxZ: z,
        areaMm2: 12.0,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(voxels),
        perimeterLoops: [loop],
    };
}

test('Phase 1: 4×3mm scalloped foot sole enters perimeter sampling, pins convex toe corners, and fails bare-forefoot flat coverage', () => {
    const settings = createDefaultAutoSupportSettings();
    const sole = makeScallopedFootSole(15);

    assert.equal(shouldUseDensityGrid(sole, settings), true, '12 mm² foot sole enters perimeter+infill sampling');

    // Corner-first boundary sampler pins the sharp convex toe tips along y = +1.5.
    const boundaryPts = sampleBoundary2D(sole.perimeterLoops, 2.5, (x, y) => ({ x, y, z: 15 })) ?? [];
    const toePinned = boundaryPts.filter((p) => p.y > 1.2);
    assert.ok(toePinned.length >= 2, `convex toe peaks pinned by sampleBoundary2D (got ${toePinned.length})`);

    const candidates = generateGridCandidates([sole], settings);
    assert.ok(candidates.length >= 4, `foot sole emits perimeter + infill contacts (got ${candidates.length})`);
    assert.ok(candidates.some((c) => c.tipPos.y > 0.8), 'forefoot / toe area receives contacts');

    // Angle-dependent flat bridge radius (1.8 mm) refuses fake 100% coverage when only the heel is supported.
    assert.equal(bridgeRadiusForAngleDeg(0), 1.8);
    assert.ok(bridgeRadiusForAngleDeg(25) > 1.8 && bridgeRadiusForAngleDeg(25) < 3.0);
    assert.equal(bridgeRadiusForAngleDeg(40), 3.0);

    const flatRadius = coverageRadiusForRegion(sole);
    assert.ok(flatRadius <= 1.81, `flat sole coverage radius stays tight (${flatRadius}mm)`);
    const heelOnlyCoverage = computeRegionCoverage(sole, [{ x: 0, y: -1.5, z: 15 }], flatRadius);
    assert.ok(heelOnlyCoverage < 0.75,
        `bare forefoot must fail flat coverage when only heel is supported (got ${(heelOnlyCoverage * 100).toFixed(1)}%)`);
});

test('Phase 2: synthesizeTreeClusters collapses a 6×6mm contact patch into well-spaced trunks and enforces distinct grid nodes', () => {
    const patch: CandidatePoint[] = [];
    for (let xi = 0; xi < 4; xi++) {
        for (let yi = 0; yi < 3; yi++) {
            patch.push(makeCandidate(`p-${xi}-${yi}`, xi * 1.8, yi * 1.8, 16));
        }
    }

    const organic = synthesizeTreeClusters(patch, {
        maxAngleFromVerticalDeg: 45,
        maxReachMm: 8,
        maxAttachmentsPerTrunk: 12,
        minTrunkSpacingMm: MIN_TRUNK_SPACING_MM,
    });

    assert.ok(organic.trunkAnchors.length >= 1 && organic.trunkAnchors.length <= 3,
        `12 contacts over 6×6mm collapse to 1–3 trunks (got ${organic.trunkAnchors.length})`);
    assert.equal(
        organic.trunkAnchors.length + organic.clusteredMembers.length,
        patch.length,
        'every elevated contact is assigned as an anchor or clustered member',
    );
    for (let i = 0; i < organic.trunkAnchors.length; i++) {
        for (let j = i + 1; j < organic.trunkAnchors.length; j++) {
            const a = organic.trunkAnchors[i].tipPos;
            const b = organic.trunkAnchors[j].tipPos;
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            assert.ok(dist >= MIN_TRUNK_SPACING_MM - 1e-6,
                `organic cluster trunks respect >= ${MIN_TRUNK_SPACING_MM}mm spacing (got ${dist.toFixed(2)}mm)`);
        }
    }

    // Grid mode snaps cluster trunks to distinct grid intersections.
    const gridCfg = { enabled: true, spacingMm: 2.5 };
    assert.equal(isTooCloseToExistingTrunk(0.4, 0.4, [{ x: 0.1, y: 0.1 }], 2.5, gridCfg), true,
        'points snapping to the same grid node collide');
    assert.equal(isTooCloseToExistingTrunk(2.6, 0.1, [{ x: 0.1, y: 0.1 }], 2.5, gridCfg), false,
        'adjacent distinct grid nodes do not collide');

    const gridPlan = synthesizeTreeClusters(patch, {
        maxAngleFromVerticalDeg: 30,
        maxReachMm: 4,
        maxAttachmentsPerTrunk: 12,
        grid: gridCfg,
    });
    const nodeKeys = new Set(
        gridPlan.trunkAnchors.map((a) => `${Math.round(a.tipPos.x / 2.5)},${Math.round(a.tipPos.y / 2.5)}`),
    );
    assert.equal(nodeKeys.size, gridPlan.trunkAnchors.length, 'every grid cluster trunk occupies a distinct grid node');
});

test('Phase 2: synthesizeTreeClusters prefers lower-Z leading edge on slopes and prioritizes discrete islands over overhangs', () => {
    const lowSlope = makeCandidate('slope-low', 0, 0, 12, { source: 'voxel', priority: 0.5 });
    const highSlope = makeCandidate('slope-high', 3, 0, 15, { source: 'voxel', priority: 0.5 });
    const slopePlan = synthesizeTreeClusters([highSlope, lowSlope], {
        maxAngleFromVerticalDeg: 45,
        maxReachMm: 8,
        maxAttachmentsPerTrunk: 12,
    });
    assert.equal(slopePlan.trunkAnchors.length, 1);
    assert.equal(slopePlan.trunkAnchors[0].id, 'slope-low', 'lower-Z leading edge wins the direct trunk');

    const discrete = makeCandidate('minima-high', 0, 0, 20, { source: 'minima', priority: 0.5 });
    const overhang = makeCandidate('overhang-low', 3, 0, 15, { source: 'overhang', priority: 0.5 });
    const mixedPlan = synthesizeTreeClusters([overhang, discrete], {
        maxAngleFromVerticalDeg: 45,
        maxReachMm: 8,
        maxAttachmentsPerTrunk: 12,
    });
    assert.equal(mixedPlan.trunkAnchors[0].id, 'minima-high', 'primary discrete island still beats overhang point');
});

test('Phase 3: findOffsetSilhouetteRoute escapes around a lower obstacle within tight radial offsets', () => {
    initializeBVH();
    // Lower slab directly underneath (0, 0, 22): 4×4×2 mm at Z = 8..10 mm.
    const slabGeo = new THREE.BoxGeometry(4, 4, 2).translate(0, 0, 9).toNonIndexed();
    slabGeo.computeVertexNormals();
    accelerateGeometry(slabGeo);
    const mesh = new THREE.Mesh(slabGeo, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const route = findOffsetSilhouetteRoute(
        { x: 0, y: 0, z: 22 },
        mesh,
        0.5,
        45,
        [],
    );
    assert.ok(route, 'silhouette escape route found around 4×4 lower obstacle');
    if (route) {
        const radial = Math.hypot(route.basePos.x, route.basePos.y);
        assert.ok(radial >= 2.4 && radial <= 6.0,
            `dogleg stays tightly tucked near silhouette (offset ${radial.toFixed(2)}mm)`);
        assert.ok(route.bendJoint.z > 10 && route.bendJoint.z < 22,
            `bend joint sits cleanly above the lower obstacle (Z=${route.bendJoint.z.toFixed(2)}mm)`);
    }
});

test('Phase 4: syncContactConeDiameters keeps leaf bodies slim on thickened trunks and active cross resolution avoids tangles', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            r1: { id: 'r1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            t1: {
                id: 't1',
                modelId: 'm',
                rootId: 'r1',
                segments: [{
                    id: 'seg-1',
                    diameter: 1.6,
                    bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.6 },
                    topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 20 }, diameter: 1.6 },
                }],
                contactCone: {
                    id: 'c-t1',
                    pos: { x: 0, y: 0, z: 22 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
        knots: {
            k1: { id: 'k1', parentShaftId: 'seg-1', t: 0.8, pos: { x: 0, y: 0, z: 16 }, diameter: 1.725 } as never,
        },
        leaves: {
            l1: {
                id: 'l1',
                modelId: 'm',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'c-l1',
                    pos: { x: 2, y: 0, z: 18.5 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.25, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
    };

    const synced = syncContactConeDiameters(draft);
    assert.equal(synced.leaves.l1.contactCone?.profile?.bodyDiameterMm, 1.12,
        'leaf cone body caps at 0.7× thickened host (1.12mm, not 1.6mm)');

    // Active cross re-hosting: two same-model trunks at x=0 and x=3, plus a
    // crossing leaf attached to x=0 reaching x=4.5 through x=3 — computeAutoSupportPlan
    // re-hosts it onto x=3 cleanly with zero remaining cross orphans.
    const prevSettings = getSettings();
    try {
        const s = createDefaultSettings();
        s.grid.enabled = false;
        setSettings(s);
        resetStore();
        resetKickstandsInState();

        const base: SupportState = {
            ...createEmptySupportCollections(),
            selectedId: null,
            hoveredId: null,
            roots: {
                rA: { id: 'rA', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
                rB: { id: 'rB', modelId: 'm', transform: { pos: { x: 3, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
            },
            trunks: {
                tA: {
                    id: 'tA', modelId: 'm', rootId: 'rA',
                    segments: [{ id: 'segA', diameter: 1.0, bottomJoint: { id: 'a0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'a1', pos: { x: 0, y: 0, z: 22 }, diameter: 1.0 } }],
                    contactCone: { id: 'cA', pos: { x: 0, y: 0, z: 22 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
                } as never,
                tB: {
                    id: 'tB', modelId: 'm', rootId: 'rB',
                    segments: [{ id: 'segB', diameter: 1.0, bottomJoint: { id: 'b0', pos: { x: 3, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'b1', pos: { x: 3, y: 0, z: 22 }, diameter: 1.0 } }],
                    contactCone: { id: 'cB', pos: { x: 3, y: 0, z: 22 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
                } as never,
            },
            knots: {
                kCross: { id: 'kCross', parentShaftId: 'segA', t: 0.6, pos: { x: 0, y: 0, z: 13.6 }, diameter: 1.125 } as never,
            },
            leaves: {
                lCross: {
                    id: 'lCross',
                    modelId: 'm',
                    parentKnotId: 'kCross',
                    contactCone: { id: 'cCross', pos: { x: 4.5, y: 0, z: 18 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
                } as never,
            },
        };

        // Run with one non-interfering island so the post-resize cross-resolution pass executes.
        const plan = computeAutoSupportPlan(
            [{ id: 'far', source: 'voxel', contact: new THREE.Vector3(20, 0, 15), baseZ: 15, areaMm2: 1 }],
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            base,
        );
        assert.ok(plan, 'plan computed');
        const remainingCross = (plan.result.analytics?.forestReport?.orphans ?? []).filter((o) => o.reason === 'cross');
        assert.equal(remainingCross.length, 0, 'crossing leaf automatically re-hosted onto clear trunk tB');
    } finally {
        setSettings(prevSettings);
    }
});

test('Path C: elevated occluded chin cluster synthesizes a compact 2-level Trunk -> Branch -> Leaf crown', () => {
    const prevSettings = getSettings();
    try {
        const s = createDefaultSettings();
        s.grid.enabled = false;
        setSettings(s);
        resetStore();
        resetKickstandsInState();
        initializeBVH();

        // Small chest obstacle directly under the chin (X = 3..9, Z = 10..12) so
        // the chin contacts are vertically occluded while the waist trunk at X = 0
        // has a clear vertical path to the build plate.
        const chestGeo = new THREE.BoxGeometry(6, 6, 2).translate(6, 0, 11).toNonIndexed();
        chestGeo.computeVertexNormals();
        accelerateGeometry(chestGeo);
        const chestMesh = new THREE.Mesh(chestGeo, new THREE.MeshBasicMaterial());
        chestMesh.updateMatrixWorld(true);

        const waistCluster: CandidatePoint[] = [
            makeCandidate('w0', 0, 0, 21, { source: 'voxel', priority: 1.0 }),
            makeCandidate('w1', 0, -1.2, 22, { source: 'overhang', priority: 0.6 }),
            makeCandidate('w2', -1.2, 0, 22, { source: 'overhang', priority: 0.6 }),
            makeCandidate('w3', 0, 1.2, 22, { source: 'overhang', priority: 0.6 }),
        ];
        // Compact chin cluster 3.2 mm laterally out, Z = 27.2..28.8 (span 9.27 mm @ 20.2°
        // from waist topJoint Z = 18.5 — beyond 8 mm 1-level span, inside Ø1.0 mm Euler-Bernoulli).
        const chinCluster: CandidatePoint[] = [
            makeCandidate('chin-0', 3.2, 0, 27.2, { source: 'voxel', priority: 0.7 }),
            makeCandidate('chin-1', 4.3, 0.8, 28.8, { source: 'voxel', priority: 0.6 }),
            makeCandidate('chin-2', 4.3, -0.8, 28.8, { source: 'voxel', priority: 0.6 }),
        ];

        const treePlan = synthesizeTreeClusters([...waistCluster, ...chinCluster], {
            maxAngleFromVerticalDeg: 45,
            maxReachMm: 8,
            maxAttachmentsPerTrunk: 12,
            mesh: chestMesh,
        });
        assert.equal(treePlan.trunkAnchors.length, 1, 'waist trunk chosen without spawning a solo front chin flagpole');
        assert.equal(treePlan.upperClusters.length, 1, 'occluded chin contacts grouped into one 2-level upper cluster');
        assert.equal(treePlan.upperClusters[0].siblings.length, 2, 'two sibling contacts grouped onto the chin arm');

        // Run the full pipeline end-to-end and verify 1 trunk + angled branch + 2nd-level leaves.
        // Waist cluster puts `w1..w5` at X = -2.4..-2.5 so `w0` covers 5 neighbors while `chin-0`
        // at X = 3.2 cannot reach them (>= 5.69 mm laterally), deferring cleanly into Pass 2c.
        const islands: DetectedIsland[] = [
            { id: 'w0', source: 'voxel', contact: new THREE.Vector3(0, 0, 21), baseZ: 21, areaMm2: 5 },
            { id: 'w1', source: 'voxel', contact: new THREE.Vector3(-2.4, -1.0, 22), baseZ: 22, areaMm2: 1 },
            { id: 'w2', source: 'voxel', contact: new THREE.Vector3(-2.5, 0, 22), baseZ: 22, areaMm2: 1 },
            { id: 'w3', source: 'voxel', contact: new THREE.Vector3(-2.4, 1.0, 22), baseZ: 22, areaMm2: 1 },
            { id: 'w4', source: 'voxel', contact: new THREE.Vector3(-2.4, 2.0, 22), baseZ: 22, areaMm2: 1 },
            { id: 'w5', source: 'voxel', contact: new THREE.Vector3(-2.4, -2.0, 22), baseZ: 22, areaMm2: 1 },
            { id: 'chin-0', source: 'voxel', contact: new THREE.Vector3(3.2, 0, 27.2), baseZ: 27.2, areaMm2: 1 },
            { id: 'chin-1', source: 'voxel', contact: new THREE.Vector3(4.3, 0.8, 28.8), baseZ: 28.8, areaMm2: 1 },
            { id: 'chin-2', source: 'voxel', contact: new THREE.Vector3(4.3, -0.8, 28.8), baseZ: 28.8, areaMm2: 1 },
        ];
        const plan = computeAutoSupportPlan(islands, 'm', {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        });
        assert.ok(plan, '2-level plan computed');
        assert.equal(plan.result.placed.trunk, 1, 'only 1 plate trunk placed — zero solo chin flagpoles');
        assert.ok(plan.result.placed.branch >= 1, 'angled branch climbs to the chin cluster');

        const branchSegIds = new Set(
            Object.values(plan.support.branches).flatMap((b) => b.segments.map((sg) => sg.id)),
        );
        const secondLevelLeaves = Object.values(plan.support.leaves).filter((l) => {
            const k = plan.support.knots[l.parentKnotId];
            return k && branchSegIds.has(k.parentShaftId);
        });
        assert.ok(secondLevelLeaves.length >= 1, 'sibling chin contacts attach as 2nd-level leaves off the branch');
        assert.equal((plan.result.analytics?.forestReport?.orphans ?? []).length, 0, '2-level leaves pass orphan validation cleanly');
    } finally {
        setSettings(prevSettings);
    }
});

test('Path C: Euler-Bernoulli cantilever & Euler buckling envelope blocks long 45° traversals and 18mm+ unbraced branches', () => {
    // 1. Short spans keep full 45°; longer spans steepen via arcsin(K·d⁴/L³),
    //    and buckling length scales as d².
    assert.equal(maxStableAngleForSpanDeg(4.5, 45, 1.0), 45, 'short 4.5 mm leaf keeps full 45°');
    assert.equal(maxStableAngleForSpanDeg(6.0, 45, 1.0), 45, '6.0 mm keeps 45°');
    assert.ok(maxStableAngleForSpanDeg(10.0, 45, 1.0) <= 30, 'Ø1.0 mm 10 mm cantilever steepens via 1/L³');
    assert.ok(
        maxStableAngleForSpanDeg(10.0, 45, 1.3) > maxStableAngleForSpanDeg(10.0, 45, 1.0),
        'thicker Ø1.3 mm shaft gains d⁴ bending stiffness',
    );
    assert.ok(
        maxEulerBucklingSpanMm(0.8) < maxEulerBucklingSpanMm(1.0) && maxEulerBucklingSpanMm(1.0) < maxEulerBucklingSpanMm(1.2),
        'Euler buckling ceiling scales monotonically with shaft diameter d²',
    );
    assert.equal(minStableRiseForLateralMm(8.0, 45, MAX_UNBRACED_BRANCH_SPAN_MM), null, '8 mm lateral cantilever is rejected outright');
    assert.ok((minStableRiseForLateralMm(4.0, 45, MAX_UNBRACED_BRANCH_SPAN_MM) ?? 0) >= 4.0, '4 mm lateral run has valid rise');

    // 2. With the default/production finite rescue span (MAX_UNBRACED_BRANCH_SPAN_MM),
    //    fanLeafToHost refuses BOTH a 9 mm @ 45° sideways boom AND a 19 mm near-vertical
    //    unbraced branch rising off a tiny low foot stub (while Number.POSITIVE_INFINITY
    //    remains an explicit caller override).
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rLow: { id: 'rLow', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
            rTall: { id: 'rTall', modelId: 'm', transform: { pos: { x: 20, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tLow: {
                id: 'tLow', modelId: 'm', rootId: 'rLow',
                segments: [{ id: 'segLow', diameter: 1.0, bottomJoint: { id: 'lj0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'lj1', pos: { x: 0, y: 0, z: 3.5 }, diameter: 1.0 } }],
                contactCone: { id: 'lc1', pos: { x: 0, y: 0, z: 3.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
            tTall: {
                id: 'tTall', modelId: 'm', rootId: 'rTall',
                segments: [{ id: 'segTall', diameter: 1.0, bottomJoint: { id: 'tj0', pos: { x: 20, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'tj1', pos: { x: 20, y: 0, z: 22 }, diameter: 1.0 } }],
                contactCone: { id: 'tc1', pos: { x: 20, y: 0, z: 22 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };
    const pool = collectFanShaftPoints(draft);

    // Unbraced 19 mm climb off the tiny z=3.5 mm foot stub -> must be rejected.
    const noodle = fanLeafToHost(
        { x: 3.0, y: 0, z: 22.0 },
        'm',
        pool,
        new Set(),
        'test-noodle',
        12,
        12,
        45,
        12,
        draft,
        undefined,
        'island',
        'steepest',
        MAX_UNBRACED_BRANCH_SPAN_MM,
    );
    assert.equal(noodle.ok, false, '19 mm unbraced branch off low stub is refused');

    // Long 9 mm sideways 45° boom off the tall trunk -> must be rejected.
    const long45 = fanLeafToHost(
        { x: 29.0, y: 0, z: 25.0 },
        'm',
        pool,
        new Set(),
        'test-long45',
        12,
        12,
        45,
        12,
        draft,
        undefined,
        'island',
        'nearest',
        MAX_UNBRACED_BRANCH_SPAN_MM,
    );
    assert.equal(long45.ok, false, '9 mm lateral 45° traversal is refused by cantilever stability envelope');
});

test('Path C: collectBranchFanShaftPoints samples branch upper shaft and validateAndCullOrphans cascades culled branches to child leaves', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            r1: { id: 'r1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            t1: {
                id: 't1', modelId: 'm', rootId: 'r1',
                segments: [{ id: 'tseg-1', diameter: 1.2, bottomJoint: { id: 'tj0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.2 }, topJoint: { id: 'tj1', pos: { x: 0, y: 0, z: 22 }, diameter: 1.2 } }],
                contactCone: { id: 'tc1', pos: { x: 0, y: 0, z: 22 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.2, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
        knots: {
            kBranch: { id: 'kBranch', parentShaftId: 'tseg-1', t: 0.7, pos: { x: 0, y: 0, z: 15.7 }, diameter: 1.325 } as never,
            kChildLeaf: { id: 'kChildLeaf', parentShaftId: 'bseg-1', t: 0.7, pos: { x: 5.6, y: 0, z: 22.91 }, diameter: 1.125 } as never,
        },
        branches: {
            b1: {
                id: 'b1', modelId: 'm', parentKnotId: 'kBranch',
                segments: [{ id: 'bseg-1', diameter: 1.0, topJoint: { id: 'bj1', pos: { x: 8, y: 0, z: 26 }, diameter: 1.0 } }],
                contactCone: { id: 'bc1', pos: { x: 8, y: 0, z: 28 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
        leaves: {
            lChild: {
                id: 'lChild', modelId: 'm', parentKnotId: 'kChildLeaf',
                contactCone: { id: 'lc1', pos: { x: 7, y: 0.8, z: 25.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.25, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };

    const branchPoints = collectBranchFanShaftPoints(draft, 'm');
    assert.ok(branchPoints.length === 8, `upper branch shaft sampled (got ${branchPoints.length})`);
    assert.ok(branchPoints.every((sp) => sp.hostTypeId === 'branch' && sp.hostId === 'b1' && (sp.t ?? 0) >= 0.45));

    // Valid 2-level leaf passes orphan validation with zero drift.
    const validCheck = validateAndCullOrphans(draft, undefined, 'm');
    assert.equal(validCheck.orphans.length, 0, 'valid 2-level branch-hosted leaf passes validation');

    // If the branch's own knot drifts off the trunk, both the branch AND its
    // 2nd-level child leaf must cascade-cull cleanly.
    const drifted: SupportState = {
        ...draft,
        knots: {
            ...draft.knots,
            kBranch: { ...draft.knots.kBranch, pos: { x: 5, y: 0, z: 15.7 } },
        },
    };
    const cascade = validateAndCullOrphans(drifted, undefined, 'm');
    assert.equal(cascade.draft.branches.b1, undefined, 'drifted branch culled');
    assert.equal(cascade.draft.leaves.lChild, undefined, '2nd-level child leaf cascade-culled with its parent branch');
});
