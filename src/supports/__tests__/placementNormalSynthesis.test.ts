import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import {
    buildLeafCapAnchor,
    computeThinWallMaxSafePenetrationMm,
    extractSphericalCapDescriptor,
    orbitLeafCapAnchorTowardKnot,
    resolveKnotWeightedCapNormal,
    resolvePlacementNormalAndCap,
    synthesizePlacementNormal,
} from '../PlacementLogic/PlacementNormalSynthesis';
import { hasWarmSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';

type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

function attachBvh(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    (geometry as BvhGeometry).boundsTree = new MeshBVH(geometry);
    return geometry;
}

function makeNonIndexedMesh(geometry: THREE.BufferGeometry, withBvh = true): THREE.Mesh {
    const soup = geometry.index ? geometry.toNonIndexed() : geometry;
    soup.computeVertexNormals();
    if (withBvh) {
        attachBvh(soup);
    }
    const mesh = new THREE.Mesh(soup);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function angleDeg(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    const va = new THREE.Vector3(a.x, a.y, a.z).normalize();
    const vb = new THREE.Vector3(b.x, b.y, b.z).normalize();
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
}

function buildTriangleSoupMesh(
    triVertices: Array<[number, number, number, number, number, number, number, number, number]>,
    withBvh = true,
): THREE.Mesh {
    const positions = new Float32Array(triVertices.length * 9);
    for (let i = 0; i < triVertices.length; i++) {
        const t = triVertices[i];
        positions.set(t, i * 9);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    if (withBvh) {
        attachBvh(geometry);
    }
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function triangleNormalAt(mesh: THREE.Mesh, triIndex: number): THREE.Vector3 {
    const geom = (mesh.userData?.raycastGeometry as THREE.BufferGeometry | undefined) ?? mesh.geometry;
    const pos = geom.getAttribute('position');
    const i0 = triIndex * 3;
    const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i0 + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i0 + 2);
    return new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
}

test('1. flat 32x32 grid with 0.01 mm diagonal ripple: raw jitters while bisector converges flat', () => {
    const N = 32;
    const span = 12.8; // 0.40 mm cell size -> ~2.0° facet tilt, 4.0° peak-to-peak (< 5° flat threshold)
    const step = span / N;
    const half = span / 2;
    const tris: Array<[number, number, number, number, number, number, number, number, number]> = [];

    const zAt = (ix: number, iy: number): number => (((ix + iy) & 1) === 0 ? 0.005 : -0.005);

    for (let iy = 0; iy < N; iy++) {
        for (let ix = 0; ix < N; ix++) {
            const x0 = -half + ix * step;
            const x1 = x0 + step;
            const y0 = -half + iy * step;
            const y1 = y0 + step;
            const z00 = zAt(ix, iy);
            const z10 = zAt(ix + 1, iy);
            const z11 = zAt(ix + 1, iy + 1);
            const z01 = zAt(ix, iy + 1);

            // Downward (-Z) winding: (x0,y0) -> (x0,y1) -> (x1,y1) and (x0,y0) -> (x1,y1) -> (x1,y0)
            tris.push([x0, y0, z00, x0, y1, z01, x1, y1, z11]);
            tris.push([x0, y0, z00, x1, y1, z11, x1, y0, z10]);
        }
    }

    const mesh = buildTriangleSoupMesh(tris);
    const down = new THREE.Vector3(0, 0, -1);

    let maxRawErrDeg = 0;
    let maxBisectorErrDeg = 0;

    for (let s = -2; s <= 2; s++) {
        const ix = N / 2 + s;
        const iy = N / 2;
        const px = -half + (ix + 0.25) * step;
        const py = -half + (iy + 0.75) * step;
        const triIdx = (iy * N + ix) * 2;
        const rawTriNormal = triangleNormalAt(mesh, triIdx);
        assert.ok(rawTriNormal.z < -0.9, 'grid faces downward');

        const p = new THREE.Vector3(px, py, 0);
        const rawRes = synthesizePlacementNormal(mesh, p, rawTriNormal, {
            mode: 'raw',
            contactRadiusMm: 0.4,
        });
        const bisectorRes = synthesizePlacementNormal(mesh, p, rawTriNormal, {
            mode: 'bisector',
            contactRadiusMm: 0.4,
        });

        assert.equal(rawRes.regime, 'raw');
        assert.equal(bisectorRes.regime, 'flat');
        assert.ok(bisectorRes.acceptedSphereTris > 4, `expected >4 tris in sphere, got ${bisectorRes.acceptedSphereTris}`);

        maxRawErrDeg = Math.max(maxRawErrDeg, angleDeg(rawRes.normal, down));
        maxBisectorErrDeg = Math.max(maxBisectorErrDeg, angleDeg(bisectorRes.normal, down));
    }

    assert.ok(maxRawErrDeg > 1.5, `expected raw diagonal ripple jitter > 1.5°, got ${maxRawErrDeg.toFixed(3)}°`);
    assert.ok(maxBisectorErrDeg < 0.6, `expected bisector convergence < 0.6°, got ${maxBisectorErrDeg.toFixed(3)}°`);

    // Overflow (>256 tris inside sphere) stays bounded and deterministic across repeated evaluations
    const targetOut: { normal: THREE.Vector3; regime: 'raw' | 'flat' | 'edge-bisector' | 'curved'; acceptedSphereTris: number } = {
        normal: new THREE.Vector3(),
        regime: 'raw',
        acceptedSphereTris: 0,
    };
    const overflowA = synthesizePlacementNormal(mesh, new THREE.Vector3(0, 0, 0), down, {
        mode: 'macro-smooth',
        contactRadiusMm: 1.25, // R = 2.5 mm over 0.4 mm cells -> >300 tris inside sphere
    }, targetOut);
    assert.ok(overflowA.acceptedSphereTris > 256, `expected >256 tris for overflow check, got ${overflowA.acceptedSphereTris}`);
    assert.ok(angleDeg(overflowA.normal, down) < 0.5);
    const firstNormal = overflowA.normal.clone();
    const overflowB = synthesizePlacementNormal(mesh, new THREE.Vector3(0, 0, 0), down, {
        mode: 'macro-smooth',
        contactRadiusMm: 1.25,
    });
    assert.equal(overflowB.acceptedSphereTris, overflowA.acceptedSphereTris);
    assert.ok(firstNormal.distanceTo(overflowB.normal) < 1e-12);
});

test('2. 90° convex cube edge: face interior preserved, midpoint & deadband converge to 45° bisector, continuous across seam', () => {
    const mesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 10));
    const faceDown = new THREE.Vector3(0, 0, -1);
    const faceRight = new THREE.Vector3(1, 0, 0);
    const bisector45 = new THREE.Vector3(1, 0, -1).normalize();
    const opts = { mode: 'bisector' as const, contactRadiusMm: 0.15 };

    // Far inside flat face (distance to edge 0.50 mm > W_blend 0.30 mm): preserves face normal
    const interior = synthesizePlacementNormal(mesh, new THREE.Vector3(4.5, 0, -5), faceDown, opts);
    assert.ok(interior.normal.dot(faceDown) > 0.9999, `interior dot=${interior.normal.dot(faceDown)}`);
    assert.equal(interior.regime, 'flat');

    // Inside edge deadband (d = 0.05 mm <= 0.1125 mm) and at crease midpoint (d = 0): converges to 45° bisector
    const inDeadband = synthesizePlacementNormal(mesh, new THREE.Vector3(4.95, 0, -5), faceDown, opts);
    const atMidpoint = synthesizePlacementNormal(mesh, new THREE.Vector3(5.0, 0, -5), faceDown, opts);
    assert.ok(angleDeg(inDeadband.normal, bisector45) < 1.0, `deadband bisector err=${angleDeg(inDeadband.normal, bisector45)}°`);
    assert.ok(angleDeg(atMidpoint.normal, bisector45) < 1.0, `midpoint bisector err=${angleDeg(atMidpoint.normal, bisector45)}°`);
    assert.equal(atMidpoint.regime, 'edge-bisector');

    // Crease-lock (55° dihedral) preserves face normal right next to the 90° edge
    const creaseLock = synthesizePlacementNormal(mesh, new THREE.Vector3(4.95, 0, -5), faceDown, {
        mode: 'crease-lock',
        contactRadiusMm: 0.15,
    });
    assert.ok(creaseLock.normal.dot(faceDown) > 0.9999, 'crease-lock rejects 90° adjacent wall');
    assert.equal(creaseLock.regime, 'flat');

    // Continuity sweep around the corner from (4.5, 0, -5) -> (5, 0, -5) -> (5, 0, -4.5) at 0.01 mm steps
    const samples: THREE.Vector3[] = [];
    for (let x = 4.5; x <= 5.0001; x += 0.01) {
        samples.push(synthesizePlacementNormal(mesh, new THREE.Vector3(x, 0, -5), faceDown, opts).normal);
    }
    for (let z = -4.99; z <= -4.5; z += 0.01) {
        samples.push(synthesizePlacementNormal(mesh, new THREE.Vector3(5, 0, z), faceRight, opts).normal);
    }
    for (let i = 1; i < samples.length; i++) {
        const stepAngle = angleDeg(samples[i - 1], samples[i]);
        assert.ok(stepAngle < 4.5, `step ${i} jump ${stepAngle.toFixed(2)}° exceeds continuity bound`);
    }

    // Contrast: 'raw' jumps 90° right across the crease boundary
    const rawBefore = synthesizePlacementNormal(mesh, new THREE.Vector3(4.99, 0, -5), faceDown, {
        mode: 'raw',
        contactRadiusMm: 0.15,
    });
    const rawAfter = synthesizePlacementNormal(mesh, new THREE.Vector3(5, 0, -4.99), faceRight, {
        mode: 'raw',
        contactRadiusMm: 0.15,
    });
    assert.ok(angleDeg(rawBefore.normal, rawAfter.normal) > 89.9, 'raw mode jumps 90° across crease');
});

test('3. 20x asymmetric sliver triangle density remains area/cluster-invariant within 0.1°', () => {
    const tris: Array<[number, number, number, number, number, number, number, number, number]> = [];
    // Bottom face (z = 0, x in [-4, 0], y in [-2, 2], outward -Z): 2 large triangles
    tris.push([-4, -2, 0, -4, 2, 0, 0, 2, 0]);
    tris.push([-4, -2, 0, 0, 2, 0, 0, -2, 0]);

    // Adjacent side face (x = 0, z in [0, 4], y in [-2, 2], outward +X): 20 narrow strips along y in [-1, 1]
    const strips = 20;
    for (let i = 0; i < strips; i++) {
        const y0 = -2 + (4 * i) / strips;
        const y1 = -2 + (4 * (i + 1)) / strips;
        // Outward +X: (0, y0, 0) -> (0, y1, 0) -> (0, y1, 4)
        tris.push([0, y0, 0, 0, y1, 0, 0, y1, 4]);
        tris.push([0, y0, 0, 0, y1, 4, 0, y0, 4]);
    }

    const mesh = buildTriangleSoupMesh(tris);
    const bisector45 = new THREE.Vector3(1, 0, -1).normalize();
    const edgePt = new THREE.Vector3(0, 0, 0);
    const rawDown = new THREE.Vector3(0, 0, -1);

    const bisectorRes = synthesizePlacementNormal(mesh, edgePt, rawDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
    });
    assert.ok(
        angleDeg(bisectorRes.normal, bisector45) < 0.1,
        `expected cluster bisector within 0.1° of 45°, got ${angleDeg(bisectorRes.normal, bisector45).toFixed(4)}°`,
    );

    // Also verify macro-smooth area weighting on symmetric 1x vs 20x tessellated tilted patches inside r << R
    const macroMeshSymmetric = buildTriangleSoupMesh([
        [-0.2, -0.05, 0, -0.2, 0.05, 0, 0, 0.05, 0],
        [-0.2, -0.05, 0, 0, 0.05, 0, 0, -0.05, 0],
        [0, -0.05, 0, 0, 0.05, 0, 0.2, 0.05, 0.06],
        [0, -0.05, 0, 0.2, 0.05, 0.06, 0.2, -0.05, 0.06],
    ]);
    const macroSliverTris: Array<[number, number, number, number, number, number, number, number, number]> = [
        [-0.2, -0.05, 0, -0.2, 0.05, 0, 0, 0.05, 0],
        [-0.2, -0.05, 0, 0, 0.05, 0, 0, -0.05, 0],
    ];
    for (let i = 0; i < 20; i++) {
        const y0 = -0.05 + (0.1 * i) / 20;
        const y1 = -0.05 + (0.1 * (i + 1)) / 20;
        macroSliverTris.push([0, y0, 0, 0, y1, 0, 0.2, y1, 0.06]);
        macroSliverTris.push([0, y0, 0, 0.2, y1, 0.06, 0.2, y0, 0.06]);
    }
    const macroMeshSliver = buildTriangleSoupMesh(macroSliverTris);
    const macroA = synthesizePlacementNormal(macroMeshSymmetric, new THREE.Vector3(0, 0, 0), rawDown, {
        mode: 'macro-smooth',
        contactRadiusMm: 0.25,
    });
    const macroB = synthesizePlacementNormal(macroMeshSliver, new THREE.Vector3(0, 0, 0), rawDown, {
        mode: 'macro-smooth',
        contactRadiusMm: 0.25,
    });
    assert.ok(
        angleDeg(macroA.normal, macroB.normal) < 0.1,
        `expected area-weighted macro-smooth within 0.1° across 20x slivers, got ${angleDeg(macroA.normal, macroB.normal).toFixed(4)}°`,
    );
});

