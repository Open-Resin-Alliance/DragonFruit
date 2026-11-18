import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { computeAutoSupportIslandSummary } from '@/components/controls/AutoSupportPanel';
import { serializeIsland, runAutoPlaceRequest, resetAutoPlaceWorkerCache } from '../autoSupport/autoPlace.worker.shared';
import { computeAutoSupportPlan, isExemptFromSteepWallCull, runAutoPlace, collectContactPositions } from '../autoSupport/autoPlace';
import { computeMinimaReinforcementPoints } from '../autoSupport/minimaReinforcement';
import {
    generateCandidates,
    candidatesFromIsland,
    deduplicateCandidates,
} from '../autoSupport/candidateGeneration';
import {
    computePerimeterInsetMm,
    insetPolygonLoops2D,
    generateGridCandidates,
} from '../autoSupport/gridPlacement';
import {
    buildGapFillCandidates,
    computeRegionCoverage,
    findUncoveredClusters,
} from '../autoSupport/coverage';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { smallIslandTipDiameterMm } from '../autoSupport/parameterSizing';
import { setModelMesh } from '../autoSupport/meshStore';
import { getSnapshot, resetKickstandsInState, resetStore, setSnapshot } from '../state';
import { clearHistory } from '../../history/historyStore';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import type { CandidatePoint } from '../autoSupport/types';

function makeDownConeMesh(halfAngleFromVerticalDeg: number, apexZ: number, height = 6): THREE.Mesh {
    initializeBVH();
    const radius = height * Math.tan((halfAngleFromVerticalDeg * Math.PI) / 180);
    const geometry = new THREE.ConeGeometry(radius, height, 64);
    geometry.rotateZ(Math.PI);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, apexZ + height / 2);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    return mesh;
}

// ---------------------------------------------------------------------------
// 1. AutoSupportPanel summary + worker serialization
// ---------------------------------------------------------------------------

test('E2-1: computeAutoSupportIslandSummary counts deduplicated discrete unsupported islands without double-counting intersections or subApexes', () => {
    assert.deepEqual(computeAutoSupportIslandSummary(undefined), { voxel: 0, minima: 0, total: 0 });
    assert.deepEqual(computeAutoSupportIslandSummary([]), { voxel: 0, minima: 0, total: 0 });

    const islands: DetectedIsland[] = [
        {
            id: 'v0',
            source: 'voxel',
            class: 'voxelOnly',
            contact: new THREE.Vector3(0, 0, 5),
            baseZ: 5,
            areaMm2: 1.0,
        },
        {
            id: 'v1',
            source: 'voxel',
            class: 'intersection',
            matchedWith: 'm0',
            contact: new THREE.Vector3(5, 0, 6),
            baseZ: 6,
            areaMm2: 2.0,
            subApexes: [
                { x: 6, y: 0, z: 6.1 },
                { x: 7, y: 0, z: 6.2 },
            ],
        },
        {
            id: 'm0',
            source: 'minima',
            class: 'intersection',
            matchedWith: 'v1',
            contact: new THREE.Vector3(5, 0, 6),
            baseZ: 6,
        },
        {
            id: 'm1',
            source: 'minima',
            class: 'minimaOnly',
            contact: new THREE.Vector3(10, 0, 7),
            baseZ: 7,
        },
        {
            id: 'o0',
            source: 'overhang',
            contact: new THREE.Vector3(0, 0, 5),
            baseZ: 5,
            areaMm2: 20,
        },
    ];

    assert.deepEqual(
        computeAutoSupportIslandSummary(islands),
        { voxel: 2, minima: 1, total: 3 },
        '2 voxel (1 voxelOnly + 1 intersection) + 1 minimaOnly = 3 total (no double-count of m0 or subApexes or overhang)',
    );
});

test('E2-1b: serializeIsland and runAutoPlaceRequest preserve structural metadata and deep-clone subApexes', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    resetAutoPlaceWorkerCache();

    const subApexes = [{ x: 2, y: 3, z: 12.1 }, { x: 4, y: 3, z: 12.2 }];
    const island: DetectedIsland = {
        id: 'v-int',
        source: 'voxel',
        class: 'intersection',
        matchedWith: 'm-int',
        contact: new THREE.Vector3(0, 0, 12),
        baseZ: 12,
        rawBaseZ: 11.95,
        areaMm2: 0.01,
        peakAreaMm2: 0.25,
        isDetached: true,
        coveredByOverhangId: 'o0',
        subApexes,
    };

    const wire = serializeIsland(island);
    assert.equal(wire.isDetached, true);
    assert.equal(wire.peakAreaMm2, 0.25);
    assert.equal(wire.rawBaseZ, 11.95);
    assert.equal(wire.coveredByOverhangId, 'o0');
    assert.deepEqual(wire.subApexes, [
        { x: 2, y: 3, z: 12.1 },
        { x: 4, y: 3, z: 12.2 },
    ]);
    assert.notEqual(wire.subApexes, subApexes);
    assert.notEqual(wire.subApexes![0], subApexes[0]);

    // Mutate source after serializeIsland — wire copy must stay isolated.
    subApexes[0].x = 999;
    assert.equal(wire.subApexes![0].x, 2);

    const plan = runAutoPlaceRequest({
        modelId: 'm-ser',
        islands: [wire],
        appSettings: createDefaultSettings(),
        baseState: getSnapshot(),
        settingsOverride: { debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
    });
    assert.ok(plan);
    assert.equal(plan.result.changed, true);
    // Primary + 2 subApexes (>0.8 mm apart) all survive without area culling.
    assert.equal(plan.analytics?.forestReport?.scan?.candidates, 3);
});

// ---------------------------------------------------------------------------
// 2. isExemptFromSteepWallCull + steep 60° hanging cone
// ---------------------------------------------------------------------------

