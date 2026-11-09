import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    generateCandidates,
    deduplicateCandidates,
    candidateFromIsland,
    candidatesFromIsland,
} from '../autoSupport/candidateGeneration';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from '../autoSupport/types';
import { influenceRadiusMm } from '../autoSupport/constants';
import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock DetectedIsland for testing.
 *
 * Defaults: voxel source, contact at (10, 20, baseZ) in world mm,
 * baseZ = 30 (or overrides.baseZ / overrides.contact.z if provided).
 *
 * When overriding contact or baseZ individually, keep them consistent
 * (baseZ should equal contact.z) for realistic test data.
 */
function makeIsland(overrides: Partial<DetectedIsland> = {}): DetectedIsland {
    const baseZ = overrides.baseZ ?? overrides.contact?.z ?? 30;
    return {
        id: 'test-id',
        source: 'voxel',
        contact: new THREE.Vector3(10, 20, baseZ),
        baseZ,
        areaMm2: 0.1,
        ...overrides,
    } as DetectedIsland;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a minima below the island floor still gets a contact once a voxel island covers it', () => {
    // What `classifyIntersection` hands the plan for a covered minimum: the voxel
    // island the scan let through, and the minima it matched, whose class it
    // rewrote to `intersection` and which carries no area of its own.
    const settings = { ...createDefaultAutoSupportSettings(), minIslandAreaMm2: 0.2 };
    const minima: DetectedIsland = {
        id: 'm0',
        source: 'minima',
        class: 'intersection',
        contact: new THREE.Vector3(10, 20, 30),
        baseZ: 30,
    };

    const covered = generateCandidates(
        [makeIsland({ id: 'v0', areaMm2: 0.05 }), minima],
        settings,
    );
    assert.deepEqual(covered.map((candidate) => candidate.id), ['m0'],
        'the minima keeps its contact while its voxel partner is filtered out');

    // The floor still rules for everything else: that same voxel island on its
    // own is below it and yields nothing.
    assert.deepEqual(generateCandidates([makeIsland({ id: 'v0', areaMm2: 0.05 })], settings), []);
});