test('4. 0.4 mm thinplate, 140° knife-edge, and behind-plane shell back-face rejected by dihedral + behind-plane guard', () => {
    // (a) 0.4 mm thinplate: bottom face z=0 (-Z), top face z=+0.4 (+Z)
    const thinPlateMesh = buildTriangleSoupMesh([
        [-2, -2, 0, -2, 2, 0, 2, 2, 0],
        [-2, -2, 0, 2, 2, 0, 2, -2, 0],
        [-2, -2, 0.4, 2, 2, 0.4, -2, 2, 0.4],
        [-2, -2, 0.4, 2, -2, 0.4, 2, 2, 0.4],
    ]);
    const down = new THREE.Vector3(0, 0, -1);
    const thinRes = synthesizePlacementNormal(thinPlateMesh, new THREE.Vector3(0, 0, 0), down, {
        mode: 'bisector',
        contactRadiusMm: 0.25, // R = 0.50 > 0.40 mm plate thickness
    });
    assert.equal(thinRes.acceptedSphereTris, 2, 'top thinplate face rejected by 125° dihedral');
    assert.ok(thinRes.normal.dot(down) > 0.9999);

    // (b) 140° knife-edge overhang fold: bottom (-Z) at z=0, top-back face folds 140° back above
    // Normal at 140° from (0,0,-1): (sin 140°, 0, -cos 140°) = (0.6428, 0, +0.7660)
    // Plane through x=0, z=0 folding back into x<=0, z>=0: v=(0,±2,0) -> (-cos40°, ±2, +sin40°)
    const rad40 = THREE.MathUtils.degToRad(40);
    const bx = -Math.cos(rad40);
    const bz = Math.sin(rad40);
    const knifeMesh = buildTriangleSoupMesh([
        [-0.5, -0.5, 0, -0.5, 0.5, 0, 0, 0.5, 0],
        [-0.5, -0.5, 0, 0, 0.5, 0, 0, -0.5, 0],
        [0, -0.5, 0, 0, 0.5, 0, bx, 0.5, bz],
        [0, -0.5, 0, bx, 0.5, bz, bx, -0.5, bz],
    ]);
    const knifeRes = synthesizePlacementNormal(knifeMesh, new THREE.Vector3(-0.05, 0, 0), down, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
    });
    assert.equal(knifeRes.acceptedSphereTris, 2, '140° knife-edge back face rejected');
    assert.ok(knifeRes.normal.dot(down) > 0.9999);

    // (c) Behind-plane opposite wall (100° dihedral passes cos(125°), sits at z = +0.2 behind front face):
    // n_t = (sin 100°, 0, -cos 100°) = (0.9848, 0, +0.1736), q_t = (0, 0, +0.2)
    // dot(n_t, n_0) = -0.1736 < 0.1; (q_t - p)·n_0 = -0.2 < -0.05; (p - q_t)·n_t = -0.0347 < 0
    const rad10 = THREE.MathUtils.degToRad(10);
    const wallTopZ = 0.2 + Math.cos(rad10);
    const wallTopX = -Math.sin(rad10);
    const behindMesh = buildTriangleSoupMesh([
        [-2, -2, 0, -2, 2, 0, 2, 2, 0],
        [-2, -2, 0, 2, 2, 0, 2, -2, 0],
        [0, -2, 0.2, wallTopX, 2, wallTopZ, wallTopX, -2, wallTopZ],
        [0, -2, 0.2, 0, 2, 0.2, wallTopX, 2, wallTopZ],
    ]);
    const behindRes = synthesizePlacementNormal(behindMesh, new THREE.Vector3(0, 0, 0), down, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
    });
    assert.equal(behindRes.acceptedSphereTris, 2, 'behind-plane opposite wall rejected by guard');
    assert.ok(behindRes.normal.dot(down) > 0.9999);
});

