import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import {
    extractRepresentativeLayers,
    optimizeContactsByTraction,
    referenceStefanMeanPressureMm2,
    sampleStefanPressure,
    solveStefanFieldFromSegments,
    stefanTractionFactorAt,
    tractionMultiplierAtZ,
} from '../autoSupport/tractionOptimization';
import type { CandidatePoint } from '../autoSupport/types';

function makeSteppedTBlockMesh(): THREE.Mesh {
    // Narrow lower stem (4 × 4 × 10 mm, area 16 mm²) at Z = 0..10
    // + wide upper cap (16 × 16 × 10 mm, area 256 mm²) at Z = 10..20.
    const stem = new THREE.BoxGeometry(4, 4, 10).translate(0, 0, 5).toNonIndexed();
    const cap = new THREE.BoxGeometry(16, 16, 10).translate(0, 0, 15).toNonIndexed();
    const merged = mergeGeometries([stem, cap]);
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

function makeRectOverhang(id: string, halfX: number, halfY: number, z: number, angleDeg = 0): DetectedIsland {
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -halfX; x <= halfX; x += 0.25) {
        for (let y = -halfY; y <= halfY; y += 0.25) {
            pts.push({ x, y, z });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, z),
        baseZ: z,
        maxZ: z,
        areaMm2: (halfX * 2) * (halfY * 2),
        overhangAngleDeg: angleDeg,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(pts),
    };
}

function makeCandidate(id: string, x: number, y: number, z: number, overrides: Partial<CandidatePoint> = {}): CandidatePoint {
    return {
        id,
        tipPos: { x, y, z },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'overhang',
        islandAreaMm2: 10,
        zHeight: z,
        priority: 0.5,
        gridPoint: true,
        ...overrides,
    };
}

test('extractRepresentativeLayers clusters coherent slices and detects sudden cross-section area jump', () => {
    const mesh = makeSteppedTBlockMesh();
    const profile = extractRepresentativeLayers(mesh, 40);

    // 40 sampled slices across a 2-tier T-block should collapse into very few
    // representative layers (2–4 clusters instead of 40 redundant slices).
    assert.ok(profile.layers.length >= 2 && profile.layers.length <= 6,
        `coherent slices collapsed into ${profile.layers.length} representative layers`);
    assert.ok(Math.abs(profile.peakAreaMm2 - 256) < 12,
        `peak cross-section area matches 16×16 cap (~256 mm², got ${profile.peakAreaMm2.toFixed(1)})`);

    const capLayer = profile.layers.find((l) => l.zMm >= 10.0 && l.areaMm2 > 200);
    assert.ok(capLayer, 'upper cap representative layer detected');
    assert.ok((capLayer?.areaJumpRatio ?? 0) > 5,
        `T-block jump ratio reflects 16→256 mm² expansion (got ${capLayer?.areaJumpRatio.toFixed(2)})`);

    // Traction multiplier spikes right at the Z=10 overhang below the 256 mm² cap
    // and stays low on the narrow 16 mm² stem base.
    const mulAtJump = tractionMultiplierAtZ(profile, 10.0);
    const mulAtStem = tractionMultiplierAtZ(profile, 2.0);
    assert.ok(mulAtJump > 1.25, `peel traction multiplier spikes at T-block jump (${mulAtJump.toFixed(2)})`);
    assert.ok(mulAtJump > mulAtStem, `jump multiplier (${mulAtJump.toFixed(2)}) exceeds narrow stem (${mulAtStem.toFixed(2)})`);
});