test('generateCandidates does not filter by supported flag (handled by filterAlreadySupported)', () => {
    const islands = [
        makeIsland({ id: 'a' }),
        makeIsland({ id: 'b', supported: true }),
        makeIsland({ id: 'c', supported: false }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 3);
});

test('generateCandidates does not filter grounded islands (handled upstream by Plate toggle)', () => {
    const islands = [
        makeIsland({ id: 'a' }),
        makeIsland({ id: 'b', grounded: true }),
        makeIsland({ id: 'c', grounded: false }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    // Grounded filtering is the caller's responsibility — applyFilter()
    // in the Islands panel already respects the Plate toggle.
    assert.equal(candidates.length, 3);
});

test('generateCandidates filters by minIslandAreaMm2', () => {
    const islands = [
        makeIsland({ id: 'a', areaMm2: 0.01 }),
        makeIsland({ id: 'b', areaMm2: 0.05 }),
        makeIsland({ id: 'c', areaMm2: 0.10 }),
    ];
    const settings = {
        ...createDefaultAutoSupportSettings(),
        minIslandAreaMm2: 0.05,
    };
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 2);
    const ids = candidates.map((c) => c.id);
    assert.ok(ids.includes('b'));
    assert.ok(ids.includes('c'));
    assert.ok(!ids.includes('a'));
});

test('generateCandidates sorts by priority descending', () => {
    // With the same area, areaScore = 0.6 for all candidates.
    // Priority differentiation comes from zHeight: lower zHeight → higher zScore → higher priority.
    const islands = [
        makeIsland({
            id: 'x',
            baseZ: 2,
            contact: new THREE.Vector3(0, 0, 2),
            areaMm2: 0.1,
        }),
        makeIsland({
            id: 'y',
            baseZ: 8,
            contact: new THREE.Vector3(0, 0, 8),
            areaMm2: 0.1,
        }),
        makeIsland({
            id: 'z',
            baseZ: 5,
            contact: new THREE.Vector3(0, 0, 5),
            areaMm2: 0.1,
        }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 3);
    const ids = candidates.map((c) => c.id);
    // x (z=2, priority=0.825) → z (z=5, priority=0.7125) → y (z=8, priority=0.6)
    assert.deepStrictEqual(ids, ['x', 'z', 'y']);
});

test('deduplicateCandidates removes candidates within tipInfluenceRadiusMm', () => {
    // 3 candidates: 2 at the same position, 1 far away.
    const candidates: CandidatePoint[] = [
        {
            id: 'a',
            tipPos: { x: 0, y: 0, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            priority: 0.9,
        },
        {
            id: 'b',
            tipPos: { x: 0, y: 0, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            priority: 0.7,
        },
        {
            id: 'c',
            tipPos: { x: 5, y: 5, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            priority: 0.5,
        },
    ];
    const settings = {
        ...createDefaultAutoSupportSettings(),
        tipInfluenceRadiusMm: 2.0,
    };
    const deduped = deduplicateCandidates(candidates, settings);

    assert.equal(deduped.length, 2);
    const ids = deduped.map((c) => c.id);
    assert.ok(ids.includes('a'), 'higher-priority candidate at overlapping position kept');
    assert.ok(ids.includes('c'), 'far-away candidate kept');
    assert.ok(!ids.includes('b'), 'lower-priority candidate at same position removed');
});

test('deduplicateCandidates keeps vertically stacked overhangs (3D distance)', () => {
    // Two candidates at the same XY but different Z are distinct overhangs
    // (staircase/shelf geometry) and must NOT be deduped into one support.
    const candidates: CandidatePoint[] = [
        {
            id: 'low',
            tipPos: { x: 0, y: 0, z: 10 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 10,
            priority: 0.9,
        },
        {
            id: 'high',
            tipPos: { x: 0, y: 0, z: 20 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 20,
            priority: 0.8,
        },
        {
            id: 'far',
            tipPos: { x: 10, y: 0, z: 10 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 10,
            priority: 0.7,
        },
    ];
    const settings = {
        ...createDefaultAutoSupportSettings(),
        tipInfluenceRadiusMm: 2.0,
    };
    const deduped = deduplicateCandidates(candidates, settings);

    assert.equal(deduped.length, 3);
    const ids = deduped.map((c) => c.id);
    assert.ok(ids.includes('low'), 'lower stacked overhang kept');
    assert.ok(ids.includes('high'), 'higher stacked overhang kept (old XY-only dedup dropped it)');
    assert.ok(ids.includes('far'), 'distant candidate kept');
});

test('candidateFromIsland maps all fields correctly', () => {
    const contact = new THREE.Vector3(12, 34, 56);
    const island = makeIsland({
        id: 'island-1',
        source: 'voxel',
        contact,
        baseZ: 56,
        areaMm2: 2.5,
    });

    const candidate = candidateFromIsland(island);

    assert.equal(candidate.id, 'island-1');
    assert.deepStrictEqual(candidate.tipPos, { x: 12, y: 34, z: 56 });
    assert.equal(candidate.zHeight, 56);
    assert.equal(candidate.islandAreaMm2, 2.5);
    assert.equal(candidate.source, 'voxel');
    assert.equal(candidate.modelId, '');
    assert.deepStrictEqual(candidate.tipNormal, { x: 0, y: 0, z: -1 });
});

test('candidateFromIsland shrinks tips for small islands', () => {
    const small = candidateFromIsland(makeIsland({ id: 's', areaMm2: 0.05 }));
    assert.equal(small.tipDiameterMm, 0.22, 'sub-0.15mm² island gets the detail tip');
    const big = candidateFromIsland(makeIsland({ id: 'b', areaMm2: 5 }));
    assert.equal(big.tipDiameterMm, undefined, 'larger island takes the band default');
});
test('deduplicateCandidates suppresses close shelves via grown influence', () => {
    // Same XY, 3mm apart in Z with a 0.5mm base radius: the grown gate
    // (0.5 + influence(3) − 3.0 ≈ 1.26) covers the upper candidate, so the
    // lower tip's cone is assumed to cover it — one support, not two.
    // Overhang-lattice pairs only: discrete islands never merge (see below).
    const mk = (id: string, z: number, priority: number): CandidatePoint => ({
        id,
        tipPos: { x: 0, y: 0, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: '',
        source: 'overhang',
        islandAreaMm2: 0.1,
        zHeight: z,
        priority,
    });
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.5 };
    const deduped = deduplicateCandidates(
        [mk('low', 10, 0.9), mk('high', 13, 0.8)], settings);
    assert.equal(deduped.length, 1, 'close shelf deduped into the lower support cone');
    assert.equal(deduped[0].id, 'low');
});

test('deduplicateCandidates never merges discrete islands', () => {
    // Same geometry as above but voxel-source: neighboring islands are
    // must-support points and both survive.
    const mk = (id: string, z: number, priority: number): CandidatePoint => ({
        id,
        tipPos: { x: 0, y: 0, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: '',
        source: 'voxel',
        islandAreaMm2: 0.1,
        zHeight: z,
        priority,
    });
    const settings = { ...createDefaultAutoSupportSettings(), tipInfluenceRadiusMm: 0.5 };
    const deduped = deduplicateCandidates(
        [mk('low', 10, 0.9), mk('high', 13, 0.8)], settings);
    assert.equal(deduped.length, 2, 'neighboring islands both survive');
});

test('influenceRadiusMm follows the support curve', () => {
    assert.equal(influenceRadiusMm(-5), 3.0, 'below the tip clamps to birth radius');
    assert.equal(influenceRadiusMm(0), 3.0, 'birth radius');
    assert.ok(Math.abs(influenceRadiusMm(3.9) - 4.0) < 1e-9, 'first knot');
    assert.ok(Math.abs(influenceRadiusMm(15) - 5.0) < 1e-9, 'second knot');
    assert.equal(influenceRadiusMm(100), 6.0, 'capped');
    const mid = influenceRadiusMm(7.5);
    assert.ok(mid > 4.0 && mid < 5.0, `interpolates between knots (got ${mid})`);
});

test('candidatesFromIsland centers sub-head specks on the bbox', () => {
    // 0.25×0.25 speck with an off-center contact: the tip snaps to the
    // bbox center, not the noisy contact point.
    const island = {
        ...makeIsland({ id: 'speck', areaMm2: 0.05 }),
        contact: new THREE.Vector3(0.2, 0.1, 30),
        contactVoxels: footprintFromPoints([
            { x: 0, y: 0, z: 30 }, { x: 0.25, y: 0, z: 30 },
            { x: 0, y: 0.25, z: 30 }, { x: 0.25, y: 0.25, z: 30 },
        ]),
    };
    const out = candidatesFromIsland(island);
    assert.equal(out.length, 1, 'one tip for a speck');
    assert.deepStrictEqual(out[0].tipPos, { x: 0.125, y: 0.125, z: 30 });
});

test('candidatesFromIsland splits narrow mid-size islands in two', () => {
    // 4×1 sliver: symmetric pair at the quarter points, each with half
    // the area (sizing tails stay honest).
    const pts = [];
    for (let x = 0; x <= 4; x += 0.25) pts.push({ x, y: 0, z: 30 });
    const island = {
        ...makeIsland({ id: 'sliver', areaMm2: 2 }),
        contact: new THREE.Vector3(2, 0, 30),
        contactVoxels: footprintFromPoints(pts),
    };
    const out = candidatesFromIsland(island);
    assert.equal(out.length, 2, 'sliver gets two tips');
    assert.deepStrictEqual([out[0].id, out[1].id], ['sliver-a', 'sliver-b']);
    assert.deepStrictEqual(out[0].tipPos, { x: 1, y: 0, z: 30 });
    assert.deepStrictEqual(out[1].tipPos, { x: 3, y: 0, z: 30 });
    assert.ok(out.every((c) => c.islandAreaMm2 === 1), 'area split between the pair');
});

test('candidatesFromIsland keeps one candidate for wide blobs', () => {
    // 4×4 blob: too wide for the pair rule — the grid path covers it.
    const pts = [];
    for (let x = 0; x <= 4; x += 0.5) {
        for (let y = 0; y <= 4; y += 0.5) pts.push({ x, y, z: 30 });
    }
    const island = {
        ...makeIsland({ id: 'blob', areaMm2: 16 }),
        contact: new THREE.Vector3(2, 2, 30),
        contactVoxels: footprintFromPoints(pts),
    };
    const out = candidatesFromIsland(island);
    assert.equal(out.length, 1, 'wide blob keeps a single candidate');
    assert.deepStrictEqual(out[0].tipPos, { x: 2, y: 2, z: 30 });
});

test('generateCandidates refuses contacts painted as support blockers', async () => {
    const { setSupportBlockedTriangles, deleteSupportBlockers } =
        await import('../autoSupport/supportBlockers');
    const modelId = 'prune-wiring';
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.updateMatrixWorld();
    // Bottom-face contact in world mm.
    const islands = [makeIsland({ id: 'sole', contact: new THREE.Vector3(0, 0, -5), baseZ: -5, areaMm2: 100 })];
    const settings = createDefaultAutoSupportSettings();
    const unpainted = generateCandidates(islands, settings, { mesh, modelId });
    assert.equal(unpainted.length, 1, 'unpainted contact survives');
    // Block the contact face the upward ray resolves.
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, -7), new THREE.Vector3(0, 0, 1));
    const face = ray.intersectObject(mesh, false)[0]?.faceIndex;
    if (face == null) throw new Error('expected a bottom contact face');
    setSupportBlockedTriangles(modelId, [face]);
    try {
        const pruned = generateCandidates(islands, settings, { mesh, modelId });
        assert.equal(pruned.length, 0, 'blocked contact is refused');
    } finally {
        deleteSupportBlockers(modelId);
    }
});
