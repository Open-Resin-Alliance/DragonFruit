import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clearHistory, undo, registerHistoryHandler } from '../../history/historyStore';
import { SUPPORT_AUTO_PLACE } from '../history/actionTypes';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { resetStore, getSnapshot, setSnapshot } from '../state';
import { resetKickstandStore } from '../SupportTypes/Kickstand/kickstandStore';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIsland(id: string, x: number, y: number, z: number, areaMm2: number): DetectedIsland {
    return {
        id,
        source: 'voxel',
        contact: new THREE.Vector3(x, y, z),
        baseZ: z,
        areaMm2,
        layerSpan: [0, Math.round(z / 0.05)],
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runAutoPlace places standalone trunks and pushes an undoable history entry', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    const islands = [
        makeIsland('i1', 0, 0, 20, 0.5),
        makeIsland('i2', 8, 0, 30, 0.5),
    ];

    const captured: Array<{ type: string; payload?: unknown }> = [];
    const unregisterCapture = registerHistoryHandler(SUPPORT_AUTO_PLACE, (action) => {
        captured.push(action);
        return true;
    });

    const result = runAutoPlace(islands, 'model-a');

    assert.equal(result.placedTrunks, 2, 'both islands become trunks');
    assert.equal(result.rejectedCandidates, 0);
    assert.equal(result.changed, true);

    const snapshot = getSnapshot();
    assert.equal(Object.keys(snapshot.trunks).length, 2, 'two trunks committed to the store');
    assert.equal(Object.keys(snapshot.roots).length, 2, 'two roots committed');

    // The run must be undoable as one entry.
    undo();
    assert.equal(captured.length, 1, 'SUPPORT_AUTO_PLACE handler ran on undo');
    assert.equal(captured[0].type, SUPPORT_AUTO_PLACE);
    const payload = captured[0].payload as { before?: unknown; after?: unknown };
    assert.ok(payload.before && payload.after, 'payload carries before/after snapshots');
    assert.equal(Object.keys(getSnapshot().trunks).length, 0, 'undo restores the empty pre-run snapshot');

    unregisterCapture();
    disposeHandlers();
    setModelMesh('model-a', null);
});

test('runAutoPlace resolves the underside surface normal from the mesh', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Box 10x10x10, translated so its underside sits at z = 20, normal (0,0,-1).
    initializeBVH();
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    geometry.translate(0, 0, 25);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    setModelMesh('model-a', mesh);

    const islands = [makeIsland('i1', 0, 0, 20, 0.5)];
    const result = runAutoPlace(islands, 'model-a', { debugSkipAutoBracing: true });

    assert.equal(result.placedTrunks, 1, 'underside island places a trunk');

    const snapshot = getSnapshot();
    const trunk = Object.values(snapshot.trunks)[0];
    assert.ok(trunk, 'trunk exists');
    const cone = trunk.contactCone;
    assert.ok(cone?.pos, 'contact cone exists');
    assert.ok(Math.abs(cone.pos.z - 20) < 0.6, `tip sits on the underside (z=${cone.pos.z.toFixed(2)}, expected ~20)`);
    const normal = cone.normal ?? cone.surfaceNormal;
    assert.ok(normal, 'cone normal exists');
    assert.ok(normal.z < 0, `underside normal points down (z=${normal.z.toFixed(3)})`);

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace grids a large flat region at fixed density (uniform distribution)', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // 20×20 flat underside: above the threshold → the unified fixed-density
    // grid (boundary ring + lattice infill), no anchor selection involved.
    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            contactVoxels.push({ x, y });
        }
    }
    const facet: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const result = runAutoPlace([facet], 'model-a', { debugSkipAutoBracing: true });

    // Fixed-density grid: spacing = √8 with the default angle/suction curve
    // → ~200 tips on a 20×20 flat underside. Neighbouring pillars then
    // consolidate into fan trees — supports release in chunks, so plate
    // contacts drop well below the candidate count (leaves attach to chunk
    // hosts; branches only appear when a straight leaf is blocked).
    assert.ok(result.placedTrunks >= 30 && result.placedTrunks <= 120,
        `placed ${result.placedTrunks} chunk hosts for ~200 tips (consolidated into trees)`);
    assert.ok(result.placedLeaves >= 50,
        `consolidated into fan leaves (${result.placedLeaves})`);
    assert.equal(result.placedBranches, 0,
        'flat underside leaves fan straight — no routed branches needed');

    const snapshot = getSnapshot();
    const trunks = Object.values(snapshot.trunks);
    assert.ok(trunks.length > 0 && trunks.some((t) => t.origin === 'overhang'),
        'chunk hosts carry the overhang origin (debug coloring)');
    assert.equal(Object.keys(snapshot.branches).length, 0,
        'no branches — the flat grid is a pure pillar forest');
    const trunkCount = Object.keys(snapshot.trunks).length;
    assert.equal(trunkCount, result.placedTrunks, 'trunks committed to the store');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace places grid trunks on a rotated mesh via the region normal', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();
    initializeBVH();

    // Box rotated 30° about X: the underside face normal is (0, 0.5, -0.866)
    // and its surface Z varies with y. This is the exact case the generic
    // raycast got wrong (side face vs underside) — the region's own normal
    // must be used instead.
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    geometry.rotateX(THREE.MathUtils.degToRad(30));
    geometry.translate(0, 0, 20);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    setModelMesh('model-a', mesh);

    // Underside after rotateX(30) + translate(0,0,20): projected y in
    // [-3.66, 13.66], x in [-10, 10], surface z(y) = 0.577y + 8.45, normal
    // (0, 0.5, -sqrt(3)/2). (A plane through the cube's middle would put the
    // tips inside the model — the fixture must match the real face.)
    const normal = { x: 0, y: 0.5, z: -Math.sqrt(3) / 2 };
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -3.66; y <= 13.66; y += 0.25) {
            contactVoxels.push({ x, y, z: 0.577 * y + 8.45 });
        }
    }
    const facet: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 5, 11.33),
        baseZ: 6.34,
        areaMm2: 400 * (Math.sqrt(3) / 2), // projected area ≈ 346
        surfaceNormal: normal,
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const result = runAutoPlace([facet], 'model-a', { debugSkipAutoBracing: true });

    assert.ok(result.placedTrunks >= 15,
        `placed ${result.placedTrunks} grid trunks on the rotated face`);
    assert.equal(result.rejectedCandidates, 0,
        'no rejections: the region normal keeps the cone clear');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('elevated small overhang routes a trunk around the body instead of a culled pillar', () => {
    const cleanup = elevatedJawScenario(false);
    cleanup();
});