test('E2-2: isExemptFromSteepWallCull protects overhang, minima, intersection, isDetached, and interior', () => {
    assert.equal(isExemptFromSteepWallCull({ source: 'overhang' }), true);
    assert.equal(isExemptFromSteepWallCull({ source: 'minima' }), true);
    assert.equal(isExemptFromSteepWallCull({ source: 'voxel', class: 'intersection' }), true);
    assert.equal(isExemptFromSteepWallCull({ source: 'voxel', class: 'voxelOnly', isDetached: true }), true);
    assert.equal(isExemptFromSteepWallCull({ source: 'voxel', class: 'voxelOnly', interior: true }), true);
    assert.equal(isExemptFromSteepWallCull({ source: 'voxel', class: 'voxelOnly', isDetached: false, interior: false }), false);
});

test('E2-2b: computeAutoSupportPlan keeps tip support on steep 60° hanging cone for intersection and isDetached apexes', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();

    // 30° half-angle from vertical => flanks sit at 60° from horizontal (> 45.5° self-support).
    const mesh = makeDownConeMesh(30, 15, 10);

    const intersectionApex: DetectedIsland = {
        id: 'v-cone-int',
        source: 'voxel',
        class: 'intersection',
        matchedWith: 'm-cone',
        contact: new THREE.Vector3(0, 0, 15),
        baseZ: 15,
        areaMm2: 0.05,
        isDetached: false,
    };
    const planInt = computeAutoSupportPlan(
        [intersectionApex],
        'cone-int',
        { debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
        getSnapshot(),
        mesh,
    );
    assert.ok(planInt);
    assert.ok(
        collectContactPositions(planInt.support, 'cone-int').some((p) => Math.hypot(p.x, p.y) < 0.6 && Math.abs(p.z - 15) < 1.0),
        'intersection apex on 60° cone must keep its tip support',
    );

    const detachedApex: DetectedIsland = {
        id: 'v-cone-det',
        source: 'voxel',
        class: 'voxelOnly',
        contact: new THREE.Vector3(0, 0, 15),
        baseZ: 15,
        areaMm2: 0.05,
        isDetached: true,
    };
    const planDet = computeAutoSupportPlan(
        [detachedApex],
        'cone-det',
        { debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
        getSnapshot(),
        mesh,
    );
    assert.ok(planDet);
    assert.ok(
        collectContactPositions(planDet.support, 'cone-det').some((p) => Math.hypot(p.x, p.y) < 0.6 && Math.abs(p.z - 15) < 1.0),
        'isDetached apex on 60° cone must keep its tip support',
    );
});

// ---------------------------------------------------------------------------
// 3. minimaReinforcement skips coveredByOverhangId != null
// ---------------------------------------------------------------------------

test('E2-3: computeMinimaReinforcementPoints skips minimaOnly with coveredByOverhangId while reinforcing uncovered minimaOnly', () => {
    // 60° half-angle from vertical => 30° from horizontal flank, reinforces cleanly.
    const mesh = makeDownConeMesh(60, 20, 4);
    const settings = createDefaultAutoSupportSettings();

    const covered: DetectedIsland = {
        id: 'm-cov',
        source: 'minima',
        class: 'minimaOnly',
        contact: new THREE.Vector3(0, 0, 20),
        baseZ: 20,
        coveredByOverhangId: 'o0',
    };
    const uncovered: DetectedIsland = {
        id: 'm-uncov',
        source: 'minima',
        class: 'minimaOnly',
        contact: new THREE.Vector3(0, 0, 20),
        baseZ: 20,
    };

    assert.deepEqual(computeMinimaReinforcementPoints([covered], mesh, settings), []);
    const pts = computeMinimaReinforcementPoints([covered, uncovered], mesh, settings);
    assert.ok(pts.length > 0 && pts.every((p) => p.islandId === 'm-uncov'));
});

// ---------------------------------------------------------------------------
// 4. candidateGeneration & deduplicateCandidates
// ---------------------------------------------------------------------------

test('E2-4a: generateCandidates exempts sub-floor intersection/isDetached and suppresses matched minima intersection', () => {
    const settings = { ...createDefaultAutoSupportSettings(), minIslandAreaMm2: 0.2 };

    const vInt: DetectedIsland = {
        id: 'v0',
        source: 'voxel',
        class: 'intersection',
        matchedWith: 'm0',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2: 0.01,
    };
    const mInt: DetectedIsland = {
        id: 'm0',
        source: 'minima',
        class: 'intersection',
        matchedWith: 'v0',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
    };
    const vDet: DetectedIsland = {
        id: 'v-det',
        source: 'voxel',
        class: 'voxelOnly',
        isDetached: true,
        contact: new THREE.Vector3(10, 0, 10),
        baseZ: 10,
        areaMm2: 0.01,
    };
    const vTiny: DetectedIsland = {
        id: 'v-tiny',
        source: 'voxel',
        class: 'voxelOnly',
        isDetached: false,
        contact: new THREE.Vector3(20, 0, 10),
        baseZ: 10,
        areaMm2: 0.01,
    };

    const cands = generateCandidates([vInt, mInt, vDet, vTiny], settings);
    const ids = cands.map((c) => c.id);
    assert.ok(ids.includes('v0'), 'intersection voxel island below minIslandAreaMm2 is kept');
    assert.ok(!ids.includes('m0'), 'paired minima intersection is suppressed when voxel partner is present');
    assert.ok(ids.includes('v-det'), 'isDetached voxel island below minIslandAreaMm2 is kept');
    assert.ok(!ids.includes('v-tiny'), 'non-detached non-intersection voxel island below floor is dropped');

    // When matchedWith points to a voxel not in eligible, minima intersection stays as safety net.
    const orphanMinima = generateCandidates([mInt], settings);
    assert.deepEqual(orphanMinima.map((c) => c.id), ['m0']);
});

test('E2-4b: candidatesFromIsland preserves snapped mj.contact on intersection specks/slivers and emits >=0.8mm spaced subApexes', () => {
    const speckInt: DetectedIsland = {
        id: 'v-speck',
        source: 'voxel',
        class: 'intersection',
        contact: new THREE.Vector3(0.05, 0.22, 12),
        baseZ: 12,
        areaMm2: 0.05,
        contactVoxels: footprintFromPoints([
            { x: 0, y: 0, z: 12 },
            { x: 0.25, y: 0, z: 12 },
            { x: 0, y: 0.25, z: 12 },
            { x: 0.25, y: 0.25, z: 12 },
        ]),
    };
    const speckOut = candidatesFromIsland(speckInt);
    assert.equal(speckOut.length, 1);
    assert.deepEqual(speckOut[0].tipPos, { x: 0.05, y: 0.22, z: 12 }, 'snapped mj.contact preserved on intersection speck');

    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let x = 0; x <= 4; x += 0.25) pts.push({ x, y: 0, z: 15 });
    const sliverInt: DetectedIsland = {
        id: 'v-sliver',
        source: 'voxel',
        class: 'intersection',
        contact: new THREE.Vector3(0.4, 0.1, 15), // near lo (t <= 0.5) => partner at 0.75 * 4 = 3.0
        baseZ: 15,
        areaMm2: 2.0,
        contactVoxels: footprintFromPoints(pts),
        subApexes: [
            { x: 0.6, y: 0.1, z: 15 },   // 0.2mm from contact -> dropped (<0.8mm)
            { x: 2.0, y: 0, z: 15.2 },   // >=0.8mm from both a (0.4,0.1,15) and b (3,0,15) -> kept
            { x: 2.3, y: 0, z: 15.2 },   // 0.3mm from previous subApex -> dropped
            { x: 3.9, y: 0, z: 15.3 },   // >=0.8mm from b (3,0,15) and sub0 (2,0,15.2) -> kept
        ],
    };
    const sliverOut = candidatesFromIsland(sliverInt);
    assert.equal(sliverOut.length, 4);
    assert.equal(sliverOut[0].id, 'v-sliver-a');
    assert.deepEqual(sliverOut[0].tipPos, { x: 0.4, y: 0.1, z: 15 });
    assert.equal(sliverOut[1].id, 'v-sliver-b');
    assert.deepEqual(sliverOut[1].tipPos, { x: 3.0, y: 0, z: 15 });
    assert.equal(sliverOut[2].id, 'v-sliver-sub0');
    assert.deepEqual(sliverOut[2].tipPos, { x: 2.0, y: 0, z: 15.2 });
    assert.equal(sliverOut[2].tipDiameterMm, smallIslandTipDiameterMm());
    assert.equal(sliverOut[3].id, 'v-sliver-sub1');
    assert.deepEqual(sliverOut[3].tipPos, { x: 3.9, y: 0, z: 15.3 });
});

