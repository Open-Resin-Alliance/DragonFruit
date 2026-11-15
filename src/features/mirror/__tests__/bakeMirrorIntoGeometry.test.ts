import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { bakeMirrorIntoGeometry } from '../logic/bakeMirrorIntoGeometry';
import * as bakeMirrorModule from '../logic/bakeMirrorIntoGeometry';

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

test('bakeMirrorIntoGeometry swaps non-indexed normal, color, uv, and aBakedOcclusion per triangle', () => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    1, 0, 0,
    0, 2, 0,
    0, 0, 3,
  ]), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0.1, 0.2, 0.3,
    0.4, 0.5, 0.6,
    0.7, 0.8, 0.9,
  ]), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0,
    1, 0,
    0, 1,
  ]), 2));
  geom.setAttribute('aBakedOcclusion', new THREE.BufferAttribute(new Float32Array([
    0.1, 0.5, 0.9,
  ]), 1));

  assert.equal(
    typeof (bakeMirrorModule as Record<string, unknown>).swapNonIndexedAttributeWinding,
    'function',
    'swapNonIndexedAttributeWinding must be exported',
  );

  const out = bakeMirrorIntoGeometry(geom, 'x');
  const pos = Array.from(out.getAttribute('position').array as Float32Array);
  const norm = Array.from(out.getAttribute('normal').array as Float32Array);
  const color = Array.from(out.getAttribute('color').array as Float32Array);
  const uv = Array.from(out.getAttribute('uv').array as Float32Array);
  const ao = Array.from(out.getAttribute('aBakedOcclusion').array as Float32Array);

  assert.deepEqual(pos.map((v) => Math.round(v * 1e6) / 1e6 || 0), [-1, 0, 0, 0, 0, 3, 0, 2, 0]);
  assert.deepEqual(norm.map((v) => Math.round(v * 1e6) / 1e6 || 0), [-0.1, 0.2, 0.3, -0.7, 0.8, 0.9, -0.4, 0.5, 0.6]);
  assert.deepEqual(color, [1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual(uv, [0, 0, 0, 1, 1, 0]);
  assert.deepEqual(ao.map((v) => Math.round(v * 1e6) / 1e6 || 0), [0.1, 0.9, 0.5]);
});

test('bakeMirrorWorker swaps non-indexed normals to match bakeMirrorIntoGeometry', async () => {
  const prevSelf = (globalThis as Record<string, unknown>).self;
  const responses: Array<{ positions: Float32Array; normals: Float32Array | null; indices: Uint16Array | Uint32Array | null }> = [];
  const fakeSelf: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (msg: unknown) => void } = {
    onmessage: null,
    postMessage: (msg: unknown) => {
      responses.push(msg as (typeof responses)[number]);
    },
  };
  (globalThis as Record<string, unknown>).self = fakeSelf;

  try {
    const workerUrl = new URL('../workers/bakeMirrorWorker.ts', import.meta.url).href;
    await import(workerUrl);
    assert.ok(fakeSelf.onmessage, 'worker must attach self.onmessage');

    const positions = new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3]);
    const normals = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    fakeSelf.onmessage({
      data: {
        positions: positions.slice(),
        normals: normals.slice(),
        indices: null,
        posItemSize: 3,
        normItemSize: 3,
        axes: [0],
      },
    } as MessageEvent);

    assert.equal(responses.length, 1);
    const singleNorm = Array.from(responses[0].normals!).map((v) => Math.round(v * 1e6) / 1e6);
    assert.deepEqual(singleNorm, [-0.1, 0.2, 0.3, -0.7, 0.8, 0.9, -0.4, 0.5, 0.6]);

    // Two sequential axis flips swap (1, 2) twice, restoring original vertex order.
    fakeSelf.onmessage({
      data: {
        positions: positions.slice(),
        normals: normals.slice(),
        indices: null,
        posItemSize: 3,
        normItemSize: 3,
        axes: [0, 1],
      },
    } as MessageEvent);
    assert.equal(responses.length, 2);
    const doubleNorm = Array.from(responses[1].normals!).map((v) => Math.round(v * 1e6) / 1e6);
    assert.deepEqual(doubleNorm, [-0.1, -0.2, 0.3, -0.4, -0.5, 0.6, -0.7, -0.8, 0.9]);
  } finally {
    if (prevSelf === undefined) {
      delete (globalThis as Record<string, unknown>).self;
    } else {
      (globalThis as Record<string, unknown>).self = prevSelf;
    }
  }
});

test('bakeMirrorIntoGeometry throws when position attribute has itemSize < 3', () => {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([1, 2, 3, 4, 5, 6]), 2));
  assert.throws(
    () => bakeMirrorIntoGeometry(geom, 'z'),
    /itemSize >= 3.*got itemSize=2/i,
    'must reject position attribute with itemSize < 3 with descriptive error',
  );
});

test('bakeMirrorIntoGeometry throws when position attribute is not a BufferAttribute', () => {
  const geom = new THREE.BufferGeometry();
  const interleaved = new THREE.InterleavedBuffer(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 3);
  geom.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
  assert.throws(
    () => bakeMirrorIntoGeometry(geom, 'x'),
    /BufferAttribute/i,
    'must reject non-BufferAttribute position attribute',
  );
});
