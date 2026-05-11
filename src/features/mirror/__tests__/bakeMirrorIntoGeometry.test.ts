import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { bakeMirrorIntoGeometry } from '../logic/bakeMirrorIntoGeometry';

function makeTriangle(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex([0, 1, 2]);
  geom.computeVertexNormals();
  return geom;
}

test('bakeMirrorIntoGeometry negates the chosen axis on every vertex', () => {
  const geom = makeTriangle();
  const out = bakeMirrorIntoGeometry(geom, 'x');
  const pos = out.getAttribute('position').array as Float32Array;
  assert.equal(pos[0], -1);
  assert.equal(Math.abs(pos[3]), 0);
  assert.equal(Math.abs(pos[6]), 0);
  assert.equal(Math.abs(pos[1]), 0);
  assert.equal(pos[4], 1);
  assert.equal(Math.abs(pos[7]), 0);
});

test('bakeMirrorIntoGeometry flips triangle winding via index swap', () => {
  const geom = makeTriangle();
  const out = bakeMirrorIntoGeometry(geom, 'y');
  const idx = out.getIndex()!.array as Uint16Array | Uint32Array;
  assert.equal(idx[0], 0);
  assert.equal(idx[1], 2);
  assert.equal(idx[2], 1);
});

test('bakeMirrorIntoGeometry double-mirror returns to original positions', () => {
  const geom = makeTriangle();
  const original = (geom.getAttribute('position').array as Float32Array).slice();
  const once = bakeMirrorIntoGeometry(geom, 'z');
  const twice = bakeMirrorIntoGeometry(once, 'z');
  const finalPos = twice.getAttribute('position').array as Float32Array;
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(Math.abs(original[i] - finalPos[i]) < 1e-6);
  }
});

test('bakeMirrorIntoGeometry recomputes bounding box', () => {
  const geom = makeTriangle();
  geom.computeBoundingBox();
  const out = bakeMirrorIntoGeometry(geom, 'x');
  assert.ok(out.boundingBox);
  assert.equal(out.boundingBox!.min.x, -1);
  assert.equal(Math.abs(out.boundingBox!.max.x), 0);
});

test('bakeMirrorIntoGeometry handles non-indexed geometry', () => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]), 3));
  const out = bakeMirrorIntoGeometry(geom, 'x');
  const pos = out.getAttribute('position').array as Float32Array;
  assert.equal(pos[0], -1);
  assert.equal(Math.abs(pos[3]), 0);
  assert.equal(Math.abs(pos[4]), 0);
  assert.equal(pos[5], 1);
  assert.equal(Math.abs(pos[6]), 0);
  assert.equal(pos[7], 1);
  assert.equal(Math.abs(pos[8]), 0);
});

test('bakeMirrorIntoGeometry produces non-zero recomputed normals', () => {
  const geom = makeTriangle();
  const out = bakeMirrorIntoGeometry(geom, 'x');
  const normals = out.getAttribute('normal');
  assert.ok(normals);
  const n = normals.array as Float32Array;
  const len = Math.hypot(n[0], n[1], n[2]);
  assert.ok(len > 0.5);
});