test('E2-4c: deduplicateCandidates suppresses overhang gridPoint within >=0.6mm of discrete anchor without merging discrete pairs', () => {
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.3 };
    const discreteA: CandidatePoint = {
        id: 'v-a',
        tipPos: { x: 0, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'voxel',
        islandAreaMm2: 0.5,
        zHeight: 10,
        priority: 0.4,
    };
    const discreteB: CandidatePoint = {
        id: 'v-b',
        tipPos: { x: 0.5, y: 0, z: 10 }, // 0.5mm > 0.3mm baseRadius => discrete pair must stay separate
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'minima',
        islandAreaMm2: 0.05,
        zHeight: 10,
        priority: 0.3,
    };
    const gridNearA: CandidatePoint = {
        id: 'grid-near',
        tipPos: { x: 0, y: 0.55, z: 10 }, // 0.55mm <= 0.6mm pairRadius => suppressed even if higher priority
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'overhang',
        islandAreaMm2: 8,
        zHeight: 10,
        priority: 0.9,
        gridPoint: true,
    };
    const gridFar: CandidatePoint = {
        id: 'grid-far',
        tipPos: { x: 0, y: 1.5, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'overhang',
        islandAreaMm2: 8,
        zHeight: 10,
        priority: 0.1,
        gridPoint: true,
    };

    const deduped = deduplicateCandidates([gridNearA, discreteA, discreteB, gridFar], settings);
    const ids = deduped.map((c) => c.id);
    assert.ok(ids.includes('v-a'));
    assert.ok(ids.includes('v-b'), 'discrete pair 0.5mm apart stays unmerged when baseRadius=0.3');
    assert.ok(!ids.includes('grid-near'), 'overhang gridPoint within 0.6mm of discrete anchor is suppressed');
    assert.ok(ids.includes('grid-far'));
});

// ---------------------------------------------------------------------------
// 5. gridPlacement: inset helpers, narrow rim fallback, apex-seeded backoff
// ---------------------------------------------------------------------------

test('E2-5a: computePerimeterInsetMm clamps to [0.10, 0.25]', () => {
    assert.equal(computePerimeterInsetMm(0.10), 0.10);
    assert.ok(Math.abs(computePerimeterInsetMm(0.28) - 0.17) < 1e-9);
    assert.equal(computePerimeterInsetMm(0.60), 0.25);
    assert.ok(Math.abs(computePerimeterInsetMm(Number.NaN) - 0.17) < 1e-9);
});

test('E2-5b: insetPolygonLoops2D shifts CCW/CW outer inward, holes outward, and falls back on collapse', () => {
    const outerCCW: Array<[number, number, number]> = [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]];
    const shiftedCCW = insetPolygonLoops2D([outerCCW], 0.1)!;
    assert.ok(shiftedCCW[0].every(([x, y]) => x > 0.05 && x < 9.95 && y > 0.05 && y < 9.95));

    const outerCW: Array<[number, number, number]> = [[0, 0, 5], [0, 10, 5], [10, 10, 5], [10, 0, 5]];
    const shiftedCW = insetPolygonLoops2D([outerCW], 0.1)!;
    assert.ok(shiftedCW[0].every(([x, y]) => x > 0.05 && x < 9.95 && y > 0.05 && y < 9.95));

    // Inner hole inside outerCCW: must expand outward into the surrounding solid!
    const holeCW: Array<[number, number, number]> = [[3, 3, 5], [3, 7, 5], [7, 7, 5], [7, 3, 5]];
    const shiftedRing = insetPolygonLoops2D([outerCCW, holeCW], 0.1)!;
    assert.ok(shiftedRing[1][0][0] < 3.0 && shiftedRing[1][0][1] < 3.0, 'hole bottom-left expands outward into solid');
    assert.ok(shiftedRing[1][2][0] > 7.0 && shiftedRing[1][2][1] > 7.0, 'hole top-right expands outward into solid');

    // Tiny loop that would invert/collapse under large extraInsetMm falls back cleanly (both mild and extreme).
    const tiny: Array<[number, number, number]> = [[0, 0, 5], [0.2, 0, 5], [0.2, 0.2, 5], [0, 0.2, 5]];
    assert.deepEqual(insetPolygonLoops2D([tiny], 0.15)![0], tiny);
    const collapsed = insetPolygonLoops2D([tiny], 0.5)!;
    assert.deepEqual(collapsed[0], tiny);
});