test('optimizeContactsByTraction adds contacts at overloaded Voronoi cells on high-peel flats', () => {
    const mesh = makeSteppedTBlockMesh();
    const settings = createDefaultAutoSupportSettings();
    const overhang = makeRectOverhang('cap-bottom', 6, 6, 10, 0);

    // Start with only 2 sparse contacts on a 12×12 mm (144 mm²) flat ceiling
    // right under the 256 mm² peel jump — severely under-supported.
    const initial: CandidatePoint[] = [
        makeCandidate('fill-cap-bottom-0', -5, -5, 10),
        makeCandidate('fill-cap-bottom-1', 5, 5, 10),
    ];

    const out = optimizeContactsByTraction(initial, [overhang], settings, mesh, 'm');
    assert.ok(out.stats.added >= 4,
        `Voronoi deficit pass inserts reinforcement tips across bare corners (added ${out.stats.added})`);
    assert.equal(out.stats.pruned, 0, 'perimeter fill- points are never pruned');
    assert.ok(out.candidates.some((c) => c.tipPos.x < -2 && c.tipPos.y > 2),
        'added reinforcement reaches bare (-x, +y) corner');
    assert.ok(out.candidates.some((c) => c.tipPos.x > 2 && c.tipPos.y < -2),
        'added reinforcement reaches bare (+x, -y) corner');
});

test('optimizeContactsByTraction conservatively prunes redundant interior grid points while protecting corners and discrete islands', () => {
    const settings = createDefaultAutoSupportSettings();
    const region = makeRectOverhang('slope-patch', 2.2, 2.2, 20, 35); // 4.4×4.4 mm steep slope (3mm bridge radius)

    // Over-dense interior grid points + protected perimeter corners + protected discrete minima.
    const initial: CandidatePoint[] = [
        makeCandidate('fill-slope-patch-0', -2.2, -2.2, 20),
        makeCandidate('fill-slope-patch-1', 2.2, -2.2, 20),
        makeCandidate('fill-slope-patch-2', 2.2, 2.2, 20),
        makeCandidate('fill-slope-patch-3', -2.2, 2.2, 20),
        makeCandidate('m0', 0, 0, 20, { source: 'minima', gridPoint: false }),
        // 4 tightly clustered interior grid- points right around the center minima.
        makeCandidate('grid-slope-patch-0', -0.75, 0, 20),
        makeCandidate('grid-slope-patch-1', 0.75, 0, 20),
        makeCandidate('grid-slope-patch-2', 0, -0.75, 20),
        makeCandidate('grid-slope-patch-3', 0, 0.75, 20),
    ];

    const out = optimizeContactsByTraction(initial, [region], settings, undefined, 'm');
    assert.ok(out.stats.pruned >= 2, `redundant interior grid- points pruned (pruned ${out.stats.pruned})`);

    const ids = new Set(out.candidates.map((c) => c.id));
    assert.ok(ids.has('m0'), 'primary discrete minima island is never pruned');
    for (let i = 0; i < 4; i++) {
        assert.ok(ids.has(`fill-slope-patch-${i}`), `perimeter corner fill-slope-patch-${i} is never pruned`);
    }
});

