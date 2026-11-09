import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { ColumnClearanceMap } from '../PlacementLogic/Pathfinding/ColumnClearanceMap';
import { buildColumnClearanceSnapshot } from '../PlacementLogic/Pathfinding/columnClearanceBuild';

function makeMesh(): THREE.Mesh {
    initializeBVH();
    const geometry = new THREE.SphereGeometry(2, 16, 16);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(3, 0, 5);
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('a snapshot rebuilt on the other side answers like the map that built it', () => {
    const mesh = makeMesh();
    mesh.updateMatrixWorld(true);
    const positions = mesh.geometry.getAttribute('position').array as Float32Array;
    const snapshot = buildColumnClearanceSnapshot({
        id: 1,
        poseKey: 'test',
        positions: positions.slice(),
        matrix: Array.from(mesh.matrixWorld.elements),
        clearanceMm: 0.9,
        cellMm: 0.2,
    });

    assert.ok(snapshot);
    const direct = ColumnClearanceMap.build(mesh, 0.9, 0.2);
    assert.ok(direct);
    const rebuilt = ColumnClearanceMap.fromSnapshot(snapshot);

    for (const [x, y] of [[3, 0], [4, 0], [3, 1.9], [10, 10]] as const) {
        assert.equal(
            rebuilt.columnVerdict(x, y, 7, 0.5),
            direct.columnVerdict(x, y, 7, 0.5),
            `verdict must match at ${x},${y}`,
        );
    }
    assert.equal(rebuilt.stats.cells, direct.stats.cells);
});
