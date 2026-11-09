import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { ColumnClearanceMap } from '../PlacementLogic/Pathfinding/ColumnClearanceMap';

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

test('a prewarmed clearance is ready without disturbing the one in use', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const built: number[] = [];
    const build = ColumnClearanceMap.build;
    ColumnClearanceMap.build = ((meshArg, clearanceMm, cellMm) => {
        built.push(clearanceMm);
        return build(meshArg, clearanceMm, cellMm);
    }) as typeof ColumnClearanceMap.build;

    try {
        // Hovering at the active preset's clearance, then building the map for a
        // pinned preset while the thread is idle, then switching to it: the
        // switch must find the map already there.
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        sdf.prewarmColumnMap(1.1, 0.2);
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        assert.equal(sdf.enableColumnMap(1.1, 0.2), true);
        assert.deepEqual(built, [0.9, 1.1], 'the switch must reuse the prewarmed map');
    } finally {
        ColumnClearanceMap.build = build;
    }
});

test('a clearance already built is reused instead of built again', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const built: number[] = [];
    const build = ColumnClearanceMap.build;
    ColumnClearanceMap.build = ((meshArg, clearanceMm, cellMm) => {
        built.push(clearanceMm);
        return build(meshArg, clearanceMm, cellMm);
    }) as typeof ColumnClearanceMap.build;

    try {
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        assert.equal(sdf.enableColumnMap(1.4, 0.2), true);
        // The clearance comes from the shaft diameter, so this is the cycle a
        // preset switch makes: away from a preset and back to it. The build is
        // tens of milliseconds over every vertex, and it must not repeat.
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        assert.deepEqual(built, [0.9, 1.4], 'the third call must reuse the map built for 0.9');
    } finally {
        ColumnClearanceMap.build = build;
    }
});

test('columnBlocked gives the segment march verdict for vertical columns', () => {
    const mesh = makeSphereMesh(); // r=2, centre (0,0,5)
    const columnSdf = new SDFCache(mesh, { cellSize: 0.5 });
    const segmentSdf = new SDFCache(mesh, { cellSize: 0.5 });

    let checked = 0;
    for (const clearance of [0.2, 0.6, 1.1]) {
        for (let gx = -4; gx <= 4; gx += 0.7) {
            for (let gy = -4; gy <= 4; gy += 0.7) {
                for (const [top, bottom] of [[8, 0], [6.2, 3.1], [5, 4.5], [9, 8.2]] as const) {
                    checked++;
                    assert.equal(
                        columnSdf.columnBlocked(gx, gy, top, bottom, clearance),
                        segmentSdf.segmentBlocked(gx, gy, top, gx, gy, bottom, clearance),
                        `column (${gx},${gy}) ${top}->${bottom} clearance ${clearance}`,
                    );
                }
            }
        }
    }
    assert.ok(checked > 100, 'the sweep must exercise the column path');
});

test('a model move invalidates the column maps built at the old pose', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const built: number[] = [];
    const build = ColumnClearanceMap.build;
    ColumnClearanceMap.build = ((meshArg, clearanceMm, cellMm) => {
        built.push(clearanceMm);
        return build(meshArg, clearanceMm, cellMm);
    }) as typeof ColumnClearanceMap.build;

    try {
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        mesh.position.set(0, 0, 10);
        mesh.updateMatrixWorld(true);
        assert.equal(sdf.refreshMatrix(), true);
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        assert.deepEqual(built, [0.9, 0.9], 'the map must be rebuilt for the new pose');
    } finally {
        ColumnClearanceMap.build = build;
    }
});

test('an installed worker map is used without building on the main thread', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    const built: number[] = [];
    const build = ColumnClearanceMap.build;
    ColumnClearanceMap.build = ((meshArg, clearanceMm, cellMm) => {
        built.push(clearanceMm);
        return build(meshArg, clearanceMm, cellMm);
    }) as typeof ColumnClearanceMap.build;

    try {
        const map = ColumnClearanceMap.build(mesh, 0.9, 0.2);
        assert.ok(map);
        sdf.installColumnMap(0.9, map);
        assert.equal(sdf.hasColumnMap(0.9, 0.2), true);
        assert.equal(sdf.enableColumnMap(0.9, 0.2), true);
        assert.deepEqual(built, [0.9], 'the installed map must be the only build');
    } finally {
        ColumnClearanceMap.build = build;
    }
});

test('tryUseColumnMap never builds one, enableColumnMap still does', () => {
    const mesh = makeSphereMesh();
    const sdf = new SDFCache(mesh, { cellSize: 0.5 });

    // The placement path calls this on a hover: reporting "no map" must not turn
    // the hover into the whole vertex walk that prewarming exists to avoid.
    assert.equal(sdf.tryUseColumnMap(1.2, 0.2), false, 'a missing map is not built');
    assert.equal(sdf.hasColumnMap(1.2, 0.2), false, 'and it is not cached as a side effect');

    assert.equal(sdf.enableColumnMap(1.2, 0.2), true, 'the explicit call still builds');
    assert.equal(sdf.hasColumnMap(1.2, 0.2), true);

    // Once built, the same clearance is activated rather than rebuilt.
    assert.equal(sdf.tryUseColumnMap(1.2, 0.2), true);
});
