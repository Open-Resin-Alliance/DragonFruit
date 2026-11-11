import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONSERVATIVE_P_SIGMA,
    isStaticallyUnstable,
    measurePoseStability,
    needsToppleCoverage,
    isSlenderPart,
    SLENDER_RATIO,
    STEEP_FLAT_ANCHOR_MIN_AREA_MM2,
    steepFlatNeedsCoverage,
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
        totalDragMomentMm3: 52524,
        marginMm: 43.72,
        adhesionRatio: 0.79,
        pushDirDeg: 211,
        heightMm: 66.6,
        thicknessMm: 33.3,
        slenderness: 2.0,
        dragTopMm: 35.2,
        restingContact: { overhangAreaMm2: 0, cupAreaMm2: 0, scarAreaMm2: 0, blockedAreaMm2: 0 },
    };
    assert.ok(tool.adhesionRatio > CONSERVATIVE_P_SIGMA, 'comfortably above the conservative bound');
    assert.equal(needsToppleCoverage(tool), false, 'so the steep wall stays uncovered');

    // Leaning with the centroid OUTSIDE the patch is not a reason on its own.
    // The static test is the FDM frame's rule; the part hangs from the plate
    // here, gravity's share of the peel is 4e-5 MPa, and the adhesion ratio
    // already says whether it lifts.
    const leaning = { ...tool, centroidDepthMm: -8.36, contactDepthMm: 4.62, bearingAreaMm2: 310.2, adhesionRatio: 0.067 };
    assert.equal(needsToppleCoverage(leaning), false, 'the pose the tool came back in stays uncovered');

    // What does fire: a ratio at or below the conservative bound, which is also
    // what a point or edge contact produces (almost no area to restore with).
    assert.equal(needsToppleCoverage({ ...tool, adhesionRatio: 0.001 }), true, 'marginal lifts');
    assert.equal(needsToppleCoverage({ ...tool, adhesionRatio: CONSERVATIVE_P_SIGMA - 0.001 }), true, 'just under');
    assert.equal(needsToppleCoverage({ ...tool, adhesionRatio: CONSERVATIVE_P_SIGMA }), false, 'the bound itself is safe');
    const pointContact = { ...tool, bearingAreaMm2: 0.2, bearingEdges: 0, adhesionRatio: 0.0004 };
    assert.equal(needsToppleCoverage(pointContact), true, 'a point contact still fires');
});

test('with a raft the patch is the shadow, not the wandering contact cap', () => {
    // A dome-ish body: a tilted 10mm cube stands in for the wandering cap. The
    // shadow is the whole projection, so its area and depth stop depending on
    // which point happens to be lowest.
    const m = cube();
    const cap = measurePoseStability(m.positions, m.index, 20 * (Math.PI / 180), 0);
    const raft = measurePoseStability(m.positions, m.index, 20 * (Math.PI / 180), 0, undefined, true);

    assert.ok(raft.bearingAreaMm2 > cap.bearingAreaMm2, 'the shadow is larger than the cap');
    // Analytic: a 10mm cube tilted 20 degrees about X projects to a 10 by
    // (10cos20 + 10sin20) rectangle, and the shadow is that whole silhouette.
    const expected = 10 * (10 * Math.cos(0.3490658503988659) + 10 * Math.sin(0.3490658503988659));
    assert.ok(
        Math.abs(raft.bearingAreaMm2 - expected) < 1,
        `shadow is the projected silhouette (got ${raft.bearingAreaMm2}, want ${expected})`,
    );
    const raftFlat = measurePoseStability(m.positions, m.index, 0, 0, undefined, true);
    assert.ok(Math.abs(raftFlat.bearingAreaMm2 - 100) < 1, 'flat, the shadow is the base');
});

test('a flat anchors if it has room for contacts, and the band keeps it low', () => {
    // The cam seal tool's 2752mm² face is worth anchoring: planar, room to
    // spread, facing the way the part would move.
    assert.equal(steepFlatNeedsCoverage(2752, false), true, 'the tool anchors on its big face');
    assert.equal(STEEP_FLAT_ANCHOR_MIN_AREA_MM2, 400, 'unconditional anchor floor sits above Rust 150mm² classifier floor');
    assert.equal(
        steepFlatNeedsCoverage(STEEP_FLAT_ANCHOR_MIN_AREA_MM2, false),
        true,
        'the floor itself anchors',
    );
    // A 42mm figurine's 465mm² face, on a part whose whole footprint is 738mm².
    // Worth a low band, which is what the band rule then keeps it to.
    assert.equal(steepFlatNeedsCoverage(465, false), true, 'a figurine face anchors');
    // A 20mm cube's 400mm² face likewise: covering it low is fine, and the
    // complaint about it was the height, not the contact.
    assert.equal(steepFlatNeedsCoverage(400, false), true, 'and so does a small cube face');
    // Moderate [150, 400) mm² steep flats classified by Rust are gated by the pose verdict.
    assert.equal(steepFlatNeedsCoverage(250, false), false, 'moderate steep flat stays uncovered on stable pose');
    assert.equal(steepFlatNeedsCoverage(250, true), true, 'moderate steep flat is covered when pose needs rescue');
    // Below the floor there is no room to spread anything across.
    assert.equal(steepFlatNeedsCoverage(120, false), false, 'a speck gets nothing');
    assert.equal(steepFlatNeedsCoverage(undefined, false), false, 'no area, no claim');
    // A pose that needs rescuing covers every steep flat, big or small.
    assert.equal(steepFlatNeedsCoverage(400, true), true, 'a rescue covers everything');
});

