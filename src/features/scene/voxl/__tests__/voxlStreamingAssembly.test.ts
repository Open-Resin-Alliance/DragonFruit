import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import {
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
  parseVoxlBinaryV2,
  resetVoxlCodecStats,
  voxlCodecStats,
} from '../codec-v2';
import { meshLike, testInput, withFrozenClock } from './voxlTestSupport';

/**
 * Streaming assembly (Ph0.1 sub-phase E).
 *
 * The writer allocated ONE contiguous `ArrayBuffer` the size of the whole
 * document and memcpy'd every chunk into it on the MAIN thread — 172 MiB for a
 * single 4M-tri model, 515 MiB for a 3-model plate — on the one code path that
 * runs unattended every 30 seconds. It is both a jank source and an OOM
 * candidate, and Ph5's original-mesh embed roughly triples it.
 *
 * It is removable because the chunk directory is computed BEFORE assembly: every
 * chunk's offset is already known when the first byte is emitted, so nothing
 * needs a second pass.
 */

const MESH_A = meshLike(11);
const MESH_B = meshLike(12);

function collectingSink() {
  const parts: Uint8Array[] = [];
  return {
    parts,
    sink: async (bytes: Uint8Array) => {
      // Copy: the streaming writer is allowed to reuse a scratch buffer for the
      // header/directory, and a sink that retained it would see it mutated.
      parts.push(new Uint8Array(bytes));
    },
    concat(): Uint8Array {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const part of parts) {
        out.set(part, cursor);
        cursor += part.length;
      }
      return out;
    },
  };
}

describe('the streaming VOXL serializer', () => {
  beforeEach(() => {
    resetVoxlCodecStats();
  });

  test('emits bytes identical to the buffered serializer (all-unique scene)', async () => {
    await withFrozenClock(async () => {
      const meshBytes = new Map([[0, MESH_A], [1, MESH_B]]);
      const sha = new Map([[0, 'sha-a'], [1, 'sha-b']]);

      const buffered = await serializeVoxlDocumentV2(testInput(['m0', 'm1']), meshBytes, sha);
      const streamed = collectingSink();
      await serializeVoxlDocumentV2Streaming(testInput(['m0', 'm1']), meshBytes, sha, streamed.sink);

      assert.deepEqual([...streamed.concat()], [...buffered], 'streaming changed the on-disk bytes');
    });
  });

  test('emits bytes identical to the buffered serializer (deduped scene)', async () => {
    await withFrozenClock(async () => {
      const meshBytes = new Map([[0, MESH_A], [1, MESH_A], [2, MESH_B]]);
      const sha = new Map([[0, 'sha-a'], [1, 'sha-a'], [2, 'sha-b']]);

      const buffered = await serializeVoxlDocumentV2(testInput(['m0', 'm1', 'm2']), meshBytes, sha);
      const streamed = collectingSink();
      await serializeVoxlDocumentV2Streaming(testInput(['m0', 'm1', 'm2']), meshBytes, sha, streamed.sink);

      const bytes = streamed.concat();
      assert.deepEqual([...bytes], [...buffered]);

      // And it is a real file, not just an equal byte string.
      const { meshBytes: out } = parseVoxlBinaryV2(bytes);
      assert.deepEqual([...out.get('m1')!], [...MESH_A]);
    });
  });

  test('never allocates a buffer the size of the document', async () => {
    const meshBytes = new Map([[0, MESH_A], [1, MESH_B]]);
    const sha = new Map([[0, 'sha-a'], [1, 'sha-b']]);

    const streamed = collectingSink();
    const result = await serializeVoxlDocumentV2Streaming(
      testInput(['m0', 'm1']),
      meshBytes,
      sha,
      streamed.sink,
    );

    assert.ok(result.totalSize > MESH_A.length, 'sanity: the document is bigger than one mesh');
    assert.ok(
      voxlCodecStats.largestContiguousAllocation < result.totalSize,
      'the streaming path still allocated the whole document contiguously',
    );
    assert.ok(
      streamed.parts.length > 2,
      'the payload must arrive as separate chunks, not one buffer handed to the sink',
    );
    assert.equal(
      streamed.concat().length,
      result.totalSize,
      'the reported total must match what actually reached the sink',
    );
  });

  test('the buffered serializer remains available for the browser download path', async () => {
    const bytes = await serializeVoxlDocumentV2(
      testInput(['m0']),
      new Map([[0, MESH_A]]),
      new Map([[0, 'sha-a']]),
    );
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(voxlCodecStats.largestContiguousAllocation, bytes.length);
  });

  test('a sink failure propagates instead of producing a half-written file', async () => {
    await assert.rejects(
      () => serializeVoxlDocumentV2Streaming(
        testInput(['m0']),
        new Map([[0, MESH_A]]),
        new Map([[0, 'sha-a']]),
        async () => {
          throw new Error('disk full');
        },
      ),
      /disk full/,
    );
  });
});
