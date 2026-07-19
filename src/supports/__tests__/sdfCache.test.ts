import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';

function makeSphereMesh(): THREE.Mesh {
    initializeBVH();
    const geometry = new THREE.SphereGeometry(2, 16, 16);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, 5);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('refreshMatrix reports no drift for an unmoved mesh', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    assert.equal(sdf.refreshMatrix(), false);
    assert.equal(sdf.refreshMatrix(), false);
});

test('refreshMatrix reports drift once after the mesh moves, then settles', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });
    assert.equal(sdf.refreshMatrix(), false);

    mesh.position.set(0, 0, 10);
    mesh.updateMatrixWorld(true);

    assert.equal(sdf.refreshMatrix(), true, 'matrix change must be reported');
    assert.equal(sdf.refreshMatrix(), false, 'drift must be reported only once per change');
});

test('exactSignedDistanceAt measures at the query point, not the quantized cell center', () => {
    initializeBVH();
    // Box 4x4x4 at origin: faces at ±2.
    const geometry = new THREE.BoxGeometry(4, 4, 4);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    // Query at x=2.74: true distance to the x=+2 face is 0.74mm. The grid
    // path substitutes the cell CENTER at x=2.5 (distance 0.5mm) — a 0.24mm
    // error, which is the substitution defect the cone gate tripped over.
    const exact = sdf.exactSignedDistanceAt(2.74, 0, 0);
    const quantized = sdf.distanceAt(2.74, 0, 0);

    assert.ok(Math.abs(exact - 0.74) < 0.02, `exact must be ~0.74, got ${exact}`);
    assert.ok(Math.abs(quantized - 0.5) < 0.02, `grid path substitutes the cell center (~0.5), got ${quantized}`);
});

test('exactSignedDistanceAt signs interior points negative', () => {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(4, 4, 4);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const inside = sdf.exactSignedDistanceAt(1.9, 0, 0);
    assert.ok(Math.abs(inside - -0.1) < 0.02, `interior point must be ~-0.1, got ${inside}`);
});

test('exactSignedDistanceAt respects the mesh world transform', () => {
    const mesh = makeSphereMesh(); // r=2 at (0,0,5)
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const d = sdf.exactSignedDistanceAt(0, 0, 8.13);
    assert.ok(Math.abs(d - 1.13) < 0.05, `expected ~1.13 above the sphere, got ${d}`);
});

test('refreshMatrix invalidates cached distances after a move', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    // Sphere r=2 at (0,0,5): point (0,0,8) is 1mm off the surface.
    const before = sdf.distanceAt(0, 0, 8);
    assert.ok(Math.abs(before - 1) < 0.6, `expected ~1mm, got ${before}`);

    mesh.position.set(0, 0, 10);
    mesh.updateMatrixWorld(true);
    sdf.refreshMatrix();

    // Sphere now at (0,0,10): the same world point is on/inside the sphere.
    const after = sdf.distanceAt(0, 0, 8);
    assert.ok(after <= 0.5, `expected near-zero/inside after move, got ${after}`);
});