test('5. mirrored and non-uniformly scaled rotated cube returns outward non-inverted normal', () => {
    const mesh = makeNonIndexedMesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.scale.set(-1, 2, 0.5);
    mesh.rotation.set(0.35, -0.6, 0.45);
    mesh.position.set(12, -5, 8);
    mesh.updateMatrixWorld(true);

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const expectedFaceA = new THREE.Vector3(1, 0, 0).applyMatrix3(normalMatrix).normalize();
    const expectedFaceB = new THREE.Vector3(0, 0, -1).applyMatrix3(normalMatrix).normalize();
    const expectedEdgeBisector = new THREE.Vector3().addVectors(expectedFaceA, expectedFaceB).normalize();

    const worldFacePoint = new THREE.Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld);
    const faceRes = synthesizePlacementNormal(mesh, worldFacePoint, expectedFaceA, {
        mode: 'bisector',
        contactRadiusMm: 0.2,
    });
    assert.ok(faceRes.acceptedSphereTris >= 2, `expected mirrored face tris >= 2, got ${faceRes.acceptedSphereTris}`);
    assert.ok(faceRes.normal.dot(expectedFaceA) > 0.9999, 'mirrored face normal matches outward normal');
    assert.ok(
        faceRes.normal.dot(worldFacePoint.clone().sub(mesh.position)) > 0,
        'mirrored face normal points outward away from cube center',
    );

    const worldEdgePoint = new THREE.Vector3(1, 0, -1).applyMatrix4(mesh.matrixWorld);
    const edgeRes = synthesizePlacementNormal(mesh, worldEdgePoint, expectedFaceA, {
        mode: 'bisector',
        contactRadiusMm: 0.2,
    });
    assert.ok(
        angleDeg(edgeRes.normal, expectedEdgeBisector) < 0.5,
        `expected mirrored edge bisector within 0.5°, got ${angleDeg(edgeRes.normal, expectedEdgeBisector).toFixed(3)}°`,
    );
    assert.ok(
        edgeRes.normal.dot(worldEdgePoint.clone().sub(mesh.position)) > 0,
        'mirrored edge bisector points outward',
    );
});

