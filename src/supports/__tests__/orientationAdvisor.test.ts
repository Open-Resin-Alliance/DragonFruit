import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    composeOrientationDelta,
    computeTriangleDetail,
    evaluateOrientationCost,
    generateM1Candidates,
    restingPoseCandidates,
    suggestOrientation,
    suggestOrientationForGeometry,
} from '../autoSupport/orientationAdvisor';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/** Unit down-facing square (area 1) in the XY plane. */
function downSquare(): { positions: number[]; index: number[] } {
    return {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        index: [0, 2, 1, 0, 3, 2],
    };
}

/** Unit up-facing square (area 1). */
function upSquare(): { positions: number[]; index: number[] } {
    return {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        index: [0, 1, 2, 0, 2, 3],
    };
}

/** 2 mm cube with outward winding. */
function cube(): { positions: number[]; index: number[] } {
    return {
        positions: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
        index: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
    };
}

/** 2×2×10 mm tower: cube topology stretched in Z. */
function tallBox(): { positions: number[]; index: number[] } {
    const c = cube();
    const positions = [...c.positions];
    for (let i = 2; i < positions.length; i += 3) positions[i] *= 5;
    return { positions, index: c.index };
}

/** 10 mm cube with outward winding — the scale the Rust report's fixtures use. */
function tenMmCube(): { positions: number[]; index: number[] } {
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

/** 10×10×1 mm plate with outward winding. */
function flatPlate(): { positions: number[]; index: number[] } {
    const m = tenMmCube();
    const positions = [...m.positions];
    for (let i = 2; i < positions.length; i += 3) positions[i] *= 0.1;
    return { positions, index: m.index };
}

test('the plate contact is charged as overhang but never as a cup', () => {
    // Auto-lift floats the model a few mm above the plate, so its base really
    // does need supports bridging the gap — the island scan reports exactly
    // that (a face-down cube: one overhang region, its base). It is not a
    // suction cup though: resin flows under a sparse support forest, so the
    // cup term must not double-charge it. Charging it was what made a flat
    // pose cost 300 mm² while a corner-down pose scored 0.
    const c = evaluateOrientationCost(downSquare(), 0, 0);
    assert.equal(c.overhangAreaMm2, 1, 'the base still needs support');
    assert.equal(c.cupAreaMm2, 0, 'but it is not a cup');
    assert.equal(c.cost, 1);
    assert.equal(c.heightMm, 0, 'planar square has no height');
    assert.equal(c.footprintMm2, 1, '1×1 footprint');
    assert.equal(c.bearingAreaMm2, 1, 'and it bears on the plate');
});

test('a down-facing face above the contact band is still charged', () => {
    // The same face tilted 20° off the plate: still down-facing, so still
    // charged in full — the contact band only exempts it from the cup term.
    const c = evaluateOrientationCost(tenMmCube(), (20 * Math.PI) / 180, 0);
    assert.equal(c.overhangAreaMm2, 100, 'the whole 10×10 underside is charged');
    assert.equal(c.cupAreaMm2, 0, 'and none of it is a cup');
    // A coarse flat base carries no vertices between its corners, so past
    // ~11.5° the 2mm band holds only the lowest edge's two: the pose rests on a
    // line and the stability term says so.
    assert.equal(c.bearingEdges, 0);
    assert.ok(c.stabilityPenaltyMm2 > 0, 'and the pose pays for it');
});

test('up-facing square costs nothing', () => {
    const c = evaluateOrientationCost(upSquare(), 0, 0);
    assert.equal(c.overhangAreaMm2, 0);
    assert.equal(c.cupAreaMm2, 0);
    assert.equal(c.cost, 0);
});

test('flipping over removes the cost', () => {
    const c = evaluateOrientationCost(downSquare(), Math.PI, 0);
    assert.equal(c.overhangAreaMm2, 0, 'rotX 180° turns the face up');
});

test('a flat plate pays for its base once, not twice', () => {
    // Auto-lift floats the model, so the base is real support contact and is
    // charged as overhang — but it is not a cup, so the cupWeight (default 2)
    // must not double it. That double charge is what made a flat pose cost
    // 300 mm² while a corner-down pose scored 0.
    const c = evaluateOrientationCost(flatPlate(), 0, 0);
    assert.equal(c.overhangAreaMm2, 100, 'the 10×10 base is charged once');
    assert.equal(c.cupAreaMm2, 0, 'and never as a cup');
    assert.equal(c.cost, 100);
    assert.equal(c.bearingEdges, 4, 'lying flat it bears on a polygon');
});

test('sweep is deterministic across calls', () => {
    const a = suggestOrientation(downSquare(), { candidateCount: 32 });
    const b = suggestOrientation(downSquare(), { candidateCount: 32 });
    assert.deepEqual(a, b, 'same mesh → identical suggestion, no seed needed');
});

test('already-optimal geometry returns identity', () => {
    const s = suggestOrientation(upSquare());
    assert.equal(s.rotXDeg, 0);
    assert.equal(s.rotYDeg, 0);
    assert.equal(s.deltaPercent, 0);
});

test('sweep never regresses on a cube', () => {
    const s = suggestOrientation(cube(), { candidateCount: 48 });
    assert.ok(s.deltaPercent <= 0, `never worse than identity (got ${s.deltaPercent}%)`);
    assert.ok(Number.isFinite(s.rotXDeg) && Number.isFinite(s.rotYDeg), 'finite angles');
    assert.ok(s.suggested.cost <= s.baseline.cost, 'suggested costs no more than baseline');
});

test('candidate set holds identity and stays bounded', () => {
    const cands = generateM1Candidates(downSquare(), { candidateCount: 24, restingPoseCount: 4 });
    assert.ok(cands.length >= 25, `identity + sweep (got ${cands.length})`);
    assert.ok(cands.length <= 29, `bounded by resting cap (got ${cands.length})`);
    assert.deepEqual(cands[0], { rotXRad: 0, rotYRad: 0 }, 'identity leads so the result never regresses');
    assert.deepEqual(cands, generateM1Candidates(downSquare(), { candidateCount: 24, restingPoseCount: 4 }), 'deterministic');
});

test('resting poses find the six cube faces', () => {
    const poses = restingPoseCandidates(cube(), 6);
    assert.equal(poses.length, 6, `one pose per cube face (got ${poses.length})`);
    for (const p of poses) {
        assert.ok(Number.isFinite(p.rotXRad) && Number.isFinite(p.rotYRad), 'finite pose angles');
    }
});

test('geometry adapter rejects empty geometry and accepts soup', () => {
    assert.equal(suggestOrientationForGeometry({ attributes: {} }), null, 'no positions → null');
    assert.equal(
        suggestOrientationForGeometry({ attributes: { position: { array: [] } } }),
        null,
        'empty positions → null',
    );
    const s = suggestOrientationForGeometry({
        attributes: { position: { array: downSquare().positions } },
        index: downSquare().index,
    });
    assert.ok(s && s.suggested.cost === 0, 'indexed soup solves like the raw mesh');
});

test('a cube baked onto its edge is offered a pose that can stand', () => {
    // The reported bug: a cube came back oriented onto a corner, which then
    // needs a stabilization anchor at every edge. Identity here IS the edge
    // pose, and the suggestion has to leave it.
    const m = tenMmCube();
    const a = (45 * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const positions = [...m.positions];
    for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1];
        const z = positions[i + 2];
        positions[i + 1] = y * ca - z * sa;
        positions[i + 2] = y * sa + z * ca;
    }
    const mesh = { positions, index: m.index };
    const s = suggestOrientation(mesh, { candidateCount: 64 });
    assert.equal(s.baseline.bearingEdges, 0, 'identity balances on an edge');
    assert.ok(s.baseline.stabilityPenaltyMm2 > 0, 'and is charged for it');
    assert.ok(s.suggested.bearingEdges > 0, 'the suggestion bears on a polygon');
    assert.equal(s.suggested.stabilityPenaltyMm2, 0, 'so it pays nothing');
    assert.ok(s.suggested.cost < s.baseline.cost, 'and wins on cost');
    assert.ok(s.rotXDeg !== 0 || s.rotYDeg !== 0, 'a real rotation is offered');
});

