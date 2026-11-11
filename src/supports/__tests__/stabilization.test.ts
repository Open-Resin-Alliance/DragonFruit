import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { measurePoseStability, posedPositions } from '../autoSupport/poseStability';
import { computeStabilizationAnchors } from '../autoSupport/stabilization';

/** A 20mm box, face-down (centered at origin → the −Z face is the base). */
function faceDownBox(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    mesh.updateMatrixWorld(true);
    return mesh;
}

/** The same box rotated so the (−10,−10,−10) corner is the lowest point. */
function cornerDownBox(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    // Body diagonal (1,1,1) → (0,0,√3): rotate about (1,−1,0) by acos(1/√3).
    const axis = new THREE.Vector3(1, -1, 0).normalize();
    mesh.quaternion.setFromAxisAngle(axis, Math.acos(1 / Math.sqrt(3)));
    mesh.updateMatrixWorld(true);
    return mesh;
}

/** The same box rotated so a whole 20mm edge rests on the base (45° about X). */
function edgeDownBox(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    mesh.rotation.x = Math.PI / 4;
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('a face-down box is stable and needs no anchors', () => {
    assert.deepEqual(computeStabilizationAnchors(faceDownBox()), [], 'flat base → stable');
});

test('a corner-down box is unstable and gets a comb of anchors along its low edges', () => {
    const anchors = computeStabilizationAnchors(cornerDownBox());
    assert.ok(anchors.length >= 6, `comb, not a sparse tripod (got ${anchors.length})`);
    // Non-collinear: the projected hull of the anchors must have area.
    const pts = anchors.map((a) => new THREE.Vector2(a.x, a.y));
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        area += p.x * q.y - q.x * p.y;
    }
    assert.ok(Math.abs(area) / 2 > 1, `anchors span a base (area ${(Math.abs(area) / 2).toFixed(1)})`);
});

test('an edge-down box is unstable and gets anchors on both sides', () => {
    const anchors = computeStabilizationAnchors(edgeDownBox());
    assert.ok(anchors.length >= 6, `edge gets a row plus flanking anchors (got ${anchors.length})`);
    // The anchors must not all lie on a single line (they broaden the edge).
    const xs = new Set(anchors.map((a) => Math.round(a.x * 10)));
    const ys = new Set(anchors.map((a) => Math.round(a.y * 10)));
    assert.ok(xs.size > 1 && ys.size > 1, 'anchors spread off the edge line');
});

/** 20 long × 2 thin × 60 tall blade, tilted 45° about X so a 20mm edge rests on the plate. */
function bladeOnEdge(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 2, 60));
    mesh.rotation.x = Math.PI / 4;
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('a tall blade on its edge gets buttresses up its faces', () => {
    const anchors = computeStabilizationAnchors(bladeOnEdge());
    const zs = anchors.map((a) => a.z);
    const rise = Math.max(...zs) - Math.min(...zs);
    assert.ok(rise > 6, `buttresses reach up the blade (got ${rise.toFixed(1)}mm rise, want > 6)`);
});

test('a small part below the bearing minimum is still covered', () => {
    // 2mm cube face-down: hull area 4mm² at the threshold is still stable.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.updateMatrixWorld(true);
    const anchors = computeStabilizationAnchors(mesh);
    assert.deepEqual(anchors, [], 'tiny but flat is stable');
});