test('6. isDiskHudDrag: true disables deadband and clamps angular step to maxDragStepDeg (15°)', () => {
    const mesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 10));
    const faceDown = new THREE.Vector3(0, 0, -1);
    const faceRight = new THREE.Vector3(1, 0, 0);

    // At contactRadiusMm=0.25 -> D_disk=0.50, W_blend=0.375, static deadband=0.1875
    const p1 = new THREE.Vector3(4.90, 0, -5); // d = 0.10 mm
    const p2 = new THREE.Vector3(4.98, 0, -5); // d = 0.02 mm

    const static1 = synthesizePlacementNormal(mesh, p1, faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: false,
    });
    const static2 = synthesizePlacementNormal(mesh, p2, faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: false,
    });
    assert.ok(angleDeg(static1.normal, static2.normal) < 1e-4, 'static deadband locks both to bisector');

    const drag1 = synthesizePlacementNormal(mesh, p1, faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: true,
    });
    const drag2 = synthesizePlacementNormal(mesh, p2, faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: true,
    });
    assert.ok(
        angleDeg(drag1.normal, drag2.normal) > 2.0,
        `drag deadband=0 must differentiate d=0.10 vs d=0.02 (delta=${angleDeg(drag1.normal, drag2.normal).toFixed(2)}°)`,
    );

    // 90° jump clamped to <= 15° per frame
    const stepRes = synthesizePlacementNormal(mesh, new THREE.Vector3(5, 0, -4), faceRight, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: true,
        prevNormal: faceDown,
        maxDragStepDeg: 15,
    });
    const stepDelta = angleDeg(faceDown, stepRes.normal);
    assert.ok(stepDelta <= 15.001 && stepDelta >= 14.9, `expected 15° SLERP step, got ${stepDelta.toFixed(4)}°`);

    // 180° antipodal jump falls back orthogonally cleanly within <= 15°
    const antipodalRes = synthesizePlacementNormal(mesh, new THREE.Vector3(0, 0, -5), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        isDiskHudDrag: true,
        prevNormal: new THREE.Vector3(0, 0, 1),
        maxDragStepDeg: 15,
    });
    assert.ok(Number.isFinite(antipodalRes.normal.x) && Math.abs(antipodalRes.normal.length() - 1) < 1e-6);
    assert.ok(angleDeg(new THREE.Vector3(0, 0, 1), antipodalRes.normal) <= 15.001);
});

