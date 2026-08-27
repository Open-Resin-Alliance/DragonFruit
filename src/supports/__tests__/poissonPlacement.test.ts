import { footprintFromPoints, footprintToPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { generatePoissonCandidates, computeRegionFlatnessDeg } from '../autoSupport/poissonPlacement';
import { erodeFootprint } from '../autoSupport/gridPlacement';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Helpers (mirror gridPlacement.test.ts fixtures)
// ---------------------------------------------------------------------------

function rectRegion(
    id: string,
    minX: number, maxX: number, minY: number, maxY: number,
    areaMm2: number,
    baseZ = 6.5,
    angleDeg = 0,
): DetectedIsland {
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = minX; x <= maxX; x += 0.25) {
        for (let y = minY; y <= maxY; y += 0.25) {
            contactVoxels.push({ x, y, z: baseZ });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, baseZ),
        baseZ,
        areaMm2,
        overhangAngleDeg: angleDeg,
        contactVoxels: footprintFromPoints(contactVoxels),
    };
}

/** Ring region: outer 20×20, hole 6×6 in the middle. */
function ringRegion(id: string, areaMm2: number): DetectedIsland {
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            const inHole = Math.abs(x) < 3 && Math.abs(y) < 3;
            if (!inHole) contactVoxels.push({ x, y, z: 6.5 });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2,
        contactVoxels: footprintFromPoints(contactVoxels),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('anchor region below the grid threshold still gets a densified disk', () => {
    // The bare-foot case: a 4×4 mm foot (16 mm²) under the 25 mm² threshold
    // used to get a single support. As an anchor it must be densified.
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    const foot = rectRegion('o0', -2, 2, -2, 2, 16, 6.5, 0);

    const candidates = generatePoissonCandidates(
        [foot], settings,
        new Map([['o0', 0.7]]), new Set(['o0']),
    );

    // 4×4 foot eroded 0.5 mm per side for the contact inset → 3×3 mm ring +
    // infill ≈ 9 points (vs the single support it got before densification).
    assert.ok(candidates.length >= 8,
        `small anchor foot densified (${candidates.length} points)`);
    for (const c of candidates) {
        assert.ok(Math.abs(c.tipPos.x) <= 2.25 && Math.abs(c.tipPos.y) <= 2.25,
            'all points inside the footprint');
        assert.ok(c.gridPoint, 'poisson points are standalone trunks');
    }
});

test('perimeter ring is retained and infill respects the min distance', () => {
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 30, gridAreaThresholdMm2: 25 };
    // areaPerSupport 30, anchor factor owns the density → interior =
    // √30 × 0.7 × poissonSpacingFactor ≈ 3.26 mm; perimeter = interior × 0.8.
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);

    const candidates = generatePoissonCandidates(
        [region], settings,
        new Map([['o0', 0.7]]), new Set(['o0']),
    );

    assert.ok(candidates.some((c) => c.id.startsWith('perim-')), 'perimeter ring present');
    const pts = candidates.map((c) => c.tipPos);
    const isPerim = (i: number) => candidates[i].id.startsWith('perim-');

    // Interior (and perimeter-vs-interior) spacing ≥ interior radius − eps.
    const interior = Math.sqrt(30) * 0.7 * (settings.poissonSpacingFactor ?? 1);
    const interiorSq = interior * interior * 0.9;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            if (isPerim(i) && isPerim(j)) continue;
            const d2 = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
            assert.ok(d2 >= interiorSq,
                `infill spacing ≥ interior radius (d=${Math.sqrt(d2).toFixed(2)} mm)`);
        }
    }
});

test('poissonSpacingFactor tightens the disk independently of the grid', () => {
    const base = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 30, gridAreaThresholdMm2: 25 };
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);

    const loose = generatePoissonCandidates(
        [region], { ...base, poissonSpacingFactor: 1.0 },
        new Map([['o0', 0.7]]), new Set(['o0']),
    );
    const tight = generatePoissonCandidates(
        [region], { ...base, poissonSpacingFactor: 0.6 },
        new Map([['o0', 0.7]]), new Set(['o0']),
    );

    assert.ok(loose.length >= 8, 'loose disk still fills');
    assert.ok(tight.length > loose.length,
        `lower factor densifies (loose=${loose.length}, tight=${tight.length})`);
});

