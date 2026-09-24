import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { generateGridCandidates, computeRegionSpacing, GRID_SPACING_FLOOR_MM, MAX_GRID_CANDIDATES_PER_REGION, steepFlatAnchorBandTop, steepFlatSpacingMultiplier, STEEP_FLAT_SPACING_MULTIPLIER, shouldUseDensityGrid } from '../autoSupport/gridPlacement';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Overhang island with a rectangular footprint mask at 0.25 mm spacing. */
function rectRegion(
    id: string,
    minX: number, maxX: number, minY: number, maxY: number,
    areaMm2: number,
    baseZ = 6.5,
    angleDeg = 0,
): DetectedIsland {
    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = minX; x <= maxX; x += 0.25) {
        for (let y = minY; y <= maxY; y += 0.25) {
            contactVoxels.push({ x, y });
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
    const contactVoxels: { x: number; y: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            const inHole = Math.abs(x) < 3 && Math.abs(y) < 3;
            if (!inHole) contactVoxels.push({ x, y });
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

test('grids a large flat region with dynamic spacing (never cut off)', () => {
    // 20×20 flat anchor surface (angle 0°), target density 8 mm²/support →
    // base spacing 2.83, but flat surfaces grid at 0.7× = 1.98 mm. The
    // spacing adjusts per axis to span the region INSET by the contact
    // radius: nx = round(19.5/1.98) = 10 → spacingX = 19.5/10 = 1.95, 11
    // columns from -9.75 to +9.75 — the outer ring sits just inside the
    // boundary so the contact disc never hangs past the edge.
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25, suctionAreaExponent: 0 };
    const candidates = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400)], settings);

    // Lattice 11×11 = 121 + boundary ring at 0.7× spacing tracing the edge
    // between lattice columns (~16 extra points).
    assert.ok(candidates.length >= 125 && candidates.length <= 150,
        `flat grid count ${candidates.length} ≈ 121 lattice + ring`);
    assert.ok(candidates.every((c) => c.gridPoint === true), 'points are standalone trunks');
    assert.ok(candidates.every((c) => c.source === 'overhang'));
    assert.ok(candidates.filter((c) => c.id.startsWith('fill-')).length >= 10,
        'boundary ring traces the outline denser than the lattice');

    // Equal spacing, spanning the full inset span — the far edge is not cut off.
    const xs = [...new Set(candidates.filter((c) => c.id.startsWith('grid-')).map((c) => c.tipPos.x))].sort((a, b) => a - b);
    assert.ok(Math.abs(xs[0] + 9.75) < 1e-9, `grid starts inset from the boundary (x=${xs[0]})`);
    assert.ok(Math.abs(xs[xs.length - 1] - 9.75) < 1e-9, `grid reaches the inset far edge (x=${xs[xs.length - 1]})`);
    const spacingX = xs[1] - xs[0];
    assert.ok(Math.abs(spacingX - 1.95) < 1e-9, `uniform spacing ${spacingX} = 19.5/10`);
    for (let i = 1; i < xs.length; i++) {
        assert.ok(Math.abs((xs[i] - xs[i - 1]) - spacingX) < 1e-9, 'spacing is perfectly uniform');
    }
});

test('flat boost and slope relax knobs modulate the angle density', () => {
    // Flat boost = 1 (no densification) → the flat grid falls back to the
    // plain √areaPerSupport spacing (~8×8 = 64 at 8 mm²), not the 0.7×
    // densified 11×11.
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25, flatDensityBoost: 1, suctionAreaExponent: 0 };
    const flat = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0)], settings);
    assert.ok(flat.length >= 65 && flat.length <= 90,
        `flat boost 1 → plain grid + ring (${flat.length} ≈ 76)`);

    // Default boost (0.7) densifies the flat grid; slope relax relaxes the
    // steep end.
    const defaultSettings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25 };
    const densified = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0)], defaultSettings);
    assert.ok(densified.length > flat.length, 'default flat boost densifies');
});

