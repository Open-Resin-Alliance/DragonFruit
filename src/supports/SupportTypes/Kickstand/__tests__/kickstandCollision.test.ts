import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { buildKickstandData } from '../kickstandBuilder';
import type { KickstandBuildInput } from '../types';

/** A solid box centred on the origin, 20mm on a side. */
function boxMesh(): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(20, 20, 20).toNonIndexed();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

function inputWithRoot(rootPos: { x: number; y: number; z: number }): KickstandBuildInput {
    return {
        modelId: 'model-1',
        rootPos,
        host: {
            segmentId: 'shaft-1',
            supportKind: 'trunk',
            t: 0.5,
            pos: { x: 0, y: 0, z: 20 },
            diameterMm: 2,
        },
    };
}

test('a column rising through the model reports a collision', () => {
    const build = buildKickstandData({
        // Directly under the box, so the column must pass through it.
        ...inputWithRoot({ x: 0, y: 0, z: 0 }),
        collisionMesh: boxMesh(),
    });
    assert.equal(build.error, 'COLLISION_WITH_MODEL');
});

test('a column clear of the model reports no collision', () => {
    const build = buildKickstandData({
        // Well outside the box footprint, and the host sits out there too.
        modelId: 'model-1',
        rootPos: { x: 60, y: 0, z: 0 },
        host: {
            segmentId: 'shaft-1',
            supportKind: 'trunk',
            t: 0.5,
            pos: { x: 60, y: 0, z: 20 },
            diameterMm: 2,
        },
        collisionMesh: boxMesh(),
    });
    assert.equal(build.error, undefined);
});

test('without a mesh the column is not checked', () => {
    const build = buildKickstandData(inputWithRoot({ x: 0, y: 0, z: 0 }));
    assert.equal(build.error, undefined);
});
