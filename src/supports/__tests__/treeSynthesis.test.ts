import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { computeAutoSupportPlan, syncContactConeDiameters } from '../autoSupport/autoPlace';
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