test('angle-aware density: flat anchor surfaces grid denser than slopes', () => {
    // Same 20×20 region, same density setting — only the surface angle
    // differs. Flat (0°) → spacing 2.83×0.7 ≈ 1.98 → ~11×11.
    // 40° slope → spacing 2.83×1.28 ≈ 3.63 → ~6×6.
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25, suctionAreaExponent: 0 };
    const flat = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0)], settings);
    const slope = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 40)], settings);

    assert.ok(flat.length > slope.length,
        `flat (${flat.length}) denser than 40° slope (${slope.length})`);
    assert.ok(flat.length >= 125, `flat grids densified (${flat.length})`);
    assert.ok(slope.length <= 70, `steep slope grids sparser (${slope.length})`);
});

test('skips regions below the grid area threshold', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25 };
    // A compact patch: 3 × 3 mm, under the gate and shorter than the two-point
    // band, so it keeps the single-candidate path. (Longer footprints go to
    // the grid path on shape — see the rib test below.)
    const candidates = generateGridCandidates([rectRegion('o0', -1.5, 1.5, -1.5, 1.5, 9)], settings);
    assert.equal(candidates.length, 0, 'small region gets a single support, not a grid');
});

test('respects footprint containment (no supports in the hole)', () => {
    // Ring region: grid points inside the 6×6 hole must be excluded.
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25 };
    const candidates = generateGridCandidates([ringRegion('o0', 364)], settings);

    assert.ok(candidates.length > 0, 'ring produces grid points');
    for (const c of candidates) {
        // Hole is 6×6 centered; grid points must stay out of the inner core
        // (≥0.5 mm from the ring's edge pixels given the mask tolerance).
        assert.ok(Math.abs(c.tipPos.x) >= 2.5 || Math.abs(c.tipPos.y) >= 2.5,
            `no support in the hole core: (${c.tipPos.x.toFixed(1)}, ${c.tipPos.y.toFixed(1)})`);
    }
});

test('uses the region surface Z at each grid point (sloped facet)', () => {
    // A 45°-sloped facet: the surface Z at a grid point must come from the
    // region's own footprint voxels, not a whole-mesh raycast (which hits the
    // wrong face on slopes). Voxels carry their true Z.
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            contactVoxels.push({ x, y, z: 6.5 + (y + 10) * 0.7 }); // slope
        }
    }
    const sloped: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(contactVoxels),
    };

    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25 };
    const candidates = generateGridCandidates([sloped], settings);

    assert.ok(candidates.length > 0);
    for (const c of candidates) {
        // At y = -10 the slope Z is 6.5; at y = 10 it is 20.5.
        const expected = 6.5 + (c.tipPos.y + 10) * 0.7;
        assert.ok(Math.abs(c.tipPos.z - expected) < 0.3,
            `tip z ${c.tipPos.z.toFixed(2)} ≈ slope z ${expected.toFixed(2)} at y=${c.tipPos.y.toFixed(1)}`);
    }
});

test('falls back to region baseZ when voxels carry no Z', () => {
    const settings = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, gridAreaThresholdMm2: 25 };
    const candidates = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5)], settings);
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((c) => Math.abs(c.tipPos.z - 6.5) < 1e-6));
});

test('grid outer ring is inset by the contact radius', () => {
    const settings = { ...createDefaultAutoSupportSettings(), gridAreaThresholdMm2: 25, suctionAreaExponent: 0 };
    const candidates = generateGridCandidates([rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0)], settings);

    assert.ok(candidates.length > 0);
    const minX = Math.min(...candidates.map((c) => c.tipPos.x));
    const maxX = Math.max(...candidates.map((c) => c.tipPos.x));
    assert.ok(minX >= -10 + 0.2 && maxX <= 10 - 0.2,
        `outer ring inset (x ∈ [${minX.toFixed(2)}, ${maxX.toFixed(2)}])`);
});

// ---------------------------------------------------------------------------
// Suction scaling + floors
// ---------------------------------------------------------------------------

test('suction scaling densifies large shallow ceilings', () => {
    const settings = {
        ...createDefaultAutoSupportSettings(),
        areaPerSupportMm2: 8,
        gridAreaThresholdMm2: 25,
    };
    const region = rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0);

    const noSuction = generateGridCandidates([region], { ...settings, suctionAreaExponent: 0 });
    const withSuction = generateGridCandidates([region], settings);

    assert.ok(withSuction.length > noSuction.length,
        `large flat denser with suction scaling (${withSuction.length} > ${noSuction.length})`);

    // The spacing formula itself: 400 mm² strictly denser than 25 mm² at the
    // same angle (density grows with projected area).
    const smallSpacing = computeRegionSpacing(rectRegion('o1', -2.5, 2.5, -2.5, 2.5, 25, 6.5, 0), settings);
    const bigSpacing = computeRegionSpacing(region, settings);
    assert.ok(bigSpacing < smallSpacing,
        `400 mm² (${bigSpacing.toFixed(2)} mm) denser than 25 mm² (${smallSpacing.toFixed(2)} mm)`);
});