test('E2-5c: generateGridCandidates emits center fallback on narrow <0.4mm rim and backs off from pinned anchors', () => {
    const settings = createDefaultAutoSupportSettings();

    // Narrow 0.3 x 8.0 mm rim whose quantized mask boundary points miss the mesh strip
    // (off-triangle boundary samples) while island.contact sits at center (0.15, 4.0, 10):
    // Narrow-Rim Fallback must emit a contact at the rim center.
    initializeBVH();
    const tinyGeo = new THREE.BoxGeometry(0.3, 8, 2).translate(0.15, 4, 11);
    accelerateGeometry(tinyGeo);
    const tinyMesh = new THREE.Mesh(tinyGeo);
    tinyMesh.updateMatrixWorld(true);
    const offStripVoxels: Array<{ x: number; y: number; z: number }> = [];
    for (let y = 0; y <= 8; y += 0.25) {
        offStripVoxels.push({ x: -0.1, y, z: 10 });
        offStripVoxels.push({ x: 0.4, y, z: 10 });
    }
    const rimMeshCase: DetectedIsland = {
        id: 'o-rim-mesh',
        source: 'overhang',
        contact: new THREE.Vector3(0.15, 4.0, 10),
        baseZ: 10,
        areaMm2: 2.4,
        triangleIds: [10, 11], // bottom -Z faces of BoxGeometry
        perimeterLoops: [[[99, 99, 10], [99.2, 99, 10], [99.2, 99.2, 10], [99, 99.2, 10]]],
        contactVoxels: footprintFromPoints(offStripVoxels),
    };
    const fallbackOut = generateGridCandidates([rimMeshCase], settings, tinyMesh, 'm-rim');
    assert.equal(fallbackOut.length, 1, 'collapsed narrow rim receives center fallback candidate');
    assert.ok(Math.abs(fallbackOut[0].tipPos.x - 0.15) < 1e-4 && Math.abs(fallbackOut[0].tipPos.y - 4.0) < 1e-4);

    // Apex-seeded backoff: wide 20x20 region with a pinned anchor at (0, 0, 10).
    const wideVoxels: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            wideVoxels.push({ x, y, z: 10 });
        }
    }
    const wideRegion: DetectedIsland = {
        id: 'o-wide',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(wideVoxels),
    };
    const pinned: DetectedIsland = {
        id: 'v-pin',
        source: 'voxel',
        class: 'intersection',
        coveredByOverhangId: 'o-wide',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        subApexes: [{ x: 5, y: 5, z: 10 }],
    };
    const backedOff = generateGridCandidates(
        [wideRegion],
        settings,
        undefined,
        undefined,
        false,
        0,
        0,
        undefined,
        [pinned],
    );
    const minAnchorDist = Math.min(
        ...backedOff.map((c) => Math.min(
            Math.hypot(c.tipPos.x - 0, c.tipPos.y - 0),
            Math.hypot(c.tipPos.x - 5, c.tipPos.y - 5),
        )),
    );
    assert.ok(minAnchorDist > settings.tipInfluenceRadiusMm - 1e-6, `grid backs off from pinned anchors (minDist=${minAnchorDist.toFixed(2)})`);
});

// ---------------------------------------------------------------------------
// 6. coverage.ts Z-continuity BFS separation
// ---------------------------------------------------------------------------

