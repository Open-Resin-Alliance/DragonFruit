/**
 * The center of mass drawn by the support overlay is the volume centroid of the
 * model geometry; these pin the integral, including the two cases the scene
 * actually hits: meshes that are far from the origin, and meshes that enclose
 * nothing (a sheet has no weight to balance).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { geometryCentroidMm, geometryVolumeMm3 } from '../modelResinVolume';

function close(actual: number, expected: number, epsilon = 1e-6): void {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test('a box centroid is its own center, wherever the origin sits', () => {
    const box = new THREE.BoxGeometry(2, 4, 6);
    box.translate(10, -5, 3);
    const centroid = geometryCentroidMm(box);
    assert.ok(centroid, 'a closed box has a centroid');
    close(centroid.x, 10);
    close(centroid.y, -5);
    close(centroid.z, 3);
    close(geometryVolumeMm3(box), 48, 1e-4);
});

test('the centroid follows the shape, not the bounding box', () => {
    // Two unit cubes of equal volume, one at x=0 and one at x=10, weld into one
    // volume whose centroid must sit at the shared middle only if their volumes
    // match; here the second cube is twice as large.
    const small = new THREE.BoxGeometry(1, 1, 1);
    const large = new THREE.BoxGeometry(1, 1, 1);
    large.scale(2, 2, 2);
    large.translate(12, 0, 0);
    const merged = new THREE.BufferGeometry();
    const smallPos = small.getAttribute('position');
    const largePos = large.getAttribute('position');
    const combined = new Float32Array((smallPos.count + largePos.count) * 3);
    combined.set(smallPos.array as Float32Array, 0);
    combined.set(largePos.array as Float32Array, smallPos.count * 3);
    merged.setAttribute('position', new THREE.BufferAttribute(combined, 3));
    const smallIndex = small.getIndex();
    const largeIndex = large.getIndex();
    assert.ok(smallIndex && largeIndex, 'boxes are indexed');
    const offset = smallPos.count;
    const combinedIndex = new Uint32Array(smallIndex.count + largeIndex.count);
    for (let i = 0; i < smallIndex.count; i++) combinedIndex[i] = smallIndex.getX(i);
    for (let i = 0; i < largeIndex.count; i++) combinedIndex[smallIndex.count + i] = largeIndex.getX(i) + offset;
    merged.setIndex(new THREE.BufferAttribute(combinedIndex, 1));

    const centroid = geometryCentroidMm(merged);
    assert.ok(centroid, 'two closed boxes have a centroid');
    // Volumes 1 and 8 → the centroid sits 8/9 of the way from 0 to 12.
    close(centroid.x, (12 * 8) / 9, 1e-5);
    close(centroid.y, 0, 1e-5);
    close(centroid.z, 0, 1e-5);
});

test('a sheet encloses nothing and reports no centroid', () => {
    const sheet = new THREE.PlaneGeometry(10, 10);
    assert.equal(geometryCentroidMm(sheet), null);
});