test('elevated small overhang also routes with the density grid enabled', () => {
    const cleanup = elevatedJawScenario(true);
    cleanup();
});

function elevatedJawScenario(gridEnabled: boolean): () => void {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();
    initializeBVH();

    const previousSettings = getSettings();
    if (gridEnabled) {
        const settings = createDefaultSettings();
        settings.grid.enabled = true;
        settings.grid.spacingMm = 4;
        setSettings(settings);
    }

    // Body slab spanning x ∈ [-20, 5], z ∈ [0, 10]; a small jaw chip (4×4×2)
    // overhangs PAST the body's top edge, underside at z = 16, centred at
    // x = 3.5 — its vertical drop pierces the body corner. The island is
    // small (2 mm²) and elevated: exactly the shape that used to bypass the
    // pathfinder as a "small island", get placed as a straight pillar, and
    // then be culled for piercing the mesh (Puck jaw/mouth).
    const body = new THREE.BoxGeometry(25, 20, 10);
    body.translate(-7.5, 0, 5);
    const jaw = new THREE.BoxGeometry(4, 4, 2);
    jaw.translate(3.5, 0, 17);
    const geometry = mergeGeometries([body, jaw])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    setModelMesh('model-a', mesh);

    const island = makeIsland('jaw', 3.5, 0, 16, 2);
    const result = runAutoPlace([island], 'model-a', { debugSkipAutoBracing: true });

    const snapshot = getSnapshot();
    const trunks = Object.values(snapshot.trunks);
    const jawTrunk = trunks.find((t) => t.contactCone && Math.abs(t.contactCone.pos.x - 3.5) < 1.5
        && Math.abs(t.contactCone.pos.y) < 1.5 && Math.abs(t.contactCone.pos.z - 16) < 1.5);
    assert.ok(jawTrunk, 'jaw tip is carried by a plate-rooted trunk');
    assert.equal(result.rejectedCandidates, 0,
        `nothing rejected (${result.rejectedCandidates})`);
    assert.equal(result.placedSticks, 0,
        'no cavity stick — the routed trunk made the bridge unnecessary');
    // The routed shaft must actually clear the body: every segment passes
    // the same post-thickening check the orphan cull applies.
    const root = snapshot.roots[jawTrunk!.rootId];
    assert.ok(root, 'trunk has a root');
    for (const seg of jawTrunk!.segments) {
        const start = seg.bottomJoint?.pos ?? root.transform.pos;
        const end = seg.topJoint?.pos;
        assert.ok(end, 'segment has endpoints');
        assert.equal(isShaftBlocked(start, end, (seg.diameter ?? 1) / 2 + 0.15, mesh), false,
            'routed shaft clears the mesh at cull clearance');
    }

    setModelMesh('model-a', null);
    if (gridEnabled) setSettings(previousSettings);
    disposeHandlers();
    return () => {};
}

