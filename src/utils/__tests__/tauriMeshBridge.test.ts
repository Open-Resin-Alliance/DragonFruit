import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { decodeF32, readPositionsFromCommand, shouldRefineCoarseFaces } from '../tauriMeshBridge';
import type { TauriInvoke } from '../tauriMeshBridge';

function geometryWithTriangles(triangles: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(triangles * 9), 3),
  );
  return geometry;
}

test('refine gate refuses empty geometry and accepts a mesh at the ceiling', () => {
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(0), 3), false);
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(3), 3), true);
  assert.equal(shouldRefineCoarseFaces(geometryWithTriangles(4), 3), false);
});

test('decodeF32 aliases an owned buffer and rejects a partial float', () => {
  const floats = new Float32Array([7, 8, 9]);
  const decoded = decodeF32(floats.buffer, 'test');
  assert.deepEqual(Array.from(decoded), [7, 8, 9]);
  assert.equal(decoded.buffer, floats.buffer, 'an owned ArrayBuffer is not copied');
  assert.throws(() => decodeF32(new ArrayBuffer(6), 'test'), /not a whole f32 payload/);
});

test('a published readback is fetched from the mesh protocol instead of returned inline', async () => {
  const floats = new Float32Array([1, 2, 3]);
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(floats.buffer.slice(0), { status: 200 });
  }) as typeof fetch;
  try {
    const invoke: TauriInvoke = async <T,>() => ({ id: 'readback-7', byteLength: floats.byteLength }) as T;
    const positions = await readPositionsFromCommand(invoke, 'mesh_repair_read_positions');
    assert.deepEqual(Array.from(positions), [1, 2, 3]);
    assert.deepEqual(requested, ['http://mesh.localhost/readback-7']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an inline readback still decodes without a fetch', async () => {
  const floats = new Float32Array([4, 5, 6]);
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched += 1; throw new Error('unexpected fetch'); }) as typeof fetch;
  try {
    const invoke: TauriInvoke = async <T,>() => new Uint8Array(floats.buffer.slice(0)) as T;
    const positions = await readPositionsFromCommand(invoke, 'mesh_punch_read_positions');
    assert.deepEqual(Array.from(positions), [4, 5, 6]);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