test('spacing never falls below the floor', () => {
    const settings = {
        ...createDefaultAutoSupportSettings(),
        areaPerSupportMm2: 1,
        flatDensityBoost: 0.5,
        slopeRelaxFactor: 1,
        suctionAreaExponent: 0.4,
    };
    const spacing = computeRegionSpacing(rectRegion('o0', -10, 10, -10, 10, 400, 6.5, 0), settings);
    assert.equal(spacing, GRID_SPACING_FLOOR_MM);
});

test('per-region candidate count is capped (densification never exceeds the cap)', () => {
    const settings = {
        ...createDefaultAutoSupportSettings(),
        areaPerSupportMm2: 1,
        flatDensityBoost: 0.5,
        slopeRelaxFactor: 1,
        suctionAreaExponent: 0.4,
    };
    // 40×40 mm at the 1.2 mm floor would be ~35×35 ≈ 1248 lattice points —
    // the cap must pull it back to the base grid and subsample.
    const candidates = generateGridCandidates(
        [rectRegion('o0', -20, 20, -20, 20, 1600, 6.5, 0)],
        settings,
    );

    assert.ok(candidates.length > 0, 'region still produces candidates');
    assert.ok(candidates.length <= MAX_GRID_CANDIDATES_PER_REGION,
        `capped (${candidates.length} ≤ ${MAX_GRID_CANDIDATES_PER_REGION})`);
});

/**
 * A thin rib under the area threshold used to take the single-candidate path:
 * one pillar at its centre, both ends of the anchoring edge unsupported. Shape
 * (longer than the two-point band) now decides, not area alone.
 */
test('a long thin rib under the area threshold gets its edge supported', () => {
    const settings = createDefaultAutoSupportSettings();
    const plank = rectRegion('p0', -7.5, 7.5, -0.65, 0.65, 19.5); // 15 × 1.3 mm

    assert.ok((plank.areaMm2 ?? 0) < settings.gridAreaThresholdMm2, 'fixture sits under the area gate');
    assert.equal(shouldUseDensityGrid(plank, settings), true, 'shape, not area, decides');

    const candidates = generateGridCandidates([plank], settings);
    const xs = candidates.map((c) => c.tipPos.x);
    assert.ok(candidates.length >= 5, `an edge line, not one pillar (${candidates.length})`);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 10,
        `supports span the rib (${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}mm)`);

    // ...and a compact patch stays on the single-candidate path.
    const patch = rectRegion('p1', -2, 2, -2, 2, 16);
    assert.equal(shouldUseDensityGrid(patch, settings), false, 'small patches keep the pillar path');
});

/**
 * A steep flat forms fine on its own, so the density curve — tuned for
 * formation, densest on flat ceilings — overstates what it needs. It still gets
 * a field of contacts (a huge face left bare overhangs its own weight), just a
 * sparse one: the multiplier is the difference between a carpet and a brace
 * field on a low-poly model, where the patch IS the whole face.
 */
test('a steep flat is covered sparsely, not carpeted', () => {
    const settings = createDefaultAutoSupportSettings();
    const face = { ...rectRegion('s0', -20, 20, -20, 20, 100), steepFlat: true };
    const formation = { ...rectRegion('s1', -20, 20, -20, 20, 100), steepFlat: false };

    assert.equal(shouldUseDensityGrid(face, settings), true, 'a big steep face still needs coverage');
    const sparse = generateGridCandidates([face], settings);
    const dense = generateGridCandidates([formation], settings);
    assert.ok(sparse.length > 0, 'not left bare');
    assert.ok(
        sparse.length * 4 < dense.length,
        `much sparser than a formation overhang (${sparse.length} vs ${dense.length})`,
    );
    assert.ok(
        sparse.length >= dense.length / (STEEP_FLAT_SPACING_MULTIPLIER ** 2) - 2,
        `and sparser by about the squared multiplier (${sparse.length} vs ${dense.length})`,
    );
});

