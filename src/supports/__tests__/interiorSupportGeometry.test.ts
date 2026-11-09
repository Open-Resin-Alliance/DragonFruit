import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { createCavityTester, isInteriorContact } from '../interiorSupportGeometry';

/** A single triangle in the z=0 plane with its face normal along +z. */
function planeGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,
        10, 0, 0,
        0, 10, 0,
    ], 3));
    geometry.computeVertexNormals();
    (geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree = new MeshBVH(geometry);
    return geometry;
}

test('an unstamped point is classified against the cavity wall, not assumed visible', () => {
    const geometry = planeGeometry();
    const cavity = createCavityTester(new Map([['m', geometry]]));

    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: 2 }), true, 'cavity side of the wall');
    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: -0.5 }), true, 'within the shell thickness of the wall');
    assert.equal(cavity.isOnInteriorSide({ x: 1, y: 1, z: -5 }), false, 'outside the shell on the solid side');
    assert.equal(cavity.isInsideVoid({ x: 1, y: 1, z: 2 }), true, 'strict void side');
    assert.equal(cavity.isInsideVoid({ x: 1, y: 1, z: -0.5 }), false, 'near the wall is not the void');
});

test('a stamped placement surface wins over the geometry', () => {
    const geometry = planeGeometry();
    const cavity = createCavityTester(new Map([['m', geometry]]));

    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: 2 }, placementSurface: 'exterior' }, 'm', cavity.isOnInteriorSide), false);
    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: -5 }, placementSurface: 'interior' }, 'm', cavity.isOnInteriorSide), true);
    assert.equal(isInteriorContact({ pos: { x: 1, y: 1, z: 2 } }, 'm', cavity.isOnInteriorSide), true,
        'no stamp goes to the cavity test');
});

test('no cavity geometry means no point is classified interior', () => {
    const cavity = createCavityTester(new Map());
    assert.equal(cavity.isOnInteriorSide({ x: 0, y: 0, z: 0 }), false);
    assert.equal(cavity.isInsideVoid({ x: 0, y: 0, z: 0 }), false);
});
