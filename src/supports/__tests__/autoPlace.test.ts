import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { clearHistory, undo, registerHistoryHandler } from '../../history/historyStore';
import { SUPPORT_AUTO_PLACE } from '../history/actionTypes';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { resetStore, getSnapshot, setSnapshot } from '../state';
import { resetKickstandStore } from '../SupportTypes/Kickstand/kickstandStore';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

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

test('runAutoPlace anchors a large flat region as a densified grid (planar → grid)', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // 20×20 flat underside (the xyzCalibration cube bottom): the region is
    // in-band (lowest cluster → anchor density) AND planar → the shape-driven
    // dispatch gives it the dynamic grid at anchor spacing, not Poisson.
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

    // Anchor density owns the flat end (no flat-boost/suction stacking):
    // spacing = √8 × 0.7 ≈ 1.98 mm → ~121 tips. Anchors are load-bearing
    // pillars and ALWAYS stay standalone — no anchor-tree merging, so the
    // flat underside keeps its 1:1 pillar forest (no branches).
    assert.ok(result.placedTrunks >= 100 && result.placedTrunks <= 150,
        `placed ${result.placedTrunks} anchor trunks, expected ~121 standalone pillars (no tree merge)`);
    assert.equal(result.placedBranches, 0,
        'anchor trunks never merge into trees — standalone pillars only');
    assert.equal(result.placedLeaves, 0);
    assert.equal(result.analytics?.distribution.poisson, 0, 'planar region is not Poisson');

    const snapshot = getSnapshot();
    const trunks = Object.values(snapshot.trunks);
    assert.ok(trunks.length > 0 && trunks.every((t) => t.origin === 'anchor'),
        'anchor trunks carry the anchor origin (debug coloring)');
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

test('runAutoPlace densifies small anchor regions below the grid threshold', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // A 4×4 mm foot (16 mm², under the 25 mm² grid threshold) is the model's
    // lowest overhang → in-band anchor → must get a densified disk, not the
    // single support the region phase would give a sub-threshold island.
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

    // 4×4 foot → ~9 disk tips, then the anchor-tree pass merges them into a
    // branching tree (1–2 roots). Tips are preserved even though trunks drop.
    assert.ok(result.placedTrunks >= 1 && result.placedTrunks + result.placedBranches >= 8,
        `small anchor foot densified as a tree (${result.placedTrunks}T + ${result.placedBranches}B)`);

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
        { debugSkipAutoBracing: true, anchorBandHeightMm: 0 },
    );

    assert.equal(result.placedTrunks, 1, 'o15 fanned instead of becoming a trunk');
    assert.ok(result.placedLeaves >= 1, 'o15 attached as a leaf');
    assert.ok(Object.values(getSnapshot().leaves).some((l) => l.origin === 'overhang'),
        'fanned overhang leaf carries the overhang origin');
    assert.ok(Object.values(getSnapshot().branches).every((b) => b.origin !== 'overhang'),
        'overhang fanning never branches — leaves only');

    const placement = result.analytics?.placement;
    assert.equal(placement?.trunksByKind.standalone, 1, 'only trunk A is standalone (voxel island)');
    assert.equal(placement?.candidatesByDistribution.single, 2, 'both candidates are single (non-grid)');
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
        { debugSkipAutoBracing: true, anchorBandHeightMm: 0 },
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

    assert.equal(result.analytics?.distribution.grid, 1, 'planar region gridded');
    assert.equal(result.analytics?.distribution.poisson, 1, 'organic region poisson');
    assert.ok((result.analytics?.placement?.trunksByKind.gridInfill ?? 0) > 0,
        'planar anchor produces anchor trunks (some merged into trees)');
    assert.ok((result.analytics?.placement?.trunksByKind.poissonDisk ?? 0) > 0,
        'organic region placed via Poisson disk');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace fans organic poisson points into island trunks instead of duplicating pillars', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Island trunk A at the origin (voxel, high area → placed first); an
    // organic (curved, non-anchor) overhang wraps around it — the poisson
    // point at the shaft must attach as a leaf, not become a second pillar.
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
        { debugSkipAutoBracing: true, anchorBandHeightMm: 0, areaPerSupportMm2: 8 },
    );

    assert.ok(result.placedLeaves >= 1, 'organic poisson points fanned into the island trunk');

    const snapshot = getSnapshot();
    const rootsNearOrigin = Object.values(snapshot.roots).filter(
        (r) => Math.abs(r.transform.pos.x) < 1 && Math.abs(r.transform.pos.y) < 1,
    );
    assert.equal(rootsNearOrigin.length, 1,
        'the poisson point at the shaft attached as a leaf — no second pillar root');

    const aTrunk = Object.values(snapshot.trunks).find((t) => {
        const r = snapshot.roots[t.rootId];
        return r && Math.abs(r.transform.pos.x) < 1 && Math.abs(r.transform.pos.y) < 1;
    });
    assert.ok(aTrunk, 'island A is the host');
    const leavesOnA = Object.values(snapshot.leaves).some((l) => {
        const k = snapshot.knots[l.parentKnotId];
        return k && k.parentShaftId === aTrunk?.id;
    });
    assert.ok(leavesOnA, 'a fan leaf attaches to trunk A');

    setModelMesh('model-a', null);
    disposeHandlers();
});

test('runAutoPlace consolidates organic poisson trunks into island trunks placed later', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // The organic (non-anchor) poisson forest places FIRST (low z → high
    // priority); the tiny island A places AFTER. The poisson trunks near A
    // must consolidate into fan leaves on it — the junction reads as a tree.
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
        { debugSkipAutoBracing: true, anchorBandHeightMm: 0, areaPerSupportMm2: 8 },
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
        return k && k.parentShaftId === aTrunk?.id;
    });
    assert.ok(leavesOnA.length >= 1,
        'poisson trunks near A consolidated into fan leaves on it');

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
        { debugSkipAutoBracing: true, anchorBandHeightMm: 0 },
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

test('runAutoPlace keeps low undersides a standalone anchor pillar forest', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Two low overhang patches (one flat grid, one small) — both land in
    // the anchor band (lowest cluster). Anchors are load-bearing pillars:
    // no fanning, no merging, no anchor-tree merging — every candidate
    // stands alone with no leaves or branches anywhere.
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

    assert.equal(result.placedLeaves, 0, 'nothing fanned — anchors never host leaves');
    assert.equal(result.placedBranches, 0, 'no anchor-tree merging — anchors standalone');

    const snapshot = getSnapshot();
    const trunks = Object.values(snapshot.trunks);
    assert.ok(trunks.length >= 8, `both patches placed (${trunks.length} trunks)`);
    assert.ok(trunks.every((t) => t.origin === 'anchor'),
        'every low-face trunk is an anchor pillar');
    assert.equal(Object.keys(snapshot.knots).length, 0, 'no merge knots — all standalone');

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
