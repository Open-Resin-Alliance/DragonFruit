import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { serializeVoxlDocumentV2, parseVoxlBinaryV2, resetVoxlCodecStats, voxlCodecStats } from '../codec-v2';
import { MeshChunkStore } from '../meshChunkStore';
import {
  countVoxlChunks,
  meshLike,
  readVoxlVersion,
  testInput,
  withFrozenClock,
} from './voxlTestSupport';

/**
 * The store → codec seam (Ph0.1 sub-phase C).
 *
 * `serializeVoxlDocumentV2` gains an additive `precompressed` option so a tick
 * can hand it chunks that were already encoded, hashed and zlib-6'd at
 * finalization time. The scope fence for this sub-phase is byte-identity: a
 * document assembled from the store must be indistinguishable from one the
 * pre-store writer would have produced.
 */

const MESH_A = meshLike(1);
const MESH_B = meshLike(2);

async function bakeAll(store: MeshChunkStore, meshes: Array<[string, Uint8Array]>) {
  const meshBytes = new Map<number, Uint8Array>();
  const sha256Map = new Map<number, string>();
  const precompressed = new Map<number, { data: Uint8Array; compression: number; uncompressedSize: number }>();

  for (let i = 0; i < meshes.length; i += 1) {
    const [modelId, bytes] = meshes[i];
    const baked = await store.bake({ modelId, signature: `sig:${modelId}`, encode: () => bytes });
    meshBytes.set(i, bytes);
    sha256Map.set(i, baked.sha256);
    precompressed.set(i, {
      data: baked.data,
      compression: baked.compression,
      uncompressedSize: baked.uncompressedSize,
    });
  }

  return { meshBytes, sha256Map, precompressed };
}

describe('pre-compressed chunk payloads', () => {
  beforeEach(() => {
    resetVoxlCodecStats();
  });

  test('a document serialized from the store is byte-identical to one serialized from raw input', async () => {
    await withFrozenClock(async () => {
      const store = new MeshChunkStore();
      const { meshBytes, sha256Map, precompressed } = await bakeAll(store, [
        ['m0', MESH_A],
        ['m1', MESH_B],
      ]);

      const fromRaw = await serializeVoxlDocumentV2(testInput(['m0', 'm1']), meshBytes, sha256Map);
      const fromStore = await serializeVoxlDocumentV2(
        testInput(['m0', 'm1']),
        meshBytes,
        sha256Map,
        { precompressed },
      );

      assert.deepEqual([...fromStore], [...fromRaw], 'the store path changed the on-disk bytes');
    });
  });

  test('supplying pre-compressed MESH payloads performs ZERO mesh compressions', async () => {
    const store = new MeshChunkStore();
    const { meshBytes, sha256Map, precompressed } = await bakeAll(store, [
      ['m0', MESH_A],
      ['m1', MESH_B],
    ]);

    resetVoxlCodecStats();
    await serializeVoxlDocumentV2(testInput(['m0', 'm1']), meshBytes, sha256Map, { precompressed });

    assert.equal(
      voxlCodecStats.meshChunkCompressions,
      0,
      'zlib-6 re-ran over geometry the store had already compressed',
    );
    assert.ok(voxlCodecStats.jsonChunkCompressions > 0, 'the JSON chunks still compress per tick, by design');
  });

  /**
   * The trigger-hygiene lock (sub-phase D5). A 0.1 mm nudge schedules a full
   * autosave and that is deliberately NOT filtered: post-C the tick's cost is
   * the KB-scale JSON chunks plus the disk write, so a drift-prone "which
   * history entries matter" classifier would buy nothing. This test is what
   * makes that acceptable — if a future change reintroduces per-tick mesh
   * compression, it fails here rather than in a user's 3 589 ms stall.
   */
  test('a transform-only tick compresses no MESH chunks at all', async () => {
    const store = new MeshChunkStore();
    const { meshBytes, sha256Map } = await bakeAll(store, [['m0', MESH_A], ['m1', MESH_B]]);

    // Tick 2: only the transform changed, so every signature still matches.
    const precompressed = new Map<number, { data: Uint8Array; compression: number; uncompressedSize: number }>();
    for (const [i, modelId] of ['m0', 'm1'].entries()) {
      const cached = store.lookup(modelId, `sig:${modelId}`);
      assert.ok(cached, 'an unchanged model must still be resolvable from the store');
      precompressed.set(i, {
        data: cached.data,
        compression: cached.compression,
        uncompressedSize: cached.uncompressedSize,
      });
    }

    resetVoxlCodecStats();
    const moved = testInput(['m0', 'm1']);
    moved.models[0].transform.position.x = 0.1;
    await serializeVoxlDocumentV2(moved, meshBytes, sha256Map, { precompressed });

    assert.equal(voxlCodecStats.meshChunkCompressions, 0);
    assert.equal(store.stats().compressions, 2, 'the nudge must not have re-baked anything');
  });

  test('pre-compressed payloads still dedup identical meshes to one chunk', async () => {
    const store = new MeshChunkStore();
    const { meshBytes, sha256Map, precompressed } = await bakeAll(store, [
      ['m0', MESH_A],
      ['m1', MESH_A],
      ['m2', MESH_B],
    ]);

    const bin = await serializeVoxlDocumentV2(
      testInput(['m0', 'm1', 'm2']),
      meshBytes,
      sha256Map,
      { precompressed },
    );

    assert.equal(countVoxlChunks(bin, 'MESH'), 2, 'the two identical meshes must share one chunk');
    assert.equal(readVoxlVersion(bin), 3);

    const { meshBytes: out } = parseVoxlBinaryV2(bin);
    assert.deepEqual([...out.get('m0')!], [...MESH_A]);
    assert.deepEqual([...out.get('m1')!], [...MESH_A]);
    assert.deepEqual([...out.get('m2')!], [...MESH_B]);
  });

  test('a pre-compressed document round-trips to the original mesh bytes', async () => {
    const store = new MeshChunkStore();
    const { meshBytes, sha256Map, precompressed } = await bakeAll(store, [['m0', MESH_A]]);

    const bin = await serializeVoxlDocumentV2(testInput(['m0']), meshBytes, sha256Map, { precompressed });
    const { document, meshBytes: out } = parseVoxlBinaryV2(bin);

    assert.deepEqual([...out.get('m0')!], [...MESH_A]);
    assert.equal(document.models[0].mesh.sha256, sha256Map.get(0));
    assert.equal(document.models[0].mesh.uncompressedSizeBytes, MESH_A.length);
  });
});