test('7. #797 isolation preserves renderGeometry normals, raw skips shapecast, missing boundsTree falls back cleanly', () => {
    const renderGeometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    renderGeometry.computeVertexNormals();
    const raycastGeometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    raycastGeometry.computeVertexNormals();
    attachBvh(raycastGeometry);

    const renderNormalsBefore = new Float32Array(renderGeometry.attributes.normal.array as Float32Array);
    const raycastNormalsBefore = new Float32Array(raycastGeometry.attributes.normal.array as Float32Array);

    const mesh = new THREE.Mesh(renderGeometry);
    mesh.userData = { raycastGeometry };
    mesh.updateMatrixWorld(true);

    let shapecastCalls = 0;
    const bvh = (raycastGeometry as BvhGeometry).boundsTree!;
    const origShapecast = bvh.shapecast.bind(bvh);
    bvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
        shapecastCalls += 1;
        return origShapecast(...args);
    }) as MeshBVH['shapecast'];

    // 'raw' mode performs 0 shapecast calls
    const rawRes = synthesizePlacementNormal(
        mesh,
        new THREE.Vector3(4.95, 0, -5),
        new THREE.Vector3(0, 0, -2),
        { mode: 'raw', contactRadiusMm: 0.2 },
    );
    assert.equal(shapecastCalls, 0, 'raw mode must not call shapecast');
    assert.equal(rawRes.regime, 'raw');
    assert.equal(rawRes.acceptedSphereTris, 0);
    assert.ok(Math.abs(rawRes.normal.length() - 1) < 1e-6);
    assert.ok(rawRes.normal.z < -0.9999);

    // Non-raw queries raycastGeometry (even though renderGeometry lacks boundsTree) and never mutate normals
    for (const mode of ['bisector', 'crease-lock', 'macro-smooth'] as const) {
        const res = synthesizePlacementNormal(
            mesh,
            new THREE.Vector3(4.95, 0, -5),
            new THREE.Vector3(0, 0, -1),
            { mode, contactRadiusMm: 0.2 },
        );
        assert.ok(res.acceptedSphereTris > 0);
    }
    assert.equal(shapecastCalls, 3);

    const renderNormalsAfter = renderGeometry.attributes.normal.array as Float32Array;
    const raycastNormalsAfter = raycastGeometry.attributes.normal.array as Float32Array;
    assert.deepEqual(renderNormalsAfter, renderNormalsBefore, 'renderGeometry.attributes.normal untouched (#797)');
    assert.deepEqual(raycastNormalsAfter, raycastNormalsBefore, 'raycastGeometry.attributes.normal untouched');

    // Missing boundsTree fallback
    const noBvhMesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 10), false);
    const fallbackRes = synthesizePlacementNormal(
        noBvhMesh,
        new THREE.Vector3(4.95, 0, -5),
        new THREE.Vector3(0, 0, -3),
        { mode: 'bisector', contactRadiusMm: 0.2 },
    );
    assert.equal(fallbackRes.regime, 'raw');
    assert.equal(fallbackRes.acceptedSphereTris, 0);
    assert.ok(fallbackRes.normal.dot(new THREE.Vector3(0, 0, -1)) > 0.9999);
    assert.equal((noBvhMesh.geometry as BvhGeometry).boundsTree, undefined, 'must not lazily attach boundsTree');
});

test('8. G2 50 mm coarse sphere cap weights closest-point distance d_t accurately, bounds n_z <= sin(5°), and shares 1 shapecast', () => {
    const maxUpwardSin = Math.sin((5 * Math.PI) / 180);

    // 50 mm diameter coarse sphere (radius = 25 mm, very coarse triangles whose centroids are >10 mm away)
    const sphereMesh = makeNonIndexedMesh(new THREE.SphereGeometry(25, 6, 4));
    const sphereBvh = (sphereMesh.geometry as BvhGeometry).boundsTree!;

    // Pick an exact point on the coarse 50 mm sphere surface near the lower equator (z < 0, n_z ≈ 0)
    const closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
    const hitInfo = sphereBvh.closestPointToPoint(new THREE.Vector3(24, 0, -4), closestTarget);
    assert.ok(hitInfo, 'coarse sphere closest point found');
    const samplePt = hitInfo.point.clone();
    const rawEquatorialDown = samplePt.clone().normalize();
    if (rawEquatorialDown.z > 0) rawEquatorialDown.z = -0.05;
    rawEquatorialDown.normalize();

    let capShapecasts = 0;
    const origShapecast = sphereBvh.shapecast.bind(sphereBvh);
    sphereBvh.shapecast = ((...args: Parameters<MeshBVH['shapecast']>) => {
        capShapecasts += 1;
        return origShapecast(...args);
    }) as MeshBVH['shapecast'];

    const combined = resolvePlacementNormalAndCap(sphereMesh, samplePt, rawEquatorialDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        leafRimSlackDeg: 10,
    });
    assert.equal(capShapecasts, 1, 'resolvePlacementNormalAndCap must reuse a single shapecast');
    assert.ok(combined.cap.downwardTriCount > 0, 'coarse 50 mm sphere triangles near sample must be captured via closest-point d_t');
    assert.ok(combined.cap.nMean.z <= maxUpwardSin + 1e-12, `nMean.z=${combined.cap.nMean.z} exceeded sin(5°)`);

    // Pulling candidateKnot steeply upward (+Z) must still stay bounded n_z <= sin(5°)
    const upwardKnot = samplePt.clone().add(new THREE.Vector3(1, 0, 5));
    const orbited = resolveKnotWeightedCapNormal(
        samplePt,
        upwardKnot,
        combined.cap,
        rawEquatorialDown,
        combined.synthesis.normal,
        THREE.MathUtils.degToRad(45),
    );
    assert.ok(Math.abs(orbited.length() - 1) < 1e-6);
    assert.ok(orbited.z <= maxUpwardSin, `orbited normal z=${orbited.z} exceeded sin(5°)=${maxUpwardSin}`);

    // Verify closest-point K(u) = (1 - d_t / R_cap)^2 weighting on two 50 mm giant triangles (centroids > 15 mm away!)
    // Tri 0 at d_0 = 0 (n = (0, 0, -1)), Tri 1 at d_1 = 0.225 mm (n = (1, 0, -1)/sqrt(2)):
    // For contactRadiusMm=0.15 (D_disk=0.30, R_cap=0.45): u0=0 -> K=1.0, u1=0.5 -> K=0.25 -> 4:1 blend!
    const giantMesh = buildTriangleSoupMesh([
        [-50, -25, 0, 0, 25, 0, 0, -25, 0],
        [0.225, -25, 0, 0.225, 25, 0, 50.225, 25, 50],
    ]);
    const capGiant = extractSphericalCapDescriptor(giantMesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 0.15, 0);
    assert.equal(capGiant.downwardTriCount, 2);
    const n0 = new THREE.Vector3(0, 0, -1);
    const n1 = new THREE.Vector3(1, 0, -1).normalize();
    const expectedMean = n0.clone().multiplyScalar(1.0).addScaledVector(n1, 0.25).normalize();
    assert.ok(
        angleDeg(capGiant.nMean, expectedMean) < 0.05,
        `expected K(u)=(1-d/R)^2 4:1 closest-point weight on 50 mm tris, got err=${angleDeg(capGiant.nMean, expectedMean).toFixed(4)}°`,
    );

    // Verify concavity test disables rimSlackDeg on concave groove while keeping it on convex ridge
    const concaveMesh = buildTriangleSoupMesh([
        [-2, -2, -1, 0, 2, 0, 0, -2, 0],
        [0, -2, 0, 0, 2, 0, 2, 2, -1],
    ]);
    const concaveCap = extractSphericalCapDescriptor(concaveMesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 0.2, 12);
    assert.equal(concaveCap.downwardTriCount, 2);
    assert.equal(concaveCap.isConcave, true);
    assert.equal(concaveCap.rimSlackRad, 0, 'concave groove must force rimSlackRad to 0');

    const convexMesh = buildTriangleSoupMesh([
        [-2, -2, 1, 0, 2, 0, 0, -2, 0],
        [0, -2, 0, 0, 2, 0, 2, 2, 1],
    ]);
    const convexCap = extractSphericalCapDescriptor(convexMesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 0.2, 12);
    assert.equal(convexCap.downwardTriCount, 2);
    assert.equal(convexCap.isConcave, false);
    assert.ok(convexCap.rimSlackRad > 0, 'convex ridge retains rimSlackRad');
});