test('E2-6: findUncoveredClusters separates vertically stepped flat shelves while keeping continuous 30° slope connected', () => {
    const shelfPts: Array<{ x: number; y: number; z: number }> = [];
    // Adjacent in XY across x = 0 / x = 0.25 AND overlapping at x = 0, separated by dz = 0.5mm (> 2 * 0.05 = 0.10mm)
    for (let x = -2.0; x <= 0.0; x += 0.25) {
        for (let y = -2.0; y <= 2.0; y += 0.25) {
            shelfPts.push({ x, y, z: 10.0 });
        }
    }
    for (let x = 0.25; x <= 2.25; x += 0.25) {
        for (let y = -2.0; y <= 2.0; y += 0.25) {
            shelfPts.push({ x, y, z: 10.5 });
        }
    }
    const steppedRegion: DetectedIsland = {
        id: 'o-step',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2: 18,
        overhangAngleDeg: 0,
        contactVoxels: footprintFromPoints(shelfPts),
    };
    const steppedClusters = findUncoveredClusters(steppedRegion, [], 3.0, 2.0, true, 0.05);
    assert.equal(steppedClusters.length, 2, 'vertically stepped flat shelves separate into 2 clusters');

    // Continuous 30° slope across x ∈ [-2, 2], y ∈ [-2, 2]: z = 10 + (x + 2) * tan(30°).
    const slopePts: Array<{ x: number; y: number; z: number }> = [];
    const tan30 = Math.tan((30 * Math.PI) / 180);
    for (let x = -2.0; x <= 2.0; x += 0.25) {
        for (let y = -2.0; y <= 2.0; y += 0.25) {
            slopePts.push({ x, y, z: 10 + (x + 2) * tan30 });
        }
    }
    const slopedRegion: DetectedIsland = {
        id: 'o-slope30',
        source: 'overhang',
        contact: new THREE.Vector3(-2, 0, 10),
        baseZ: 10,
        areaMm2: 16,
        overhangAngleDeg: 30,
        contactVoxels: footprintFromPoints(slopePts),
    };
    const slopedClusters = findUncoveredClusters(slopedRegion, [], 3.0, 2.0, true, 0.05);
    assert.equal(slopedClusters.length, 1, 'continuous 30° slope stays one connected cluster');
});

// ---------------------------------------------------------------------------
// 7. Standalone-trunk promotion for isolated >= 1.5 mm² isDetached flat plate
// ---------------------------------------------------------------------------

test('E2-7: runAutoPlace promotes standalone supports across >=4x4mm isDetached flat plate with no nearby trunk hosts', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();
    const prevSettings = getSettings();
    const s = createDefaultSettings();
    s.grid.enabled = false;
    setSettings(s);

    try {
        // 6x6 mm flat detached plate at z = 3.0 mm (below ANCHOR_HEIGHT_THRESHOLD_MM = 5.0,
        // so the centroid anchor places a stump rather than a trunk host — stubHosts is empty).
        const pts: Array<{ x: number; y: number; z: number }> = [];
        for (let x = 0; x <= 6; x += 0.25) {
            for (let y = 0; y <= 6; y += 0.25) {
                pts.push({ x, y, z: 3.0 });
            }
        }
        const detachedPlate: DetectedIsland = {
            id: 'v-plate',
            source: 'voxel',
            class: 'voxelOnly',
            isDetached: true,
            contact: new THREE.Vector3(3, 3, 3.0),
            baseZ: 3.0,
            areaMm2: 36,
            contactVoxels: footprintFromPoints(pts),
        };

        const result = runAutoPlace([detachedPlate], 'plate-model', {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        });
        assert.equal(result.changed, true);
        const tips = collectContactPositions(getSnapshot(), 'plate-model');
        assert.ok(tips.length >= 4, `isolated detached plate receives multi-point standalone supports (got ${tips.length})`);
    } finally {
        setSettings(prevSettings);
        setModelMesh('plate-model', null);
        disposeHandlers();
    }
});

// ---------------------------------------------------------------------------
// 8. Stacked overhang shelves (Z=10 below Z=14) stay independently supported
// ---------------------------------------------------------------------------

