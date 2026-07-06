import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializeVoxlDocumentV2,
  parseVoxlBinaryV2,
  VOXL_V2,
  VOXL_V3,
} from '../codec-v2';
import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
} as unknown as DragonfruitImportFormat;

function model(id: string): VoxlModelRuntimeLike {
  return {
    id,
    name: id,
    visible: true,
    color: '#ffffff',
    polygonCount: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'embedded-file', fileName: `${id}.stl`, mimeType: 'model/stl' },
  };
}

function input(ids: string[]): BuildVoxlDocumentInput {
  return {
    models: ids.map(model),
    activeModelId: ids[0] ?? null,
    selectedModelIds: [],
    supports: EMPTY_SUPPORTS,
  };
}

const MESH_A = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const MESH_B = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
// SHA is opaque to the codec — any stable string that equates identical meshes works.
const SHA_A = 'aaaa';
const SHA_B = 'bbbb';

const readVersion = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);
const countMeshChunks = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkCount = view.getUint32(8, true);
  let n = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const base = 16 + i * 20;
    if (String.fromCharCode(bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]) === 'MESH') n += 1;
  }
  return n;
};

test('dedup: N identical meshes → 1 chunk, V3, all models resolve to the same bytes', async () => {
  const meshBytes = new Map<number, Uint8Array>([[0, MESH_A], [1, MESH_A], [2, MESH_A]]);
  const sha = new Map<number, string>([[0, SHA_A], [1, SHA_A], [2, SHA_A]]);

  const bin = await serializeVoxlDocumentV2(input(['m0', 'm1', 'm2']), meshBytes, sha);
  assert.equal(readVersion(bin), VOXL_V3, 'deduped file must be V3');
  assert.equal(countMeshChunks(bin), 1, '3 identical meshes must collapse to 1 chunk');

  const { document, meshBytes: out } = parseVoxlBinaryV2(bin);
  assert.equal(document.models.length, 3, 'all 3 models must survive');
  for (const id of ['m0', 'm1', 'm2']) {
    assert.deepEqual([...(out.get(id) ?? [])], [...MESH_A], `${id} resolves to the shared mesh`);
  }
});

test('mixed: two unique meshes + one duplicate → 2 chunks, V3, correct mapping', async () => {
  const meshBytes = new Map<number, Uint8Array>([[0, MESH_A], [1, MESH_B], [2, MESH_A]]);
  const sha = new Map<number, string>([[0, SHA_A], [1, SHA_B], [2, SHA_A]]);

  const bin = await serializeVoxlDocumentV2(input(['a', 'b', 'a2']), meshBytes, sha);
  assert.equal(countMeshChunks(bin), 2);
  assert.equal(readVersion(bin), VOXL_V3);

  const { meshBytes: out } = parseVoxlBinaryV2(bin);
  assert.deepEqual([...out.get('a')!], [...MESH_A]);
  assert.deepEqual([...out.get('b')!], [...MESH_B]);
  assert.deepEqual([...out.get('a2')!], [...MESH_A], 'duplicate maps to owner A, not B');
});

test('no dedup possible → stays V2, one chunk per model (old-reader compatible)', async () => {
  const meshBytes = new Map<number, Uint8Array>([[0, MESH_A], [1, MESH_B]]);
  const sha = new Map<number, string>([[0, SHA_A], [1, SHA_B]]);

  const bin = await serializeVoxlDocumentV2(input(['a', 'b']), meshBytes, sha);
  assert.equal(readVersion(bin), VOXL_V2, 'all-unique scene must remain V2');
  assert.equal(countMeshChunks(bin), 2);
});

test('missing SHA → never deduped (cannot prove identity), stays V2', async () => {
  const meshBytes = new Map<number, Uint8Array>([[0, MESH_A], [1, MESH_A]]);
  // No sha256Map at all.
  const bin = await serializeVoxlDocumentV2(input(['a', 'a2']), meshBytes);
  assert.equal(readVersion(bin), VOXL_V2);
  assert.equal(countMeshChunks(bin), 2, 'without hashes, identical meshes are NOT collapsed');
  const { meshBytes: out } = parseVoxlBinaryV2(bin);
  assert.deepEqual([...out.get('a')!], [...MESH_A]);
  assert.deepEqual([...out.get('a2')!], [...MESH_A]);
});