test('9. Upgrade A: tau_i=(1-u_i)^2 prevents asymmetric inward overshoot on 90° slab+wall perimeter at d=0.15 mm with leafRimSlackDeg=0', () => {
    // Slab bottom face (z = 0, x in [-4, 0], normal (0, 0, -1)) meeting a vertical wall (x = 0, z in [0, 4], normal (1, 0, 0))
    const slabWallMesh = buildTriangleSoupMesh([
        [-4, -2, 0, -4, 2, 0, 0, 2, 0],
        [-4, -2, 0, 0, 2, 0, 0, -2, 0],
        [0, -2, 0, 0, 2, 0, 0, 2, 4],
        [0, -2, 0, 0, 2, 4, 0, -2, 4],
    ]);

    const tipPos = new THREE.Vector3(-0.15, 0, 0);
    const rawDown = new THREE.Vector3(0, 0, -1);
    const cap = extractSphericalCapDescriptor(slabWallMesh, tipPos, rawDown, 0.15, 0);

    // At d=0.15 mm with R_cap=0.45 mm: u_wall=1/3, K=(2/3)^2=4/9 -> nMean angle ~23.96 deg,
    // attenuated thetaSpreadRad = (4/9)*(90-23.96) = ~29.35 deg (without tau it was ~66 deg -> 45 deg cap).
    assert.equal(cap.downwardTriCount, 2);
    assert.equal(cap.rimSlackRad, 0);
    assert.ok(
        THREE.MathUtils.radToDeg(cap.thetaSpreadRad) < 31,
        `expected radially attenuated thetaSpreadRad < 31°, got ${THREE.MathUtils.radToDeg(cap.thetaSpreadRad).toFixed(2)}°`,
    );

    // Orbiting toward a modestly inward knot (x = -0.8, z = -5) must keep zero inward overshoot (orbited.x >= 0)
    const inwardKnot = new THREE.Vector3(-0.8, 0, -5);
    const orbited = resolveKnotWeightedCapNormal(
        tipPos,
        inwardKnot,
        cap,
        rawDown,
        rawDown,
        THREE.MathUtils.degToRad(45),
    );
    assert.ok(
        orbited.x >= 0,
        `expected zero inward overshoot (orbited.x >= 0) on 90° slab+wall perimeter, got x=${orbited.x}`,
    );
});