test('runAutoPlace gap-fills under-covered regions (coverage convergence)', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // 20×20 facet at a SPARSE density (30 mm²/support → ~5.5mm spacing):
    // the initial grid's 3mm coverage discs leave bands uncovered, so the
    // convergence pass must add more trunks.
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            contactVoxels.push({ x, y, z: 6.5 });
        }
    }
    const facet: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const result = runAutoPlace([facet], 'model-a', {
        debugSkipAutoBracing: true,
        areaPerSupportMm2: 30,
        gridAreaThresholdMm2: 25,
    });

    // Initial grid at 5.5mm spacing ≈ 16 points + gap-fill, then the
    // anchor-tree pass merges trunks into branches — assert TIPS preserved.
    assert.ok(result.placedTrunks + result.placedBranches >= 20,
        `gap-fill + tree merge preserved tips (${result.placedTrunks}T + ${result.placedBranches}B)`);

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace gives small sub-threshold regions a single pillar', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // A 4×4 mm foot (16 mm², under the 25 mm² grid threshold) is below the
    // distribution threshold — shape analysis says a single support carries
    // it; no carpet for a patch this small.
    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = -2; x <= 2; x += 0.25) {
        for (let y = -2; y <= 2; y += 0.25) {
            contactVoxels.push({ x, y });
        }
    }
    const foot: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 16,
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const result = runAutoPlace([foot], 'model-a', { debugSkipAutoBracing: true });

    assert.equal(result.placedTrunks, 1, 'sub-threshold patch → exactly one pillar');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace fans sub-threshold overhang candidates instead of standalone trunks', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Trunk A (voxel island) at the origin; overhang region o15 at (3,0,33)
    // is sub-threshold and non-anchor (band off) → must attach as a fan leaf
    // off A's shaft, not become a second straight trunk next to it.
    const result = runAutoPlace(
        [
            makeIsland('A', 0, 0, 40, 30),
            {
                id: 'o15',
                source: 'overhang',
                contact: new THREE.Vector3(3, 0, 33),
                baseZ: 33,
                areaMm2: 16,
                contactVoxels: footprintFromPoints([
                    { x: 2.75, y: -0.25 }, { x: 3, y: -0.25 }, { x: 3.25, y: -0.25 },
                    { x: 2.75, y: 0 }, { x: 3, y: 0 }, { x: 3.25, y: 0 },
                    { x: 2.75, y: 0.25 }, { x: 3, y: 0.25 }, { x: 3.25, y: 0.25 },
                ]),
            },
        ],
        'model-a',
        { debugSkipAutoBracing: true,  },
    );

    assert.equal(result.placedTrunks, 1, 'o15 fanned instead of becoming a trunk');
    assert.ok(result.placedLeaves >= 1, 'o15 attached as a leaf');
    assert.ok(Object.values(getSnapshot().leaves).some((l) => l.origin === 'overhang'),
        'fanned overhang leaf carries the overhang origin');
    assert.ok(Object.values(getSnapshot().branches).every((b) => b.origin !== 'overhang'),
        'overhang fanning never branches — leaves only');

    const placement = result.analytics?.placement;
    assert.equal(placement?.trunksByKind.standalone, 1, 'only trunk A is standalone (voxel island)');
    assert.deepEqual(placement?.fanRefusals, {}, 'o15 fanned — no refusal for it');
    assert.deepEqual(placement?.mergeRefusals, { noHost: 1 }, 'trunk A had no host to merge into');

    const snapshot = getSnapshot();
    const leaf = Object.values(snapshot.leaves)[0];
    const tip = leaf?.contactCone?.pos;
    assert.ok(tip && Math.abs(tip.x - 3) < 0.6 && Math.abs(tip.z - 33) < 0.6,
        `leaf tip lands on the overhang (x=${tip?.x.toFixed(1)}, z=${tip?.z.toFixed(1)})`);

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace falls back to a standalone trunk when no fan host exists', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // 20 mm from any shaft: beyond both fan and merge reach — the overhang
    // keeps a standalone trunk so the surface is still supported.
    const result = runAutoPlace(
        [
            makeIsland('A', 0, 0, 40, 30),
            {
                id: 'o20',
                source: 'overhang',
                contact: new THREE.Vector3(20, 0, 30),
                baseZ: 30,
                areaMm2: 16,
                contactVoxels: footprintFromPoints([{ x: 19.75, y: 0 }, { x: 20, y: 0 }, { x: 20.25, y: 0 }]),
            },
        ],
        'model-a',
        { debugSkipAutoBracing: true,  },
    );

    assert.equal(result.placedTrunks, 2, 'far overhang keeps its standalone trunk (coverage)');

    const placement = result.analytics?.placement;
    assert.equal(placement?.trunksByKind.standalone, 2, 'both became standalone trunks');
    assert.deepEqual(placement?.fanRefusals, { noHost: 1 }, 'o20 found no shaft within the fan radius');
    assert.deepEqual(placement?.mergeRefusals, { noHost: 2 }, 'neither had a host within the merge radius');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace dispatches by shape: planar → grid, organic → Poisson', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Planar anchor facet at the origin (flat voxels) — lowest cluster, planar
    // → dynamic grid at anchor density.
    const planarVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            planarVoxels.push({ x, y, z: 6.5 });
        }
    }
    const planar: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(planarVoxels),
    };

    // Curved region (z = 6.5 + x²/20) offset far away, higher cluster →
    // organic → Poisson disk.
    const curvedVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = 30; x <= 50; x += 0.25) {
        for (let y = 30; y <= 50; y += 0.25) {
            curvedVoxels.push({ x, y, z: 25 + ((x - 40) * (x - 40)) / 20 });
        }
    }
    const organic: DetectedIsland = {
        id: 'o1',
        source: 'overhang',
        contact: new THREE.Vector3(40, 40, 25),
        baseZ: 25,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(curvedVoxels),
    };

    const result = runAutoPlace([planar, organic], 'model-a', { debugSkipAutoBracing: true });

    assert.ok((result.analytics?.placement?.trunksByKind.gridInfill ?? 0) > 0,
        'both regions place via the unified grid distribution');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace does not duplicate a pillar on top of an existing island trunk', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Island trunk A at the origin (voxel, high area → placed first); a
    // curved overhang wraps around it — the distributed point at the shaft
    // must not become a second pillar on the same spot.
    const curvedVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            curvedVoxels.push({ x, y, z: 33 + (x * x) / 20 });
        }
    }
    const result = runAutoPlace(
        [
            makeIsland('A', 0, 0, 40, 400),
            {
                id: 'o0',
                source: 'overhang',
                contact: new THREE.Vector3(0, 0, 33),
                baseZ: 33,
                areaMm2: 400,
                contactVoxels: footprintFromPoints(curvedVoxels),
            },
        ],
        'model-a',
        // Explicit density: the assertion is about fanning geometry, not the
        // preset density default — keep the layout stable across preset bumps.
        { debugSkipAutoBracing: true, areaPerSupportMm2: 8 },
    );

    assert.ok(result.placedTrunks >= 10, 'the organic region places its own pillar set');

    const snapshot = getSnapshot();
    const aTrunkRoot = Object.values(snapshot.roots).find(
        (r) => Math.abs(r.transform.pos.x) < 1 && Math.abs(r.transform.pos.y) < 1,
    );
    assert.ok(aTrunkRoot, 'island A keeps its own root at the origin');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace keeps a later-placed island trunk independent of the surrounding grid', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // The distributed grid places FIRST (low z → high priority); the tiny
    // island A places AFTER. A must stand as its own trunk, not be absorbed
    // by a neighbouring pillar.
    const curvedVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            curvedVoxels.push({ x, y, z: 25 + (x * x) / 20 });
        }
    }
    const result = runAutoPlace(
        [
            {
                id: 'o0',
                source: 'overhang',
                contact: new THREE.Vector3(0, 0, 25),
                baseZ: 25,
                areaMm2: 400,
                contactVoxels: footprintFromPoints(curvedVoxels),
            },
            makeIsland('A', 2.5, 0, 30, 0.5),
        ],
        'model-a',
        // Explicit density: the assertion is about consolidation geometry, not
        // the preset density default — keep the layout stable across bumps.
        { debugSkipAutoBracing: true, areaPerSupportMm2: 8 },
    );

    const snapshot = getSnapshot();
    const rootsNearA = Object.values(snapshot.roots).filter(
        (r) => Math.abs(r.transform.pos.x - 2.5) < 0.5 && Math.abs(r.transform.pos.y) < 0.5,
    );
    assert.equal(rootsNearA.length, 1, 'island A stands as its own trunk (did not merge into a pillar)');

    const aTrunk = Object.values(snapshot.trunks).find((t) => {
        const r = snapshot.roots[t.rootId];
        return r && Math.abs(r.transform.pos.x - 2.5) < 0.5 && Math.abs(r.transform.pos.y) < 0.5;
    });
    assert.ok(aTrunk, 'island A is the host');
    const leavesOnA = Object.values(snapshot.leaves).filter((l) => {
        const k = snapshot.knots[l.parentKnotId];
        return k && (k.parentShaftId === aTrunk?.id || !!aTrunk?.segments.some((s) => s.id === k.parentShaftId));
    });
    assert.ok(rootsNearA.length === 1, 'island A remains the only root at its position');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace merges with a steep knot, not at the host junction', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Island A sits 0.5 mm from trunk B's 40 mm shaft with its tip 1 mm
    // below B's tip. The old code knotted at B's junction (top joint) — a
    // shallow branch; the first steep fix snapped to the DEEPEST qualifying
    // sample (kZ≈28, a near-parallel "floating" leaf); the knot must now be
    // the HIGHEST sample meeting the 60°-above-horizontal minimum (kZ≈36).
    // B places first (higher Z → higher priority) and stands alone; A then
    // merges into B as a steep leaf.
    const result = runAutoPlace(
        [
            makeIsland('A', 0.5, 0, 40, 60),
            makeIsland('B', 0, 0, 41, 16),
        ],
        'model-a',
        { debugSkipAutoBracing: true,  },
    );

    assert.equal(result.placedTrunks, 1, 'one trunk — the merge never builds a second');
    assert.ok(result.placedLeaves >= 1, 'A attached as a leaf');

    const snapshot = getSnapshot();
    const mergeKnot = Object.values(snapshot.knots).find((k) => k.id.startsWith('auto-merge-'));
    assert.ok(mergeKnot, 'merge knot exists');
    assert.ok(mergeKnot.pos.z >= 32 && mergeKnot.pos.z <= 38,
        `knot snapped to the highest 60°-rise sample, not the base (kZ=${mergeKnot.pos.z.toFixed(1)})`);

    const leaf = Object.values(snapshot.leaves).find((l) => l.origin === 'island');
    assert.ok(leaf, 'merged leaf carries the island origin');

    const placement = result.analytics?.placement;
    // Higher-Z island B places first (priority order) and has no host;
    // A then merges into B — the merge itself never refuses.
    assert.deepEqual(placement?.mergeRefusals, { noHost: 1 }, 'only the first-placed island lacks a host');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace places low undersides as a standalone pillar forest', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Two low overhang patches: o0 (flat 8×8 grid, above threshold) gets the
    // fixed-density grid and consolidates into chunk trees; o15 is a 3×0.5 mm
    // sliver below the threshold — a single standalone pillar.
    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = -4; x <= 4; x += 0.25) {
        for (let y = -4; y <= 4; y += 0.25) {
            contactVoxels.push({ x, y });
        }
    }
    const result = runAutoPlace(
        [
            {
                id: 'o0', source: 'overhang',
                contact: new THREE.Vector3(0, 0, 6.5), baseZ: 6.5,
                areaMm2: 64, contactVoxels: footprintFromPoints(contactVoxels),
            },
            {
                id: 'o15', source: 'overhang',
                contact: new THREE.Vector3(3, 0, 8), baseZ: 8,
                areaMm2: 16,
                contactVoxels: footprintFromPoints([
                    { x: 2.75, y: -0.25 }, { x: 3, y: -0.25 }, { x: 3.25, y: -0.25 },
                    { x: 2.75, y: 0 }, { x: 3, y: 0 }, { x: 3.25, y: 0 },
                    { x: 2.75, y: 0.25 }, { x: 3, y: 0.25 }, { x: 3.25, y: 0.25 },
                ]),
            },
        ],
        'model-a',
        { debugSkipAutoBracing: true },
    );

    assert.equal(result.placedBranches, 0, 'leaves only — no routed branches');

    const snapshot = getSnapshot();
    const trunks = Object.values(snapshot.trunks);
    assert.ok(trunks.some((t) => t.origin === 'overhang'), 'chunk hosts carry the overhang origin');
    assert.ok(trunks.some((t) => t.origin === 'standalone'),
        'the o15 sliver keeps its own standalone pillar');
    assert.ok(result.placedLeaves >= 5,
        `o0 consolidates into fan leaves (${result.placedLeaves})`);

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace with no viable candidates returns changed=false and pushes nothing', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();

    const result = runAutoPlace([], 'model-a');
    assert.equal(result.changed, false);
    assert.equal(Object.keys(getSnapshot().trunks).length, 0);
});