function makeStackedPlatesMesh(): THREE.Mesh {
    initializeBVH();
    // Two non-overlapping horizontal boxes merged manually into one geometry:
    // Plate 1: [-6,6] x [-6,6] x [10,12]
    // Plate 2: [-6,6] x [-6,6] x [14,16]
    const b1 = new THREE.BoxGeometry(12, 12, 2).toNonIndexed();
    b1.translate(0, 0, 11);
    const b2 = new THREE.BoxGeometry(12, 12, 2).toNonIndexed();
    b2.translate(0, 0, 15);
    const p1 = b1.attributes.position.array as Float32Array;
    const p2 = b2.attributes.position.array as Float32Array;
    const mergedPos = new Float32Array(p1.length + p2.length);
    mergedPos.set(p1, 0);
    mergedPos.set(p2, p1.length);
    const n1 = b1.attributes.normal.array as Float32Array;
    const n2 = b2.attributes.normal.array as Float32Array;
    const mergedNorm = new Float32Array(n1.length + n2.length);
    mergedNorm.set(n1, 0);
    mergedNorm.set(n2, n1.length);
    b1.dispose();
    b2.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    accelerateGeometry(geom);
    const mesh = new THREE.Mesh(geom);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('E2-8: stacked overhang shelves (Z=10..12 below Z=14..16) are never suppressed by lower shelf supports', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const mesh = makeStackedPlatesMesh();

    const makePlatePts = (z: number) => {
        const pts: Array<{ x: number; y: number; z: number }> = [];
        for (let x = -5; x <= 5; x += 0.25) {
            for (let y = -5; y <= 5; y += 0.25) {
                pts.push({ x, y, z });
            }
        }
        return pts;
    };

    const lowRegion: DetectedIsland = {
        id: 'o-low',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        maxZ: 10,
        areaMm2: 120,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(makePlatePts(10)),
        perimeterLoops: [[[-6, -6, 10], [6, -6, 10], [6, 6, 10], [-6, 6, 10]]],
    };
    const highRegion: DetectedIsland = {
        id: 'o-high',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 14),
        baseZ: 14,
        maxZ: 14,
        areaMm2: 120,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(makePlatePts(14)),
        perimeterLoops: [[[-6, -6, 14], [6, -6, 14], [6, 6, 14], [-6, 6, 14]]],
    };

    // (a) Single stepped flat region without mesh: tip on lower step Z=10 must NOT cover Z=14 step.
    const singleStepped: DetectedIsland = {
        id: 'o-stepped-flat',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        maxZ: 14,
        areaMm2: 240,
        overhangAngleDeg: 0,
        contactVoxels: footprintFromPoints([...makePlatePts(10), ...makePlatePts(14)]),
    };
    const lowerOnlyTips = [
        { x: -3, y: -3, z: 10 },
        { x: 3, y: -3, z: 10 },
        { x: -3, y: 3, z: 10 },
        { x: 3, y: 3, z: 10 },
        { x: 0, y: 0, z: 10 },
    ];
    const steppedCov = computeRegionCoverage(singleStepped, lowerOnlyTips, 3.0);
    assert.ok(steppedCov < 0.6, `tip on Z=10 step cannot cover Z=14 step (cov=${steppedCov})`);

    // (b) Separate stacked plates with mesh: lower tips at Z=10 give 0 coverage on upper plate Z=14.
    const highCov = computeRegionCoverage(highRegion, lowerOnlyTips, 3.0, mesh);
    assert.equal(highCov, 0, 'lower plate tips at Z=10 provide zero coverage to upper plate Z=14 across solid gap');

    const gapCands = buildGapFillCandidates(
        [lowRegion, highRegion],
        createDefaultAutoSupportSettings(),
        lowerOnlyTips,
        0.05,
        mesh,
    );
    assert.ok(gapCands.some((c) => Math.abs(c.tipPos.z - 14) < 0.2), 'gap-fill still emits upper plate Z=14 candidates');

    // (c) deduplicateCandidates with mesh keeps both low (Z=10) and high (Z=14) candidates.
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.5 };
    const mkOv = (id: string, z: number, priority: number): CandidatePoint => ({
        id,
        tipPos: { x: 0, y: 0, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'stacked',
        source: 'overhang',
        islandAreaMm2: 120,
        zHeight: z,
        priority,
        gridPoint: true,
    });
    const dedupStacked = deduplicateCandidates(
        [mkOv('low', 10, 0.9), mkOv('high', 14, 0.8)],
        settings,
        mesh,
    );
    assert.equal(dedupStacked.length, 2, 'stacked overhang shelves survive deduplication across Plate 1');

    // (d) Full end-to-end plan supports BOTH Z=10 and Z=14 shelves.
    const plan = computeAutoSupportPlan(
        [lowRegion, highRegion],
        'stacked-model',
        { debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
        getSnapshot(),
        mesh,
    );
    assert.ok(plan);
    const placedTips = collectContactPositions(plan.support, 'stacked-model');
    assert.ok(placedTips.some((t) => Math.abs(t.z - 10) < 0.6), 'lower shelf Z=10 receives supports');
    assert.ok(placedTips.some((t) => Math.abs(t.z - 14) < 0.6), 'upper shelf Z=14 receives supports');
});

// ---------------------------------------------------------------------------
// 9. deduplicateCandidates: discrete authority vs non-grid overhang + no ghost eviction
// ---------------------------------------------------------------------------

test('E2-9: deduplicateCandidates keeps discrete islands over non-grid overhang and avoids ghost eviction', () => {
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.5 };
    const mk = (id: string, source: CandidatePoint['source'], x: number, y: number, z: number, priority: number, gridPoint?: boolean): CandidatePoint => ({
        id,
        tipPos: { x, y, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source,
        islandAreaMm2: source === 'overhang' ? 10 : 0.05,
        zHeight: z,
        priority,
        gridPoint,
    });

    // (a) Higher-priority non-gridPoint overhang must yield to nearby minima/intersection discrete candidate.
    const a = deduplicateCandidates([
        mk('ov-small', 'overhang', 0, 0, 10, 0.9, false),
        mk('min-0', 'minima', 0.55, 0, 10, 0.5, false),
    ], settings);
    assert.deepEqual(a.map((c) => c.id), ['min-0'], 'discrete minima evicts non-gridPoint overhang within pairRadius');

    // (b) Ghost eviction: d-keep (prio 1.0) suppresses d-dup (prio 0.8), so d-dup MUST NOT evict ov-far (prio 0.9)!
    // d-keep at (0, 0) and ov-far at (-0.55, 0) are > pairRadius? No, use d-keep at (0,0), d-dup at (0.3, 0),
    // and ov-far at (0.85, 0): d-keep vs d-dup = 0.3 <= 0.5 -> d-dup suppressed; d-dup vs ov-far = 0.55 <= 0.6;
    // d-keep vs ov-far = 0.85 > 0.6 -> ov-far must survive!
    const b = deduplicateCandidates([
        mk('d-keep', 'voxel', 0, 0, 10, 1.0, false),
        mk('ov-far', 'overhang', 0.85, 0, 10, 0.9, true),
        mk('d-dup', 'voxel', 0.3, 0, 10, 0.8, false),
    ], settings);
    const bIds = new Set(b.map((c) => c.id));
    assert.equal(bIds.has('d-keep'), true);
    assert.equal(bIds.has('d-dup'), false);
    assert.equal(bIds.has('ov-far'), true, 'suppressed discrete candidate must not ghost-evict adjacent grid point');
});

// ---------------------------------------------------------------------------
// 10. generateGridCandidates: Z-aware pin backoff + narrow-rim fallback + other-region pin isolation
// ---------------------------------------------------------------------------