test('the stability term can be turned off', () => {
    // Same mesh, weight 0: the edge pose is no longer charged, so the search
    // ranks on contact area alone — the behaviour before this term existed.
    const m = tenMmCube();
    const a = (45 * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const positions = [...m.positions];
    for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1];
        const z = positions[i + 2];
        positions[i + 1] = y * ca - z * sa;
        positions[i + 2] = y * sa + z * ca;
    }
    const mesh = { positions, index: m.index };
    const s = suggestOrientation(mesh, { candidateCount: 64, stabilityWeight: 0 });
    assert.equal(s.baseline.stabilityPenaltyMm2, 0);
    assert.equal(s.suggested.stabilityPenaltyMm2, 0);
});

test('a plain tower stays upright: a knife-edge pose is not cheaper', () => {
    // This used to "improve" by laying the tower down, because the upright
    // pose was charged its own base twice (overhang plus the cup term) while a
    // knife-edge pose scored 0 by keeping every face just above the
    // self-support angle. The base is charged once now (auto-lift means it does
    // need support) and the cup term is gone; the edge pose has no bearing
    // polygon and pays the stability penalty — so upright wins.
    const s = suggestOrientation(tallBox(), { objective: 'supports', candidateCount: 48 });
    assert.equal(s.baseline.cost, 4, 'an upright box pays for its 2×2 base only');
    assert.equal(s.suggested.cost, 4);
    assert.equal(s.rotXDeg, 0);
    assert.equal(s.rotYDeg, 0);
    assert.equal(s.suggested.bearingEdges, 4, 'and it still bears on its base');
});