/**
 * A region carries ONE surface normal, but its cells land on a surface that
 * curves or bends underneath it. Measured on a cylinder underside, every
 * contact's axis sat a median 26° (worst 41°) from the surface it touched, so
 * the contact disc dug in on one edge and floated off the other.
 */
test('each grid contact takes the normal of the face it lands on', () => {
    const settings = createDefaultAutoSupportSettings();
    // Dome-ish underside: a strip of two facets meeting along y = 0, so the
    // local normal differs cell to cell while the region normal stays -Z.
    const geometry = new THREE.BufferGeometry();
    const positions = [
        // left facet, sloping up towards y = 0
        -5, -5, 0, 5, -5, 0, 5, 0, 1.5,
        -5, -5, 0, 5, 0, 1.5, -5, 0, 1.5,
        // right facet, sloping back down
        -5, 0, 1.5, 5, 0, 1.5, 5, 5, 0,
        -5, 0, 1.5, 5, 5, 0, -5, 5, 0,
    ];
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);

    const voxels: { x: number; y: number; z: number }[] = [];
    for (let x = -4; x <= 4; x += 0.25) {
        for (let y = -4; y <= 4; y += 0.25) {
            voxels.push({ x, y, z: (Math.abs(y) > 0 ? 1.5 * (1 - Math.abs(y) / 5) : 1.5) });
        }
    }
    const island: DetectedIsland = {
        ...rectRegion('o9', -4, 4, -4, 4, 64, 0),
        baseZ: -2,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        triangleIds: [0, 1, 2, 3],
        contactVoxels: footprintFromPoints(voxels),
    };

    const candidates = generateGridCandidates([island], settings, mesh, 'm');
    assert.ok(candidates.length > 5, `region gridded (${candidates.length})`);
    const tilted = candidates.filter((c) => Math.abs(c.tipNormal.z) < 0.99);
    assert.ok(tilted.length > 0,
        'cells on the sloped facets lean with the facet, not with the region');
    assert.ok(candidates.every((c) => Math.abs(Math.hypot(c.tipNormal.x, c.tipNormal.y, c.tipNormal.z) - 1) < 1e-6),
        'every emitted normal is a unit vector');
});

/**
 * A steep flat is self-supporting, so its contacts anchor the part rather than
 * hold up forming material, and anchoring wants the low band: short, stiff,
 * cheap. Left alone the grid climbs the face, because a near-vertical patch has
 * a thin XY footprint whose cells map up its height.
 */
test('a steep flat is anchored low, a formation overhang is not banded', () => {
    // The tool's face: 50mm tall, so the band is the lowest 17.5mm of it.
    assert.equal(steepFlatAnchorBandTop({ steepFlat: true, baseZ: 5, maxZ: 55 }), 22.5);
    // A 20mm cube's face: a third of its 19.9mm is under the 6mm floor, so the
    // band lands near 12mm, i.e. contacts in the bottom half rather than two
    // thirds of the way up a part that is nearly finished.
    const shortFace = steepFlatAnchorBandTop({ steepFlat: true, baseZ: 5, maxZ: 24.9 });
    assert.ok(shortFace < 12.5, `short face band is low (got ${shortFace.toFixed(2)})`);
    // Formation coverage has to hold material at height, so it is unbounded.
    assert.equal(steepFlatAnchorBandTop({ steepFlat: false, baseZ: 5, maxZ: 55 }), Infinity);
    // A flat with no recorded top still gets the floor rather than nothing.
    assert.equal(steepFlatAnchorBandTop({ steepFlat: true, baseZ: 5 }), 11);
});

test('a slender part gets its steep flats at formation density', () => {
    // The 505k-triangle wall: 126mm tall, 11mm thick. Its problem is sway, and
    // the sag between contacts goes as the span to the fourth power, so the
    // spacing is the knob. A squat part keeps the sparse field.
    const face = { steepFlat: true };
    assert.equal(steepFlatSpacingMultiplier(face, false), STEEP_FLAT_SPACING_MULTIPLIER);
    assert.equal(steepFlatSpacingMultiplier(face, true), 1, 'a wall gets formation density');
    // Formation overhangs are unaffected either way.
    assert.equal(steepFlatSpacingMultiplier({ steepFlat: false }, false), 1);
    assert.equal(steepFlatSpacingMultiplier({ steepFlat: false }, true), 1);
});