test('E2-10: generateGridCandidates preserves Z-separated boundary rings, foreign-covered pins, and distant narrow-rim fallback', () => {
    initializeBVH();
    const geom = new THREE.BoxGeometry(10, 10, 2);
    geom.translate(0, 0, 15);
    accelerateGeometry(geom);
    const mesh = new THREE.Mesh(geom);
    mesh.updateMatrixWorld(true);

    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -4; x <= 4; x += 0.25) {
        for (let y = -4; y <= 4; y += 0.25) {
            pts.push({ x, y, z: 14 });
        }
    }
    const region: DetectedIsland = {
        id: 'ov-main',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 14),
        baseZ: 14,
        maxZ: 14,
        areaMm2: 64,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(pts),
        perimeterLoops: [[[-4, -4, 14], [4, -4, 14], [4, 4, 14], [-4, 4, 14]]],
    };

    // Pin belonging to ANOTHER region ('ov-other') sitting inside XY box & 0.2mm Z away must not strip ov-main ring,
    // and even a pin without coveredByOverhangId would stay Z-isolated rather than stripping Z-distant rings.
    const foreignPin: DetectedIsland = {
        id: 'pin-foreign',
        source: 'voxel',
        class: 'intersection',
        coveredByOverhangId: 'ov-other',
        isDetached: true,
        contact: new THREE.Vector3(3.5, 0, 14),
        baseZ: 14,
        areaMm2: 0.5,
    };
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.5 };
    const baseline = generateGridCandidates([region], settings, mesh, 'm', false, 2, 0, 5, []);
    const withForeignPin = generateGridCandidates([region], settings, mesh, 'm', false, 2, 0, 5, [foreignPin]);
    assert.equal(withForeignPin.length, baseline.length, 'foreign coveredByOverhangId pin does not clear ov-main grid/ring');

    // Sloped region spanning Z=6..14 with an unannotated pin at Z=6 at (3.5, 0):
    // pushing pinnedAnchors into 2D lattice previously erased Z=14 boundary ring points above (3.5, 0)!
    const slopedRegion: DetectedIsland = {
        ...region,
        id: 'ov-sloped',
        baseZ: 6,
        maxZ: 14,
    };
    const lowPin: DetectedIsland = {
        id: 'pin-z6',
        source: 'voxel',
        class: 'intersection',
        isDetached: true,
        contact: new THREE.Vector3(3.5, 0, 6),
        baseZ: 6,
        areaMm2: 0.5,
    };
    const slopedBase = generateGridCandidates([slopedRegion], settings, mesh, 'm', false, 2, 0, 5, []);
    const slopedWithLowPin = generateGridCandidates([slopedRegion], settings, mesh, 'm', false, 2, 0, 5, [lowPin]);
    assert.equal(
        slopedWithLowPin.filter((c) => Math.abs(c.tipPos.z - 14) < 0.2).length,
        slopedBase.filter((c) => Math.abs(c.tipPos.z - 14) < 0.2).length,
        'pin 8mm below boundary ring at Z=6 must not strip Z=14 boundary ring points',
    );

    // Narrow 0.6 x 6mm rim with an active pin at the far x=-2.5 end: fallback at x=0 still emits when !isNearPinnedAnchor.
    const narrowGeom = new THREE.BoxGeometry(6, 0.6, 2);
    narrowGeom.translate(0, 0, 15);
    accelerateGeometry(narrowGeom);
    const narrowMesh = new THREE.Mesh(narrowGeom);
    narrowMesh.updateMatrixWorld(true);
    const narrowPts: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -3; x <= 3; x += 0.25) {
        for (let y = -0.25; y <= 0.25; y += 0.25) {
            narrowPts.push({ x, y, z: 14 });
        }
    }
    const narrowRegion: DetectedIsland = {
        id: 'ov-narrow',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 14),
        baseZ: 14,
        maxZ: 14,
        areaMm2: 3.6,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(narrowPts),
        perimeterLoops: [[[-3, -0.3, 14], [3, -0.3, 14], [3, 0.3, 14], [-3, 0.3, 14]]],
    };
    const distantPin: DetectedIsland = {
        id: 'pin-end',
        source: 'voxel',
        class: 'intersection',
        coveredByOverhangId: 'ov-narrow',
        isDetached: true,
        contact: new THREE.Vector3(-2.5, 0, 14),
        baseZ: 14,
        areaMm2: 0.5,
    };
    const narrowCands = generateGridCandidates([narrowRegion], settings, narrowMesh, 'm', false, 2, 0, 5, [distantPin]);
    assert.ok(narrowCands.length >= 1, 'narrow rim with distant pin at x=-2.5 still emits non-overlapping support');
});

// ---------------------------------------------------------------------------
// 11. surface-coverage: coveredByOverhangId skip + 4x4mm Z=3/Z=15 & 10x10mm Z=15 with zero horizontal stubs
// ---------------------------------------------------------------------------

