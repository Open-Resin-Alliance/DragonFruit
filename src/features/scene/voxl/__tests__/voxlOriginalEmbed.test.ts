import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import {
  parseVoxlBinaryV2,
  resetVoxlCodecStats,
  serializeVoxlDocumentV2,
} from '../codec-v2';
import { MeshChunkStore } from '../meshChunkStore';
import {
  countVoxlChunks,
  meshLike,
  testInput,
  withFrozenClock,
} from './voxlTestSupport';

const PREVIEW_MESH = meshLike(1, 2048);
const ORIGINAL_MESH = meshLike(99, 8192);

describe('Full-Resolution Mesh Embedding (ORIG Chunk)', () => {
  beforeEach(() => {
    resetVoxlCodecStats();
  });

  test('embeds ORIG chunk and extracts originalMeshBytes upon parsing', async () => {
    await withFrozenClock(async () => {
      const store = new MeshChunkStore();

      const previewBaked = await store.bake({
        modelId: 'm0',
        slot: 'preview',
        signature: 'sig:preview:m0',
        encode: () => PREVIEW_MESH,
      });

      const origBaked = await store.bake({
        modelId: 'm0',
        slot: 'original',
        signature: 'sig:orig:m0',
        encode: () => ORIGINAL_MESH,
      });

      const meshBytesMap = new Map<number, Uint8Array>([[0, PREVIEW_MESH]]);
      const sha256Map = new Map<number, string>([[0, previewBaked.sha256]]);

      const precompressed = new Map<number, { data: Uint8Array; compression: number; uncompressedSize: number }>([
        [0, { data: previewBaked.data, compression: previewBaked.compression, uncompressedSize: previewBaked.uncompressedSize }],
      ]);
      const precompressedOriginal = new Map<number, { data: Uint8Array; compression: number; uncompressedSize: number }>([
        [0, { data: origBaked.data, compression: origBaked.compression, uncompressedSize: origBaked.uncompressedSize }],
      ]);

      const bin = await serializeVoxlDocumentV2(
        testInput(['m0']),
        meshBytesMap,
        sha256Map,
        {
          precompressed,
          precompressedOriginal,
          embedOriginalMesh: true,
        },
      );

      assert.equal(countVoxlChunks(bin, 'MESH'), 1, 'must contain 1 MESH chunk');
      assert.equal(countVoxlChunks(bin, 'ORIG'), 1, 'must contain 1 ORIG chunk');

      const parsed = parseVoxlBinaryV2(bin);
      assert.ok(parsed.meshBytes.has('m0'), 'meshBytes must contain m0');
      assert.deepEqual([...parsed.meshBytes.get('m0')!], [...PREVIEW_MESH], 'preview mesh bytes must match');

      assert.ok(parsed.originalMeshBytes, 'originalMeshBytes must be defined');
      assert.ok(parsed.originalMeshBytes.has('m0'), 'originalMeshBytes must contain m0');
      assert.deepEqual([...parsed.originalMeshBytes.get('m0')!], [...ORIGINAL_MESH], 'original mesh bytes must match');
    });
  });

  test('legacy reader compatibility: ignores ORIG chunk without throwing error', async () => {
    const store = new MeshChunkStore();
    const previewBaked = await store.bake({
      modelId: 'm0',
      slot: 'preview',
      signature: 'sig:preview:m0',
      encode: () => PREVIEW_MESH,
    });
    const origBaked = await store.bake({
      modelId: 'm0',
      slot: 'original',
      signature: 'sig:orig:m0',
      encode: () => ORIGINAL_MESH,
    });

    const precompressed = new Map([[0, { data: previewBaked.data, compression: previewBaked.compression, uncompressedSize: previewBaked.uncompressedSize }]]);
    const precompressedOriginal = new Map([[0, { data: origBaked.data, compression: origBaked.compression, uncompressedSize: origBaked.uncompressedSize }]]);

    const bin = await serializeVoxlDocumentV2(
      testInput(['m0']),
      new Map([[0, PREVIEW_MESH]]),
      new Map([[0, previewBaked.sha256]]),
      { precompressed, precompressedOriginal, embedOriginalMesh: true },
    );

    const parsed = parseVoxlBinaryV2(bin);
    assert.equal(parsed.document.models.length, 1);
    assert.equal(parsed.document.models[0].name, 'm0');
    assert.deepEqual([...parsed.meshBytes.get('m0')!], [...PREVIEW_MESH]);
  });

  test('embedOriginalMesh: false omits ORIG chunk from binary output', async () => {
    const store = new MeshChunkStore();
    const previewBaked = await store.bake({
      modelId: 'm0',
      slot: 'preview',
      signature: 'sig:preview:m0',
      encode: () => PREVIEW_MESH,
    });
    const origBaked = await store.bake({
      modelId: 'm0',
      slot: 'original',
      signature: 'sig:orig:m0',
      encode: () => ORIGINAL_MESH,
    });

    const precompressed = new Map([[0, { data: previewBaked.data, compression: previewBaked.compression, uncompressedSize: previewBaked.uncompressedSize }]]);
    const precompressedOriginal = new Map([[0, { data: origBaked.data, compression: origBaked.compression, uncompressedSize: origBaked.uncompressedSize }]]);

    const bin = await serializeVoxlDocumentV2(
      testInput(['m0']),
      new Map([[0, PREVIEW_MESH]]),
      new Map([[0, previewBaked.sha256]]),
      {
        precompressed,
        precompressedOriginal,
        embedOriginalMesh: false,
      },
    );

    assert.equal(countVoxlChunks(bin, 'MESH'), 1);
    assert.equal(countVoxlChunks(bin, 'ORIG'), 0, 'ORIG chunk must be omitted when embedOriginalMesh is false');

    const parsed = parseVoxlBinaryV2(bin);
    assert.equal(parsed.originalMeshBytes, undefined, 'originalMeshBytes must be undefined when ORIG chunk is absent');
  });

  test('refcount eviction releases both preview and original chunks on release(modelId)', async () => {
    const store = new MeshChunkStore();

    await store.bake({
      modelId: 'm0',
      slot: 'preview',
      signature: 'sig:p:m0',
      encode: () => PREVIEW_MESH,
    });

    await store.bake({
      modelId: 'm0',
      slot: 'original',
      signature: 'sig:o:m0',
      encode: () => ORIGINAL_MESH,
    });

    const statsBefore = store.stats();
    assert.equal(statsBefore.owners, 2, 'store must track 2 owners (preview and original)');
    assert.equal(statsBefore.blobs, 2, 'store must hold 2 blobs');

    store.release('m0');

    const statsAfter = store.stats();
    assert.equal(statsAfter.owners, 0, 'releasing modelId must drop all owner mappings');
    assert.equal(statsAfter.blobs, 0, 'releasing modelId must evict all blobs when refcount reaches 0');
    assert.equal(statsAfter.evictions, 2, 'both preview and original blobs must be evicted');
  });
});