test('10. Upgrade B: 96°-125° sloped-cantilever +Y lip expands cap only in resolvePlacementNormalAndCap while extractSphericalCapDescriptor stays untouched', () => {
    // Underside z = 0 (y in [-4, 0], normal (0, 0, -1)) meeting a 110° tapered wall along y = 0 (+Y lip):
    // n_wall = (0, sin(110°), -cos(110°)) = (0, +0.9397, +0.3420) -> n_wall.z > sin(5°) so cap pool alone rejects wall!
    const dihedralRad = THREE.MathUtils.degToRad(110);
    const wallDy = Math.cos(dihedralRad - Math.PI / 2); // cos(20°) along +Y? Wait: edge along X, wall goes from y=0 upward/outward
    const wallDz = Math.sin(dihedralRad - Math.PI / 2); // sin(20°) = +0.3420? Check cross product!
    // Edge from (-2,0,0) to (2,0,0): let third vertex be (0, -wallDy, wallDz) vs (0, wallDy, wallDz)
    // Wait: for wall face starting at y=0, z=0 going to y = +cos(70°)? Wait: wall angle from -Z is 110°:
    // n_wall = (0, sin(110°), -cos(110°)) = (0, 0.9397, 0.3420).
    // Tangent from y=0,z=0 perpendicular to n_wall going upward (+Z): (0, -0.3420, +0.9397) = (0, -cos(70°), sin(70°))!
    // Cross((-2,0,0)->(2,0,0) = (4,0,0), (0, -0.3420, 0.9397)*4) -> (0, -3.7588, -1.368) -> opposite!
    // So reverse order: (2,0,0)->(-2,0,0) cross (0, -0.3420, 0.9397): (-4,0,0) x (0,-0.342,0.940) = (0, +3.7588, +1.368) -> outward (0, +0.9397, +0.3420)!
    void wallDy;
    void wallDz;
    const slopeAngle = THREE.MathUtils.degToRad(110);
    const ty = Math.cos(slopeAngle); // -0.3420
    const tz = Math.sin(slopeAngle); // +0.9397
    const cantileverMesh = buildTriangleSoupMesh([
        [-2, -4, 0, -2, 0, 0, 2, 0, 0],
        [-2, -4, 0, 2, 0, 0, 2, -4, 0],
        [2, 0, 0, -2, 0, 0, -2, ty * 4, tz * 4],
        [2, 0, 0, -2, ty * 4, tz * 4, 2, ty * 4, tz * 4],
    ]);

    const lipPt = new THREE.Vector3(0, -0.02, 0);
    const rawDown = new THREE.Vector3(0, 0, -1);

    const standaloneCap = extractSphericalCapDescriptor(cantileverMesh, lipPt, rawDown, 0.25, 0);
    assert.ok(standaloneCap.downwardTriCount > 0);
    assert.ok(standaloneCap.nMean.y < 1e-6, `standalone extractSphericalCapDescriptor must remain untouched (nMean.y=${standaloneCap.nMean.y})`);
    assert.ok(standaloneCap.thetaSpreadRad < 1e-6, `standalone thetaSpreadRad must stay 0, got ${standaloneCap.thetaSpreadRad}`);

    const combined = resolvePlacementNormalAndCap(cantileverMesh, lipPt, rawDown, {
        mode: 'bisector',
        contactRadiusMm: 0.25,
        leafRimSlackDeg: 0,
    });
    assert.equal(combined.synthesis.regime, 'edge-bisector');
    assert.ok(combined.cap.nMean.y > 0.35, `expected Upgrade B to expand cap.nMean toward +Y, got nMean.y=${combined.cap.nMean.y}`);
    assert.ok(combined.cap.thetaSpreadRad > THREE.MathUtils.degToRad(20), `expected Upgrade B to expand thetaSpreadRad, got ${THREE.MathUtils.radToDeg(combined.cap.thetaSpreadRad)}°`);

    const anchor = buildLeafCapAnchor(lipPt, combined.cap, combined.synthesis.normal);
    assert.ok(anchor, 'expected valid LeafCapAnchor on sloped-cantilever lip');
    const target = { x: 0, y: 0, z: 0 };
    const orbitedOut = orbitLeafCapAnchorTowardKnot(lipPt, new THREE.Vector3(0, 4, -3), anchor, THREE.MathUtils.degToRad(45), target);
    assert.equal(orbitedOut, target, 'orbitLeafCapAnchorTowardKnot must write into target in-place');
    assert.ok(orbitedOut.y > 0.5, `expected orbited normal to follow +Y knot along expanded cap, got y=${orbitedOut.y}`);
    assert.ok(orbitedOut.z <= Math.sin(THREE.MathUtils.degToRad(5)) + 1e-12);

    // buildLeafCapAnchor returns undefined when downwardTriCount === 0 and baseSynthesisNormal.z > sin(5°)
    const emptyCap = { ...combined.cap, downwardTriCount: 0 };
    assert.equal(buildLeafCapAnchor(lipPt, emptyCap, { x: 0, y: 0, z: 0.5 }), undefined);
    assert.ok(buildLeafCapAnchor(lipPt, emptyCap, { x: 0, y: 0, z: -1 }), 'downward baseNormal builds fallback anchor even when downwardTriCount === 0');
});

test('11. synthesizePlacementNormal populates thetaSpreadRad and isConcave on convex edge, concave L-valley, flat, and raw', () => {
    const faceDown = new THREE.Vector3(0, 0, -1);

    // (a) Flat face -> thetaSpreadRad === 0, isConcave === false
    const cubeMesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 10));
    const flatRes = synthesizePlacementNormal(cubeMesh, new THREE.Vector3(0, 0, -5), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.15,
    });
    assert.equal(flatRes.regime, 'flat');
    assert.equal(flatRes.thetaSpreadRad, 0);
    assert.equal(flatRes.isConcave, false);

    // (b) 'raw' mode and missing-BVH fallback -> thetaSpreadRad === 0, isConcave === false
    const rawRes = synthesizePlacementNormal(cubeMesh, new THREE.Vector3(5, 0, -5), faceDown, {
        mode: 'raw',
        contactRadiusMm: 0.15,
    });
    assert.equal(rawRes.regime, 'raw');
    assert.equal(rawRes.thetaSpreadRad, 0);
    assert.equal(rawRes.isConcave, false);

    const noBvhMesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 10), false);
    const fallbackRes = synthesizePlacementNormal(noBvhMesh, new THREE.Vector3(5, 0, -5), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.15,
    });
    assert.equal(fallbackRes.regime, 'raw');
    assert.equal(fallbackRes.thetaSpreadRad, 0);
    assert.equal(fallbackRes.isConcave, false);

    // (c) 90° convex cube edge -> thetaSpreadRad ≈ 45° at crease, isConcave === false
    const convexEdgeRes = synthesizePlacementNormal(cubeMesh, new THREE.Vector3(5, 0, -5), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.15,
    });
    assert.equal(convexEdgeRes.regime, 'edge-bisector');
    assert.equal(convexEdgeRes.isConcave, false);
    assert.ok(
        Math.abs((convexEdgeRes.thetaSpreadRad ?? -1) - Math.PI / 4) < 1e-4,
        `expected 45° spread at 90° convex crease, got ${THREE.MathUtils.radToDeg(convexEdgeRes.thetaSpreadRad ?? 0)}°`,
    );

    // Away from crease (d=0.15, r=0.45 -> u=1/3, tau=4/9) radially attenuates thetaSpreadRad
    const convexNearRes = synthesizePlacementNormal(cubeMesh, new THREE.Vector3(4.85, 0, -5), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.15,
    });
    assert.equal(convexNearRes.isConcave, false);
    assert.ok((convexNearRes.thetaSpreadRad ?? 0) > 0 && (convexNearRes.thetaSpreadRad ?? 10) < Math.PI / 4);

    // (d) 90° concave L-valley: bottom z=0 (x in [-4,0], outward -Z) meeting wall x=0 (z in [-4,0], outward -X)
    const concaveMesh = buildTriangleSoupMesh([
        [-4, -2, 0, -4, 2, 0, 0, 2, 0],
        [-4, -2, 0, 0, 2, 0, 0, -2, 0],
        [0, -2, 0, 0, 2, 0, 0, 2, -4],
        [0, -2, 0, 0, 2, -4, 0, -2, -4],
    ]);
    const concaveRes = synthesizePlacementNormal(concaveMesh, new THREE.Vector3(0, 0, 0), faceDown, {
        mode: 'bisector',
        contactRadiusMm: 0.15,
    });
    assert.equal(concaveRes.regime, 'edge-bisector');
    assert.equal(concaveRes.isConcave, true);
    assert.ok(
        Math.abs((concaveRes.thetaSpreadRad ?? -1) - Math.PI / 4) < 1e-4,
        `expected 45° spread at 90° concave L-valley, got ${THREE.MathUtils.radToDeg(concaveRes.thetaSpreadRad ?? 0)}°`,
    );
});

