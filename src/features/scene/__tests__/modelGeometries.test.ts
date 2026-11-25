import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { modelGeometries } from '../sceneSnapshotSpill';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

function entry(geometry: THREE.BufferGeometry, displayGeometry?: THREE.BufferGeometry): { geometry: GeometryWithBounds } {
    return {
        geometry: {
            geometry,
            ...(displayGeometry ? { displayGeometry } : {}),
            bbox: new THREE.Box3(),
            center: new THREE.Vector3(),
            size: new THREE.Vector3(),
            flatteningPlanes: [],
        },
    };
}

test('a model with a display mesh holds both meshes', () => {
    const real = new THREE.BufferGeometry();
    const display = new THREE.BufferGeometry();
    assert.deepEqual(modelGeometries(entry(real, display)), [real, display]);
});

test('a display mesh that is the model mesh is listed once', () => {
    const real = new THREE.BufferGeometry();
    assert.deepEqual(modelGeometries(entry(real, real)), [real]);
    assert.deepEqual(modelGeometries(entry(real)), [real]);
});