test('height objective lays the tower down', () => {
    const s = suggestOrientation(tallBox(), { objective: 'height', candidateCount: 48 });
    assert.ok(s.suggested.heightMm < s.baseline.heightMm, `shorter than upright (got ${s.suggested.heightMm} vs ${s.baseline.heightMm})`);
    assert.ok(s.suggested.heightMm <= 2.5, `near the 2 mm minimum (got ${s.suggested.heightMm})`);
    assert.ok(Number.isFinite(s.rotXDeg) && Number.isFinite(s.rotYDeg), 'finite angles');
});

test('height objective leaves flat parts flat', () => {
    const s = suggestOrientation(downSquare(), { objective: 'height' });
    assert.equal(s.rotXDeg, 0, 'any tilt adds height to a planar part');
    assert.equal(s.rotYDeg, 0);
});

/** Icosahedron (radius r): face normals cover the sphere, so no zero-cost pose exists. */
function icosahedron(radius: number): { positions: number[]; index: number[] } {
    const t = (1 + Math.sqrt(5)) / 2;
    const positions = [
        -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
        0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
        t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
    ].map((v) => v * radius);
    const index = [
        0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
        1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
        3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
        4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    return { positions, index };
}

/** Icosahedron baked 30° off its symmetric pose, so identity is far from optimal. */
function tiltedIcosahedron(): { positions: number[]; index: number[] } {
    const m = icosahedron(2.5);
    const a = (30 * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const positions = [...m.positions];
    for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1];
        const z = positions[i + 2];
        positions[i + 1] = y * ca - z * sa;
        positions[i + 2] = y * sa + z * ca;
    }
    return { positions, index: m.index };
}

test('anchoring margin trades a little contact for a wider base', () => {
    const mesh = tiltedIcosahedron();
    const s = suggestOrientation(mesh, { candidateCount: 120 });
    // Floor via the public cost fn: cheapest coarse candidate.
    let minPrimary = Infinity;
    for (const c of generateM1Candidates(mesh, { candidateCount: 120 })) {
        const e = evaluateOrientationCost(mesh, c.rotXRad, c.rotYRad, {});
        if (e.cost < minPrimary) minPrimary = e.cost;
    }
    assert.ok(
        s.suggested.cost <= minPrimary * 1.05 + 0.5 + 1e-6,
        `de-opt stays inside the margin (got ${s.suggested.cost} vs floor ${minPrimary})`,
    );
    assert.ok(s.suggested.footprintMm2 > 80, `widest base wins (got ${s.suggested.footprintMm2})`);
    assert.ok(s.deltaPercent < 0, 'still a strict improvement over the baked tilt');
});

test('computeTriangleDetail scores folds, flats, and lone triangles', () => {
    const fold = computeTriangleDetail(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1],
        [0, 1, 2, 1, 0, 3],
        2,
        new Float64Array([0, 0, -1, -1, 0, 0]),
        new Float64Array([0.5, 0.5]),
    );
    assert.ok(Math.abs(fold[0] - 1) < 1e-9 && Math.abs(fold[1] - 1) < 1e-9, 'right-angle crease reads 1');
    const flat = computeTriangleDetail(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
        [0, 1, 2, 1, 3, 2],
        2,
        new Float64Array([0, 0, -1, 0, 0, -1]),
        new Float64Array([0.5, 0.5]),
    );
    assert.deepEqual([...flat], [0, 0], 'coplanar pair reads 0');
    const lone = computeTriangleDetail(
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
        [0, 1, 2],
        1,
        new Float64Array([0, 0, -1]),
        new Float64Array([0.5]),
    );
    assert.deepEqual([...lone], [0], 'boundary-only triangle reads 0');
});

