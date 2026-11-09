import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { closestSurfaceNormal } from '../autoSupport/closestSurfaceNormal';

test('the nearest triangle answers for a side wall the vertical resolver cannot see', () => {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);

    const side = closestSurfaceNormal(mesh, new THREE.Vector3(5, 0, 0));
    assert.ok(side, 'a side point finds a face');
    assert.ok(Math.abs(Math.abs(side.x) - 1) < 1e-6, `points off the side wall (${side.x.toFixed(3)})`);
    assert.ok(Math.abs(side.z) < 1e-6, 'and is horizontal, not down');

    const underside = closestSurfaceNormal(mesh, new THREE.Vector3(0, 0, -5));
    assert.ok(underside, 'an underside point finds a face');
    assert.ok(Math.abs(underside.z + 1) < 1e-6, 'points down');
});

test('a translated model is handled in world space', () => {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(20, 0, 0);
    mesh.updateMatrixWorld(true);

    const normal = closestSurfaceNormal(mesh, new THREE.Vector3(25, 0, 0));
    assert.ok(normal && Math.abs(normal.x) > 0.999, 'the side at world x=25');
});