test('Pass C: global cross-region Voronoi pruner collapses crammed snout overhang fragments while protecting minima and near-base soles', () => {
    const settings = createDefaultAutoSupportSettings();
    // Simulate the 4 mm Dragonborn snout/jaw cluster: 1 primary minima (m80) plus
    // 10 crammed micro-overhang fragments & tight perimeter points at ~30° slope
    // carrying ~0.2 mm² each, plus a protected nearBase foot-sole contact pair.
    const snoutNormal = { x: 0, y: 0.5, z: -0.866 }; // 30° underside
    const initial: CandidatePoint[] = [
        makeCandidate('m80', 0, 0, 26.5, { source: 'minima', gridPoint: false, islandAreaMm2: 0.1, tipNormal: snoutNormal }),
        makeCandidate('o279-b', 0.9, 0.3, 26.8, { gridPoint: false, islandAreaMm2: 0.22, tipNormal: snoutNormal }),
        makeCandidate('o280-a', -0.8, 0.5, 26.9, { gridPoint: false, islandAreaMm2: 0.18, tipNormal: snoutNormal }),
        makeCandidate('o280-b', 0.4, -0.9, 27.0, { gridPoint: false, islandAreaMm2: 0.20, tipNormal: snoutNormal }),
        makeCandidate('o283-a', 1.2, -0.4, 27.1, { gridPoint: false, islandAreaMm2: 0.15, tipNormal: snoutNormal }),
        makeCandidate('o284', -1.1, -0.5, 27.2, { gridPoint: false, islandAreaMm2: 0.25, tipNormal: snoutNormal }),
        makeCandidate('fill-o273-0', 0.2, 1.1, 27.3, { gridPoint: true, islandAreaMm2: 1.0, tipNormal: snoutNormal }),
        makeCandidate('fill-o273-1', -0.5, 1.3, 27.4, { gridPoint: true, islandAreaMm2: 1.0, tipNormal: snoutNormal }),
        // Farther jaw edge 3.5 mm away — outside bridge reach, must survive.
        makeCandidate('o287', 3.5, 0, 27.0, { gridPoint: false, islandAreaMm2: 0.30, tipNormal: snoutNormal }),
        // Protected nearBase flat foot sole contacts 1.1 mm apart — must NEVER be pruned.
        makeCandidate('fill-sole-0', 0, 0, 5.0, { gridPoint: true, nearBase: true, islandAreaMm2: 1.0 }),
        makeCandidate('fill-sole-1', 1.1, 0, 5.0, { gridPoint: true, nearBase: true, islandAreaMm2: 1.0 }),
    ];

    const out = optimizeContactsByTraction(initial, [], settings, undefined, 'm');
    assert.ok(out.stats.pruned >= 5,
        `crammed snout micro-fragments collapsed cleanly (pruned ${out.stats.pruned})`);

    const ids = new Set(out.candidates.map((c) => c.id));
    assert.ok(ids.has('m80'), 'primary snout minima is always preserved');
    assert.ok(ids.has('o287'), 'jaw contact outside bridge reach survives');
    assert.ok(ids.has('fill-sole-0') && ids.has('fill-sole-1'), 'nearBase foot sole contacts are never pruned');
    // Snout cluster (9 points -> <= 4 survivors) stays sparse and clean.
    const snoutSurvivors = out.candidates.filter((c) => c.tipPos.z > 20);
    assert.ok(snoutSurvivors.length <= 4,
        `snout cluster collapsed from 9 contacts to ${snoutSurvivors.length}`);
});

test('Screened Stefan PDE: equal-area solid block has much higher suction than thin blade, center > edge, and protects lower anchors', () => {
    // 1. Exact analytical Bessel reference: small disc approaches R^2 / 8.
    const smallRef = referenceStefanMeanPressureMm2(1.0);
    const smallRigidStefan = (1.0 / Math.PI) / 8;
    assert.ok(Math.abs(smallRef - smallRigidStefan) / smallRigidStefan < 0.05,
        `small-disc reference (${smallRef.toFixed(4)}) matches rigid Stefan R²/8 (${smallRigidStefan.toFixed(4)})`);

    // 2. Compare two shapes of identical cross-sectional area (100 mm²):
    //    - Solid 10 × 10 mm square
    //    - Thin 2 × 50 mm blade/rib
    const rectSegments = (w: number, h: number): number[] => {
        const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
        return [
            x0, y0, x1, y0,
            x1, y0, x1, y1,
            x1, y1, x0, y1,
            x0, y1, x0, y0,
        ];
    };
    const solidField = solveStefanFieldFromSegments(rectSegments(10, 10));
    const bladeField = solveStefanFieldFromSegments(rectSegments(2, 50));
    assert.ok(solidField && bladeField, 'both Stefan pressure fields solved');
    if (solidField && bladeField) {
        assert.ok(
            solidField.meanPressureMm2 > bladeField.meanPressureMm2 * 4,
            `solid 10×10 mean suction (${solidField.meanPressureMm2.toFixed(3)}) >> thin 2×50 blade (${bladeField.meanPressureMm2.toFixed(3)})`,
        );
        const centerP = sampleStefanPressure(solidField, 0, 0);
        const cornerP = sampleStefanPressure(solidField, 4.4, 4.4);
        assert.ok(
            centerP > cornerP * 2,
            `interior Stefan pressure (${centerP.toFixed(3)}) > corner pressure (${cornerP.toFixed(3)})`,
        );
    }

    // 3. Spatially varying traction on a stepped T-block: center of the 16×16 upper cap
    //    demands more traction than its outer corner rim, and downward load protection
    //    keeps lower stem overhang contacts from being pruned away.
    const mesh = makeSteppedTBlockMesh();
    const profile = extractRepresentativeLayers(mesh, 20);
    const centerTau = stefanTractionFactorAt(profile, 0, 0, 10.0, 10.0);
    const rimTau = stefanTractionFactorAt(profile, 7.6, 7.6, 10.0, 10.0);
    assert.ok(centerTau > rimTau, `cap center traction (${centerTau.toFixed(2)}) > outer corner (${rimTau.toFixed(2)})`);
    assert.ok(centerTau > 1.25, `broad 16×16 cap center develops elevated peel traction (${centerTau.toFixed(2)})`);
});