test('12. computeThinWallMaxSafePenetrationMm measures DoubleSide exit wall cleanly without normal mutation or SDF build', () => {
    // (a) 0.20 mm closed FrontSide wall -> 0.45 * 0.20 = 0.09 mm
    const thinWallMesh = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 0.2));
    thinWallMesh.material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    const thinNormalsBefore = new Float32Array(thinWallMesh.geometry.attributes.normal.array as Float32Array);

    assert.equal(hasWarmSDFCache(thinWallMesh), false);
    const thinPen = computeThinWallMaxSafePenetrationMm(
        thinWallMesh,
        { x: 0, y: 0, z: -0.1 },
        { x: 0, y: 0, z: -1 },
    );
    assert.equal(thinPen, 0.09);
    assert.equal(Object.is(thinPen, -0), false);
    assert.equal(hasWarmSDFCache(thinWallMesh), false, 'must not warm SDFCache');
    assert.deepEqual(thinWallMesh.geometry.attributes.normal.array as Float32Array, thinNormalsBefore, '#797 normal buffer untouched');

    // (b) 3 mm slab -> undefined (exceeds 0.80 mm maxProbeMm)
    const thickSlab = makeNonIndexedMesh(new THREE.BoxGeometry(10, 10, 3));
    assert.equal(
        computeThinWallMaxSafePenetrationMm(thickSlab, { x: 0, y: 0, z: -1.5 }, { x: 0, y: 0, z: -1 }),
        undefined,
    );

    // (c) Mirrored (scale.x = -1), non-uniformly scaled, rotated 0.20 mm wall -> 0.09 mm
    const mirroredWall = makeNonIndexedMesh(new THREE.BoxGeometry(0.2, 10, 10));
    mirroredWall.scale.set(-1, 2, 0.5);
    mirroredWall.rotation.set(0.25, -0.4, 0.35);
    mirroredWall.position.set(5, -3, 2);
    mirroredWall.updateMatrixWorld(true);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mirroredWall.matrixWorld);
    const mirroredWorldPt = new THREE.Vector3(0.1, 0, 0).applyMatrix4(mirroredWall.matrixWorld);
    const mirroredWorldNormal = new THREE.Vector3(1, 0, 0).applyMatrix3(normalMatrix).normalize();
    assert.equal(
        computeThinWallMaxSafePenetrationMm(mirroredWall, mirroredWorldPt, mirroredWorldNormal),
        0.09,
    );
    assert.equal(hasWarmSDFCache(mirroredWall), false);

    // (d) Single PlaneGeometry -> undefined (no opposite exiting wall)
    const singlePlane = makeNonIndexedMesh(new THREE.PlaneGeometry(10, 10));
    assert.equal(
        computeThinWallMaxSafePenetrationMm(singlePlane, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
        undefined,
    );
    assert.equal(
        computeThinWallMaxSafePenetrationMm(singlePlane, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),
        undefined,
    );

    // (e) #797 raycastGeometry isolation + invalid inputs
    const renderGeom = new THREE.BoxGeometry(10, 10, 0.2).toNonIndexed();
    renderGeom.computeVertexNormals();
    const raycastGeom = new THREE.BoxGeometry(10, 10, 0.2).toNonIndexed();
    raycastGeom.computeVertexNormals();
    attachBvh(raycastGeom);
    const renderNormalsBefore = new Float32Array(renderGeom.attributes.normal.array as Float32Array);
    const raycastNormalsBefore = new Float32Array(raycastGeom.attributes.normal.array as Float32Array);
    const splitMesh = new THREE.Mesh(renderGeom);
    splitMesh.userData = { raycastGeometry: raycastGeom };
    splitMesh.updateMatrixWorld(true);
    assert.equal(
        computeThinWallMaxSafePenetrationMm(splitMesh, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: -1 }),
        0.09,
    );
    assert.deepEqual(renderGeom.attributes.normal.array as Float32Array, renderNormalsBefore);
    assert.deepEqual(raycastGeom.attributes.normal.array as Float32Array, raycastNormalsBefore);
    assert.equal(hasWarmSDFCache(splitMesh), false);
    assert.equal(
        computeThinWallMaxSafePenetrationMm(splitMesh, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0 }),
        undefined,
    );

    // (f) Multi-hit skip: intervening same-facing baffle at z=0.05 is skipped before exiting opposite wall at z=0.20
    const multiHitWall = buildTriangleSoupMesh([
        // Entry face z=0 (outward -Z)
        [-2, -2, 0, -2, 2, 0, 2, 2, 0],
        [-2, -2, 0, 2, 2, 0, 2, -2, 0],
        // Intervening baffle z=0.05 (outward -Z, same-facing as entry -> dot <= 0.1 -> skipped)
        [-2, -2, 0.05, -2, 2, 0.05, 2, 2, 0.05],
        [-2, -2, 0.05, 2, 2, 0.05, 2, -2, 0.05],
        // Exit face z=0.20 (outward +Z -> dot > 0.1 -> 0.45 * 0.20 = 0.09)
        [-2, -2, 0.2, 2, 2, 0.2, -2, 2, 0.2],
        [-2, -2, 0.2, 2, -2, 0.2, 2, 2, 0.2],
    ]);
    assert.equal(
        computeThinWallMaxSafePenetrationMm(multiHitWall, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),
        0.09,
    );
});
