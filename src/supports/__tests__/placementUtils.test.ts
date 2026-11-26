import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';

const EPS = 1e-6;

function assertVec3Close(
    actual: { x: number; y: number; z: number },
    expected: { x: number; y: number; z: number },
    label: string,
): void {
    assert.ok(
        Math.abs(actual.x - expected.x) <= EPS
            && Math.abs(actual.y - expected.y) <= EPS
            && Math.abs(actual.z - expected.z) <= EPS,
        `${label}: expected (${expected.x}, ${expected.y}, ${expected.z}), got (${actual.x}, ${actual.y}, ${actual.z})`,
    );
}

test('calculateSmoothedNormal transforms face normal to world space on rotated mesh without vertex normals', () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
    ], 3));

    const mesh = new THREE.Mesh(geom);
    mesh.rotation.x = Math.PI / 2;
    mesh.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster(
        new THREE.Vector3(0.25, -2, 0.25),
        new THREE.Vector3(0, 1, 0),
    );
    const hits = raycaster.intersectObject(mesh, false);
    assert.equal(hits.length, 1);

    assertVec3Close(
        calculateSmoothedNormal(hits[0]),
        { x: 0, y: -1, z: 0 },
        'rotated mesh without attributes.normal',
    );
});

test('calculateSmoothedNormal transforms face normal on rotated geometry-less Object3D', () => {
    const obj = new THREE.Object3D();
    obj.rotation.z = Math.PI / 2;
    obj.updateMatrixWorld(true);

    const hit = {
        object: obj,
        point: new THREE.Vector3(0, 0, 0),
        distance: 1,
        faceIndex: 0,
        face: {
            a: 0,
            b: 1,
            c: 2,
            normal: new THREE.Vector3(1, 0, 0),
            materialIndex: 0,
        },
    } as unknown as THREE.Intersection;

    assertVec3Close(
        calculateSmoothedNormal(hit),
        { x: 0, y: 1, z: 0 },
        'rotated Object3D without geometry',
    );
});

function assertNonUniformScaleNormal(withVertexNormals: boolean): void {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
    ], 3));
    if (withVertexNormals) {
        geom.computeVertexNormals();
    }

    const mesh = new THREE.Mesh(geom);
    mesh.scale.set(2, 1, 1);
    mesh.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster(
        new THREE.Vector3(5 / 3, 7 / 3, 7 / 3),
        new THREE.Vector3(-1, -2, -2).normalize(),
    );
    const hits = raycaster.intersectObject(mesh, false);
    assert.equal(hits.length, 1);

    assertVec3Close(
        calculateSmoothedNormal(hits[0]),
        { x: 1 / 3, y: 2 / 3, z: 2 / 3 },
        `non-uniform scale (2,1,1) withVertexNormals=${String(withVertexNormals)}`,
    );
}

test('calculateSmoothedNormal uses inverse-transpose normal matrix under non-uniform scale without vertex normals', () => {
    assertNonUniformScaleNormal(false);
});

test('calculateSmoothedNormal uses inverse-transpose normal matrix under non-uniform scale with vertex normals', () => {
    assertNonUniformScaleNormal(true);
});

test('calculateSmoothedNormal returns +Z fallback when hit.face is missing', () => {
    const obj = new THREE.Object3D();
    obj.rotation.x = Math.PI / 2;
    obj.updateMatrixWorld(true);

    const hit = {
        object: obj,
        point: new THREE.Vector3(0, 0, 0),
        distance: 1,
        face: null,
    } as unknown as THREE.Intersection;

    assert.deepEqual(calculateSmoothedNormal(hit), { x: 0, y: 0, z: 1 });
});

test('calculateSmoothedNormal falls back cleanly on singular and zero-scale transforms', () => {
    const planarObj = new THREE.Object3D();
    planarObj.scale.set(0, 1, 1);
    planarObj.updateMatrixWorld(true);

    const planarHit = {
        object: planarObj,
        point: new THREE.Vector3(0, 0, 0),
        distance: 1,
        face: {
            a: 0,
            b: 1,
            c: 2,
            normal: new THREE.Vector3(0, 1, 0),
            materialIndex: 0,
        },
    } as unknown as THREE.Intersection;

    assertVec3Close(
        calculateSmoothedNormal(planarHit),
        { x: 0, y: 1, z: 0 },
        'singular scale fallback via transformDirection',
    );

    const zeroObj = new THREE.Object3D();
    zeroObj.scale.set(0, 0, 0);
    zeroObj.updateMatrixWorld(true);

    const zeroHit = {
        object: zeroObj,
        point: new THREE.Vector3(0, 0, 0),
        distance: 1,
        face: {
            a: 0,
            b: 1,
            c: 2,
            normal: new THREE.Vector3(0, 1, 0),
            materialIndex: 0,
        },
    } as unknown as THREE.Intersection;

    assert.deepEqual(calculateSmoothedNormal(zeroHit), { x: 0, y: 0, z: 1 });
});