test('E2-11: surface-coverage skips overhang-covered islands and places multi-point supports without horizontal 0° stubs on 4x4 and 10x10 detached plates', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();
    const prevSettings = getSettings();
    const s = createDefaultSettings();
    s.grid.enabled = false;
    setSettings(s);

    const makeSquarePts = (size: number, z: number) => {
        const half = size / 2;
        const pts: Array<{ x: number; y: number; z: number }> = [];
        for (let x = -half; x <= half; x += 0.25) {
            for (let y = -half; y <= half; y += 0.25) {
                pts.push({ x, y, z });
            }
        }
        return pts;
    };

    try {
        // (a) 4x4 mm detached plate at Z = 3 (no tall trunk hosts) AND Z = 15 (has centroid trunk t0)
        for (const z of [3, 15]) {
            resetStore();
            const plate4: DetectedIsland = {
                id: `v-4x4-z${z}`,
                source: 'voxel',
                class: 'voxelOnly',
                isDetached: true,
                contact: new THREE.Vector3(0, 0, z),
                baseZ: z,
                areaMm2: 16,
                contactVoxels: footprintFromPoints(makeSquarePts(4, z)),
            };
            const res = runAutoPlace([plate4], `plate4-z${z}`, {
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
            });
            assert.equal(res.changed, true);
            const snap = getSnapshot();
            const tips = collectContactPositions(snap, `plate4-z${z}`);
            assert.ok(tips.length >= 4, `4x4 detached plate at Z=${z} gets multi-point supports (got ${tips.length})`);
            for (const br of Object.values(snap.branches)) {
                if (br.modelId !== `plate4-z${z}`) continue;
                let prevZ = snap.knots[br.parentKnotId]?.pos.z ?? 0;
                const coneZ = br.contactCone?.pos.z ?? z;
                for (const seg of br.segments) {
                    const bz = seg.bottomJoint?.pos.z ?? prevZ;
                    const tz = seg.topJoint?.pos.z ?? coneZ;
                    const dz = tz - bz;
                    assert.ok(dz >= 0.5, `no horizontal stub segment on 4x4 plate Z=${z} (dz=${dz})`);
                    prevZ = tz;
                }
            }
        }

        // (b) 10x10 mm detached plate at Z = 15 with grid: false must have zero horizontal 0° branches
        resetStore();
        const plate10: DetectedIsland = {
            id: 'v-10x10-z15',
            source: 'voxel',
            class: 'voxelOnly',
            isDetached: true,
            contact: new THREE.Vector3(0, 0, 15),
            baseZ: 15,
            areaMm2: 100,
            contactVoxels: footprintFromPoints(makeSquarePts(10, 15)),
        };
        runAutoPlace([plate10], 'plate10-z15', {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        });
        const snap10 = getSnapshot();
        const tips10 = collectContactPositions(snap10, 'plate10-z15');
        assert.ok(tips10.length >= 5, `10x10 detached plate at Z=15 gets distributed supports (got ${tips10.length})`);
        for (const br of Object.values(snap10.branches)) {
            if (br.modelId !== 'plate10-z15') continue;
            let prevZ = snap10.knots[br.parentKnotId]?.pos.z ?? 0;
            const coneZ = br.contactCone?.pos.z ?? 15;
            for (const seg of br.segments) {
                const bz = seg.bottomJoint?.pos.z ?? prevZ;
                const tz = seg.topJoint?.pos.z ?? coneZ;
                const dz = tz - bz;
                assert.ok(dz >= 0.5, `no horizontal stub segment on 10x10 plate Z=15 (dz=${dz})`);
                prevZ = tz;
            }
        }

        // (c) Detached voxel island already coveredByOverhangId must NOT get duplicate surface-coverage branches/trunks
        resetStore();
        const coveredDetached: DetectedIsland = {
            id: 'v-covered',
            source: 'voxel',
            class: 'voxelOnly',
            isDetached: true,
            coveredByOverhangId: 'o-parent',
            contact: new THREE.Vector3(0, 0, 15),
            baseZ: 15,
            areaMm2: 100,
            contactVoxels: footprintFromPoints(makeSquarePts(10, 15)),
        };
        runAutoPlace([coveredDetached], 'covered-model', {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
            minimaReinforcementEnabled: false,
        });
        const coveredSnap = getSnapshot();
        const coveredTips = collectContactPositions(coveredSnap, 'covered-model');
        assert.equal(Object.keys(coveredSnap.branches).length, 0, 'coveredByOverhangId island spawns zero surface-coverage stub branches');
        assert.ok(coveredTips.length < tips10.length && coveredTips.length <= 2,
            `coveredByOverhangId island skips surface-coverage multi-point placement (got ${coveredTips.length} vs uncovered ${tips10.length})`);
    } finally {
        setSettings(prevSettings);
        setModelMesh('plate4-z3', null);
        setModelMesh('plate4-z15', null);
        setModelMesh('plate10-z15', null);
        setModelMesh('covered-model', null);
        disposeHandlers();
    }
});

// ---------------------------------------------------------------------------
// 12. minimaReinforcement: no ray tunneling through flat ceiling to upper overhang
// ---------------------------------------------------------------------------

test('E2-12: computeMinimaReinforcementPoints inspects first hit only and does not tunnel to upper overhang', () => {
    initializeBVH();
    const bLow = new THREE.BoxGeometry(10, 10, 0.5).toNonIndexed();
    bLow.translate(0, 0, 10.25); // Z ∈ [10.0, 10.5]
    const bHigh = new THREE.BoxGeometry(10, 10, 1).toNonIndexed();
    bHigh.translate(0, 0, 12.0); // Z ∈ [11.5, 12.5]
    const p1 = bLow.attributes.position.array as Float32Array;
    const p2 = bHigh.attributes.position.array as Float32Array;
    const mergedPos = new Float32Array(p1.length + p2.length);
    mergedPos.set(p1, 0);
    mergedPos.set(p2, p1.length);
    const n1 = bLow.attributes.normal.array as Float32Array;
    const n2 = bHigh.attributes.normal.array as Float32Array;
    const mergedNorm = new Float32Array(n1.length + n2.length);
    mergedNorm.set(n1, 0);
    mergedNorm.set(n2, n1.length);
    bLow.dispose();
    bHigh.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    accelerateGeometry(geom);
    const mesh = new THREE.Mesh(geom);
    mesh.updateMatrixWorld(true);

    const minimaAtFlatCeiling: DetectedIsland = {
        id: 'm-flat-ceiling',
        source: 'minima',
        class: 'minimaOnly',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
    };
    const pts = computeMinimaReinforcementPoints([minimaAtFlatCeiling], mesh, createDefaultAutoSupportSettings());
    assert.equal(pts.length, 0, 'rays stopping on flat Z=10 ceiling must not tunnel through to upper Z=11.5 overhang');
});