/** A face-down 20mm box plus two collapsed triangles on one vertex 10mm below it. */
function boxWithStrayVertex(): THREE.Mesh {
    const base = new THREE.BoxGeometry(20, 20, 20);
    const positions = Array.from(base.getAttribute('position').array as ArrayLike<number>);
    // The box's bottom face is at z = -10; the defect sits 10mm under it.
    const stray = [40, 33.5, -20];
    for (let i = 0; i < 2; i++) {
        positions.push(0, 0, 0, ...stray, ...stray);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('a stray vertex does not decide where the part touches the plate', () => {
    // The defect (one vertex 10mm below the model on zero-area faces) must not
    // define the bearing locus: it used to empty the contact band, declare a
    // flat base unstable and climb the defect's own edges instead of the base.
    // A face-down box is stable either way once the defect is ignored.
    assert.deepEqual(
        computeStabilizationAnchors(boxWithStrayVertex()),
        [],
        'flat base stays stable despite the defect',
    );
});

test('HIGH-06: tilted plank on an X-aligned 1D bearing edge prioritizes tension flank normal to X-edge instead of biasing -X', () => {
    // 80mm wide (along X) × 8mm thick × 40mm tall plank, rotated -30° about X so it rests on
    // a single X-aligned 1D bearing edge (y ≈ -6.54, z ≈ -19.32) and leans strongly toward +Y.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(80, 8, 40, 16, 1, 2));
    mesh.rotation.x = -Math.PI / 6;
    mesh.updateMatrixWorld(true);

    const worldPos = posedPositions(mesh);
    const index = mesh.geometry.getIndex()?.array as ArrayLike<number> | undefined;
    const stability = measurePoseStability(worldPos, index, 0, 0);
    assert.equal(stability.bearingEdges, 0);
    assert.ok(Math.abs(stability.pushDirDeg - 90) < 5, `tilted plank leans +Y (~90°), got ${stability.pushDirDeg}`);

    const anchors = computeStabilizationAnchors(mesh);
    assert.ok(anchors.length > 0);
    const zMin = Math.min(...anchors.map((a) => a.z));
    const stanceY = anchors.find((a) => Math.abs(a.z - zMin) < 1e-3)!.y;
    const raised = anchors.filter((a) => a.z - zMin > 0.5);
    assert.ok(raised.length > 0, 'emits raised buttress teeth');

    // Tension side is -Y (y < stanceY), opposite the +Y overhang push direction:
    const tensionCount = raised.filter((a) => a.y < stanceY - 0.1).length;
    const pushCount = raised.filter((a) => a.y > stanceY + 0.1).length;
    assert.ok(
        tensionCount > pushCount,
        `buttresses must prioritize -Y tension flank (${tensionCount}) over +Y overhang (${pushCount})`,
    );

    // Must NOT bias along -X (x < 0) vs +X (x > 0) from pushDirDeg = 0° fallback:
    const negX = raised.filter((a) => a.x < -0.5).length;
    const posX = raised.filter((a) => a.x > 0.5).length;
    assert.ok(
        Math.abs(negX - posX) <= 2,
        `buttresses along X-edge should be X-symmetric (-X: ${negX}, +X: ${posX})`,
    );
});

test('HIGH-06: symmetric X-aligned V-wedge aligns pushDirDeg normal to X-edge and avoids -X anchor bias', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(80, 20, 20, 16, 1, 1));
    mesh.rotation.x = Math.PI / 4;
    mesh.updateMatrixWorld(true);

    const worldPos = posedPositions(mesh);
    const index = mesh.geometry.getIndex()?.array as ArrayLike<number> | undefined;
    const stability = measurePoseStability(worldPos, index, 0, 0);
    assert.equal(stability.bearingEdges, 0);
    assert.ok(
        Math.abs(stability.pushDirDeg - 90) < 5 || Math.abs(stability.pushDirDeg - 270) < 5,
        `symmetric X-wedge pushDirDeg must be normal to X-edge (90° or 270°), got ${stability.pushDirDeg}`,
    );

    const anchors = computeStabilizationAnchors(mesh);
    const zMin = Math.min(...anchors.map((a) => a.z));
    const raised = anchors.filter((a) => a.z - zMin > 0.5);
    const negX = raised.filter((a) => a.x < -0.5).length;
    const posX = raised.filter((a) => a.x > 0.5).length;
    assert.ok(
        Math.abs(negX - posX) <= 2,
        `symmetric X-wedge buttresses must not bias -X (-X: ${negX}, +X: ${posX})`,
    );
});
