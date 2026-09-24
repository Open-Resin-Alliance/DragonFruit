import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONSERVATIVE_P_SIGMA,
    isStaticallyUnstable,
    measurePoseStability,
    needsToppleCoverage,
} from '../autoSupport/poseStability';

/** 10 mm cube with outward winding, centred on the origin — the same fixture
 *  the Rust report's tests use, so both sides are pinned to one ground truth. */
function cube(): { positions: number[]; index: number[] } {
    const s = 5;
    return {
        positions: [
            -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
            -s, -s, s, s, -s, s, s, s, s, -s, s, s,
        ],
        index: [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6,
            1, 6, 5,
        ],
    };
}

const DEG = Math.PI / 180;

test('a face-down cube reads the same shape the Rust report does', () => {
    const m = cube();
    const s = measurePoseStability(m.positions, m.index, 0, 0);
    // Same numbers as `flat_base_cube_has_no_drag_and_no_margin_limit` and the
    // loader probe: the bearing patch is the whole 10×10 base, the mass sits
    // 5mm inside every edge, and nothing leans.
    assert.equal(s.volumeMm3, 1000);
    assert.equal(s.bearingAreaMm2, 100);
    assert.equal(s.bearingEdges, 4);
    assert.ok(Math.abs(s.centroidDepthMm - 5) < 1e-9, `depth ${s.centroidDepthMm}`);
    assert.ok(Math.abs(s.contactDepthMm - 5) < 1e-9, `contact ${s.contactDepthMm}`);
    assert.equal(s.dragMomentMm3, 0);
    assert.equal(s.marginMm, Infinity);
    assert.equal(isStaticallyUnstable(s), false);
});

test('a cube on an edge has no bearing polygon and cannot stand', () => {
    const m = cube();
    // 45° about X: the 2mm band holds only the two vertices of the resting
    // edge, and two collinear points are not a polygon.
    const s = measurePoseStability(m.positions, m.index, 45 * DEG, 0);
    assert.equal(s.bearingEdges, 0, 'an edge contact is not a polygon');
    assert.equal(s.bearingAreaMm2, 0);
    assert.equal(s.marginMm, 0);
    assert.equal(isStaticallyUnstable(s), true);
});

test('a slightly leaning cube keeps its base and gains a finite margin', () => {
    const m = cube();
    // 5° off the base: the whole base still sits inside the 2mm band, and the
    // two faces that now face down carry drag — so the margin turns finite.
    const s = measurePoseStability(m.positions, m.index, 5 * DEG, 0);
    assert.equal(s.bearingEdges, 4);
    assert.ok(s.bearingAreaMm2 > 90, `bearing ${s.bearingAreaMm2}`);
    assert.ok(s.dragMomentMm3 > 0, 'the leaning faces drag');
    assert.ok(Number.isFinite(s.marginMm) && s.marginMm > 0, `margin ${s.marginMm}`);
    assert.ok(s.adhesionRatio > 0, `ratio ${s.adhesionRatio}`);
    assert.equal(isStaticallyUnstable(s), false);
});

test('a stray vertex does not define the plate plane', () => {
    // Two collapsed triangles on a vertex 10mm below the cube. The defect must
    // not move the base plane, the volume, or the bearing patch.
    const m = cube();
    const positions = [...m.positions, 30, 25, -15];
    const index = [...m.index, 0, 8, 8, 0, 8, 8];
    const s = measurePoseStability(positions, index, 0, 0);
    assert.equal(s.volumeMm3, 1000);
    assert.equal(s.bearingAreaMm2, 100);
    assert.equal(s.bearingEdges, 4);
    assert.ok(Math.abs(s.plateZMm - -5) < 1e-9, `plate ${s.plateZMm}`);
    assert.equal(isStaticallyUnstable(s), false);
});

test('a part standing comfortably needs no anti-topple coverage', () => {
    // The cam seal tool's numbers: a wide bearing patch, the centroid 23.6mm
    // inside it, and an adhesion ratio far above the conservative p/sigma. It
    // was wrapped in a support forest anyway, because the steep-flat coverage
    // never asked this question.
    const tool = {
        plateZMm: 0,
        volumeMm3: 97159,
        bearingAreaMm2: 1755.7,
        bearingEdges: 85,
        centroidDepthMm: 23.63,
        contactDepthMm: 23.63,
        dragMomentMm3: 52524,
        marginMm: 43.72,
        adhesionRatio: 0.79,
        pushDirDeg: 211,
        dragTopMm: 35.2,
        restingContact: { overhangAreaMm2: 0, cupAreaMm2: 0, scarAreaMm2: 0, blockedAreaMm2: 0 },
    };
    assert.ok(tool.adhesionRatio > CONSERVATIVE_P_SIGMA, 'comfortably above the conservative bound');
    assert.equal(needsToppleCoverage(tool), false, 'so the steep wall stays uncovered');

    // The same part leaning, or with its mass outside the base, does need it.
    assert.equal(needsToppleCoverage({ ...tool, adhesionRatio: 0.001 }), true, 'marginal lifts');
    assert.equal(needsToppleCoverage({ ...tool, centroidDepthMm: -3 }), true, 'mass outside the base');
    assert.equal(needsToppleCoverage({ ...tool, bearingEdges: 0 }), true, 'no bearing polygon');
});