test('deterministic for identical inputs', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);

    const first = generatePoissonCandidates([region], settings, new Map([['o0', 0.7]]), new Set(['o0']));
    const second = generatePoissonCandidates([region], settings, new Map([['o0', 0.7]]), new Set(['o0']));

    assert.equal(first.length, second.length);
    assert.deepEqual(
        first.map((c) => [c.id, c.tipPos.x, c.tipPos.y, c.tipPos.z]),
        second.map((c) => [c.id, c.tipPos.x, c.tipPos.y, c.tipPos.z]),
    );
});

test('respects footprint containment (no points in the hole)', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    const region = ringRegion('o0', 364);

    const candidates = generatePoissonCandidates(
        [region], settings,
        new Map([['o0', 0.7]]), new Set(['o0']),
    );

    assert.ok(candidates.length > 0, 'ring produces points');
    for (const c of candidates) {
        const inHole = Math.abs(c.tipPos.x) < 3 && Math.abs(c.tipPos.y) < 3;
        assert.ok(!inHole, 'no supports inside the 6×6 hole');
    }
});

test('non-anchor regions below the threshold produce nothing', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    const small = rectRegion('o0', -2, 2, -2, 2, 16, 6.5, 0);

    const candidates = generatePoissonCandidates([small], settings, new Map(), new Set());

    assert.equal(candidates.length, 0, 'below threshold and not an anchor → skipped');
});

test('tighter anchor perimeter factor yields a denser ring', () => {
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 30, gridAreaThresholdMm2: 25 };
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);
    const scaleMap = new Map([['o0', 0.7]]);
    const anchorSet = new Set(['o0']);

    const tight = generatePoissonCandidates([region], settings, scaleMap, anchorSet);
    const loose = generatePoissonCandidates([region], { ...settings, anchorPerimeterFactor: 1 }, scaleMap, anchorSet);

    const ringCount = (list: typeof tight) => list.filter((c) => c.id.startsWith('perim-')).length;
    assert.ok(ringCount(tight) > ringCount(loose),
        `0.8× ring denser than 1.0× ring (${ringCount(tight)} > ${ringCount(loose)})`);
});

// ---------------------------------------------------------------------------
// Shape metric (distribution dispatch)
// ---------------------------------------------------------------------------

test('erodeFootprint insets by the contact radius and empties thin regions', () => {
    const rect = rectRegion('o0', -2, 2, -2, 2, 16, 6.5, 0).contactVoxels;
    const eroded = erodeFootprint(rect ? footprintToPoints(rect) : []);

    assert.ok(eroded.length > 0, '4×4 mm foot survives erosion');
    const xs = eroded.map((v) => v.x);
    const ys = eroded.map((v) => v.y);
    assert.ok(Math.min(...xs) >= -1.9 && Math.max(...xs) <= 1.9, 'eroded ~0.5 mm per side');
    assert.ok(Math.min(...ys) >= -1.9 && Math.max(...ys) <= 1.9);

    // A 1-voxel-thin strip erodes to nothing → callers fall back to the raw boundary.
    const strip: Array<{ x: number; y: number; z?: number }> = [];
    for (let x = -4; x <= 4; x += 0.25) strip.push({ x, y: 0, z: 6.5 });
    assert.equal(erodeFootprint(strip).length, 0);
});

test('perimeter ring is inset so the contact disc stays on the surface', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);

    const candidates = generatePoissonCandidates(
        [region], settings,
        new Map([['o0', 0.7]]), new Set(['o0']),
    );
    const ring = candidates.filter((c) => c.id.startsWith('perim-'));

    assert.ok(ring.length > 0, 'ring present');
    for (const c of ring) {
        assert.ok(Math.abs(c.tipPos.x) <= 10 - 0.15 && Math.abs(c.tipPos.y) <= 10 - 0.15,
            `ring point (${c.tipPos.x.toFixed(2)},${c.tipPos.y.toFixed(2)}) inside the footprint`);
    }
});

test('flatness metric: planar region has zero angle spread', () => {
    const flat = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);
    assert.equal(computeRegionFlatnessDeg(flat), 0);
});

test('flatness metric: curved region reads organic (above the threshold)', () => {
    // z = 6.5 + x²/20 → local angle from 0° (center) to 45° (x = ±10).
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            contactVoxels.push({ x, y, z: 6.5 + (x * x) / 20 });
        }
    }
    const curved: DetectedIsland = {
        id: 'c0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const metric = computeRegionFlatnessDeg(curved);
    assert.ok(metric > 12, `curved region organic (${metric.toFixed(1)}° spread)`);
});