test('scar equals overhang on featureless plates', () => {
    const c = evaluateOrientationCost(downSquare(), 0, 0, {});
    assert.equal(c.scarAreaMm2, c.overhangAreaMm2, 'no detail, nothing to scar');
});

test('scarring with zero weight matches supports ranking', () => {
    const a = suggestOrientation(downSquare(), { objective: 'scarring', scarWeight: 0 });
    const b = suggestOrientation(downSquare(), {});
    assert.deepEqual(a, b, 'zero weight degenerates to contact ranking');
});

test('scarring returns a valid never-worse suggestion', () => {
    const mesh = tiltedIcosahedron();
    const s = suggestOrientation(mesh, { candidateCount: 120, objective: 'scarring' });
    assert.ok(Number.isFinite(s.rotXDeg) && Number.isFinite(s.rotYDeg), 'finite angles');
    assert.ok(s.suggested.cost <= s.baseline.cost, 'never worse than identity');
    const again = suggestOrientation(mesh, { candidateCount: 120, objective: 'scarring' });
    assert.deepEqual(s, again, 'deterministic');
});

test('composed orientation renders canonically at the scored pose', () => {
    const rad = (d: number): number => (d * Math.PI) / 180;
    const qx = (a: number): THREE.Quaternion =>
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    const qy = (a: number): THREE.Quaternion =>
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    const qz = (a: number): THREE.Quaternion =>
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
    const gapDeg = (p: THREE.Quaternion, q: THREE.Quaternion): number =>
        (2 * Math.acos(Math.min(1, Math.abs(p.dot(q)))) * 180) / Math.PI;
    const base = { x: 0.2, y: 0.3, z: 0 };
    const stored = composeOrientationDelta(base, 10, -15);
    assert.equal(stored.order, 'ZYX', 'order travels for setFromEuler readers');
    const expected = qy(rad(-15)).multiply(qx(rad(10))).multiply(qz(0).multiply(qy(0.3)).multiply(qx(0.2)));
    assert.ok(gapDeg(new THREE.Quaternion().setFromEuler(stored), expected) < 1e-3, 'order-carrying readers agree');
    assert.ok(gapDeg(quaternionFromGlobalEuler(stored), expected) < 1e-3, 'canonical readers agree');
    const identity = composeOrientationDelta(null, 0, 0);
    assert.ok(identity.x === 0 && identity.y === 0 && identity.z === 0, 'null delta stays put');
    assert.equal(identity.order, 'ZYX');
});

test('blocked down-facing area is measured and weighted into cost', () => {
    // A tilted cube: part of its underside is contact, the rest is a real
    // overhang, so there is area for a nogo mask to land on.
    const mesh = tenMmCube();
    const tilt = (20 * Math.PI) / 180;
    const plain = evaluateOrientationCost(mesh, tilt, 0);
    assert.equal(plain.blockedAreaMm2, 0);
    const blocked = evaluateOrientationCost(mesh, tilt, 0, { blockedTriangleIndices: [0, 1, 2, 3] });
    assert.equal(blocked.blockedAreaMm2, blocked.overhangAreaMm2);
    assert.ok(blocked.blockedAreaMm2 > 0, 'tilted underside is blocked contact');
    assert.ok(blocked.cost > plain.cost, 'blocked poses cost more');
    // Up-facing square: blocked paint is irrelevant, no supports needed there.
    const up = evaluateOrientationCost(upSquare(), 0, 0, { blockedTriangleIndices: [0, 1] });
    assert.equal(up.blockedAreaMm2, 0);
});

test('blocked mask never regresses the suggestion', () => {
    const mesh = downSquare();
    const s = suggestOrientation(mesh, { blockedTriangleIndices: [0, 1] });
    assert.ok(s.suggested.cost <= s.baseline.cost, 'never worse than identity');
    assert.equal(s.suggested.blockedAreaMm2, 0, 'winner turns the blocked face away');
});