test('the sampled planes follow the print profile layer height', () => {
    const mesh = makeSteppedTBlockMesh();
    const profile = extractRepresentativeLayers(mesh, undefined, { layerHeightMm: 0.05 });
    assert.ok(profile.samples, 'samples are emitted alongside the clustered layers');
    // 20 mm tall block at 50 µm → 400 planes (span excludes the 0.25 mm end margin).
    assert.ok(profile.samples.length >= 380 && profile.samples.length <= 400,
        `sampled ${profile.samples.length} planes at 0.05 mm`);
    const first = profile.samples[0];
    const second = profile.samples[1];
    assert.ok(Math.abs((second.zMm - first.zMm) - (profile.samples[profile.samples.length - 1].zMm - profile.samples[profile.samples.length - 2].zMm)) < 1e-6,
        'uniform layer step');
    assert.ok(second.zMm - first.zMm < 0.06, `step ${second.zMm - first.zMm} mm is layer-height scale`);
    assert.ok(profile.layers.length <= 6, 'clustering still emits only the PDE representatives');
});

test('consecutive layers retain the added plan cells where the cross-section grows', () => {
    const mesh = makeSteppedTBlockMesh();
    const profile = extractRepresentativeLayers(mesh, undefined, { layerHeightMm: 0.05 });
    const grid = profile.growthGrid;
    assert.ok(grid, 'a growing part gets a growth grid');
    assert.equal(grid.cellMm, 0.5);
    assert.ok(profile.growth && profile.growth.length === 1,
        `one growth layer at the stem→cap jump (got ${profile.growth?.length ?? 0})`);

    const jump = profile.growth![0];
    assert.ok(Math.abs(jump.zMm - 10) < 0.2, `growth at the cap underside (z=${jump.zMm})`);
    assert.ok(Math.abs(jump.addedAreaMm2 - 240) < 20, `added area ~240 mm² (got ${jump.addedAreaMm2.toFixed(1)})`);
    assert.ok(jump.growthRatio > 10, `area jump ratio reflects 16→256 (got ${jump.growthRatio.toFixed(1)})`);

    // The added cells are the cap ring around the stem: same footprint as the
    // 240 mm² difference, none of it inside the 4×4 stem.
    const cellArea = grid.cellMm * grid.cellMm;
    assert.ok(Math.abs(jump.addedCells.length * cellArea - jump.addedAreaMm2) < 24,
        `${jump.addedCells.length} cells ≈ ${jump.addedAreaMm2.toFixed(1)} mm²`);
    let insideStem = 0;
    for (const cell of jump.addedCells) {
        const ix = cell % grid.nx;
        const iy = Math.floor(cell / grid.nx);
        const x = Math.abs(grid.minX + (ix + 0.5) * grid.cellMm);
        const y = Math.abs(grid.minY + (iy + 0.5) * grid.cellMm);
        if (Math.max(x, y) < 2) insideStem++;
    }
    assert.equal(insideStem, 0, 'no added cell inside the 4×4 stem footprint');
});

test('the traction profile samples at the print layer height when the run provides it', () => {
    const mesh = makeSteppedTBlockMesh();
    const region = makeRectOverhang('o1', 5, 5, 10);
    const candidate = makeCandidate('c1', 0, 0, 10);
    const result = optimizeContactsByTraction(
        [candidate],
        [region],
        createDefaultAutoSupportSettings(),
        mesh,
        'm',
        { layerHeightMm: 0.05 },
    );
    const samples = result.profile.samples;
    assert.ok(samples && samples.length > 300,
        `expected ~400 planes at 50 µm, got ${samples?.length ?? 0}`);
});