test('HIGH-06: point and 1D knife-edge contacts with drag report adhesionRatio 0, needsToppleCoverage true, and true pushDirDeg', () => {
    // 1. Inverted pyramid balanced on single apex (0, 0, 0) leaning toward +Y:
    //    top rectangle [-5, 5] × [0, 20] at z = 20.
    const pyramidPositions = [
        0, 0, 0,
        -5, 0, 20,
        5, 0, 20,
        5, 20, 20,
        -5, 20, 20,
    ];
    const pyramidIndex = [
        0, 2, 1, // -Y vertical wall (ny = -200, nz = 0)
        0, 4, 3, // +Y 45° overhang face (ny = +200, nz = -200)
        0, 1, 4, // -X overhang face (nx = -400, nz = -100)
        0, 3, 2, // +X overhang face (nx = +400, nz = -100)
        1, 2, 3, // +Z top cap
        1, 3, 4,
    ];
    const p = measurePoseStability(pyramidPositions, pyramidIndex, 0, 0);
    assert.equal(p.bearingEdges, 0);
    assert.ok(p.totalDragMomentMm3 > 0, `expected positive totalDragMomentMm3, got ${p.totalDragMomentMm3}`);
    assert.equal(p.adhesionRatio, 0, 'point stance with peel drag has zero adhesion ratio');
    assert.equal(needsToppleCoverage(p), true, 'point stance with peel drag requires topple coverage');
    assert.ok(Math.abs(p.pushDirDeg - 90) < 5, `point stance pushDirDeg should point +Y (~90°), got ${p.pushDirDeg}`);

    // 2. 10mm cube tilted ±30° about X onto an X-aligned 1D knife-edge:
    //    matches Rust `edge_down_pose_has_no_bearing_polygon` (~500 mm³ unprojected drag).
    const m = cube();
    const edgePos30 = measurePoseStability(m.positions, m.index, 30 * DEG, 0);
    assert.equal(edgePos30.bearingEdges, 0);
    assert.ok(Math.abs(edgePos30.totalDragMomentMm3 - 500) < 2, `total drag ${edgePos30.totalDragMomentMm3}`);
    assert.equal(edgePos30.adhesionRatio, 0);
    assert.equal(needsToppleCoverage(edgePos30), true);
    assert.ok(Math.abs(edgePos30.pushDirDeg - 270) < 5, `+30° Rx tilt pulls toward -Y (270°), got ${edgePos30.pushDirDeg}`);

    const edgeNeg30 = measurePoseStability(m.positions, m.index, -30 * DEG, 0);
    assert.equal(edgeNeg30.bearingEdges, 0);
    assert.equal(edgeNeg30.adhesionRatio, 0);
    assert.equal(needsToppleCoverage(edgeNeg30), true);
    assert.ok(Math.abs(edgeNeg30.pushDirDeg - 90) < 5, `-30° Rx tilt pulls toward +Y (90°), got ${edgeNeg30.pushDirDeg}`);

    // 3. Mirror-symmetric 45° X-edge stance: opposing ±Y flanks cancel first-moment vector,
    //    structure tensor resolves normal to the X-blade (90° or 270°), never along +X (0°).
    const edgeSym45 = measurePoseStability(m.positions, m.index, 45 * DEG, 0);
    assert.equal(edgeSym45.bearingEdges, 0);
    assert.equal(edgeSym45.adhesionRatio, 0);
    assert.equal(needsToppleCoverage(edgeSym45), true);
    assert.ok(
        Math.abs(edgeSym45.pushDirDeg - 90) < 5 || Math.abs(edgeSym45.pushDirDeg - 270) < 5,
        `symmetric X-blade pushDirDeg must be perpendicular to X-edge (90°/270°), got ${edgeSym45.pushDirDeg}`,
    );

    // 4. Zero-drag degenerate upward-facing triangle (bearingEdges === 0, totalDragMomentMm3 === 0)
    //    keeps adhesionRatio === Infinity and needsToppleCoverage === false.
    const upSheet = measurePoseStability([0, 0, 0, 4, 0, 0, 2, 2, 5], [0, 1, 2], 0, 0);
    assert.equal(upSheet.bearingEdges, 0);
    assert.equal(upSheet.totalDragMomentMm3, 0);
    assert.equal(upSheet.adhesionRatio, Infinity);
    assert.equal(needsToppleCoverage(upSheet), false);
});

test('a wall counts as slender, a cube does not', () => {
    // The 505k-triangle part: 126mm tall, 79cm³, a 7107mm² raft footprint, so
    // about 11mm thick. It prints, but it wiggles, and the Z lines are the
    // evidence.
    const wall = { heightMm: 126.2, volumeMm3: 79064.2, bearingAreaMm2: 7107.2 };
    assert.ok(isSlenderPart(wall), `wall is slender (${(126.2 / (79064.2 / 7107.2)).toFixed(1)}x)`);

    // A 20mm cube on its raft: barely taller than thick.
    const cube = { heightMm: 22.1, volumeMm3: 8000, bearingAreaMm2: 442.8 };
    assert.equal(isSlenderPart(cube), false, 'a cube is not a wall');

    // Degenerate measurements never claim slenderness.
    assert.equal(isSlenderPart({ heightMm: 100, volumeMm3: 0, bearingAreaMm2: 10 }), false);
    assert.equal(isSlenderPart({ heightMm: 100, volumeMm3: 100, bearingAreaMm2: 0 }), false);
    assert.equal(SLENDER_RATIO, 4);
});
