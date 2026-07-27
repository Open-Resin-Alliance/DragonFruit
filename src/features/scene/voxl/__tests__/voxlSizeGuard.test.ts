import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import {
  serializeVoxlDocumentV2,
  assertVoxlSizeLimits,
  resetVoxlCodecStats,
  voxlCodecStats,
  VoxlSizeLimitError,
  VOXL_SIZE_LIMIT_BYTES,
  VOXL_SIZE_SOFT_WARN_BYTES,
} from '../codec-v2';
import { meshLike, testInput } from './voxlTestSupport';

/** `assert.throws` is typed `void`, so capture the error explicitly. */
function captureSizeLimitError(fn: () => void): VoxlSizeLimitError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof VoxlSizeLimitError, `expected VoxlSizeLimitError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the size guard to reject, but it passed' });
}

/**
 * The 4 GiB ceiling (Ph0.1 sub-phase D1).
 *
 * Chunk offsets, `compressedSize` and `uncompressedSize` are all `setUint32`.
 * There was NO writer guard: a scene past the ceiling wrapped its offsets and
 * produced a file that parsed and was silently wrong. The guard is wired
 * **pre-flight** — the directory layout is computed before assembly, so every
 * length is known before a single byte is allocated, and the failure must
 * therefore happen before the allocation rather than as a failed 4 GiB `new
 * ArrayBuffer`.
 */

const OVER_U32 = 0x1_0000_0000;

describe('the VOXL 4 GiB pre-flight guard', () => {
  beforeEach(() => {
    resetVoxlCodecStats();
  });

  test('the limit is the u32 ceiling and the soft warning sits below it', () => {
    assert.equal(VOXL_SIZE_LIMIT_BYTES, 0xFFFF_FFFF);
    assert.ok(
      VOXL_SIZE_SOFT_WARN_BYTES < VOXL_SIZE_LIMIT_BYTES,
      'the soft warning must fire before the hard failure',
    );
  });

  test('a total past the ceiling raises VoxlSizeLimitError instead of wrapping', () => {
    const entries = [
      { type: 'MODL', index: 0, compressedSize: 1024, uncompressedSize: 4096 },
      { type: 'MESH', index: 0, compressedSize: 0xFFFF_0000, uncompressedSize: 0xFFFF_0000 },
      { type: 'MESH', index: 1, compressedSize: 0x0002_0000, uncompressedSize: 0x0002_0000 },
    ];
    const total = entries.reduce((n, e) => n + e.compressedSize, 16 + entries.length * 20);

    assert.throws(
      () => assertVoxlSizeLimits(entries, total),
      (error: unknown) => {
        assert.ok(error instanceof VoxlSizeLimitError);
        assert.equal(error.totalBytes, total);
        assert.equal(error.limitBytes, VOXL_SIZE_LIMIT_BYTES);
        return true;
      },
    );
  });

  test('a single oversize chunk is rejected even when the total fits', () => {
    // A chunk that compressed under the ceiling but whose RAW size does not fit
    // the u32 `rawSize` field: the reader would allocate the wrong buffer and
    // fail the post-inflate size check with a meaningless message.
    const entries = [
      { type: 'MESH', index: 0, compressedSize: 4096, uncompressedSize: OVER_U32 },
    ];

    const error = captureSizeLimitError(() => assertVoxlSizeLimits(entries, 8192));

    assert.equal(error.oversizeChunks.length, 1);
    assert.equal(error.oversizeChunks[0].type, 'MESH');
  });

  test('a scene inside the ceiling passes cleanly', () => {
    assert.doesNotThrow(() =>
      assertVoxlSizeLimits(
        [{ type: 'MESH', index: 0, compressedSize: 1_000_000, uncompressedSize: 8_000_000 }],
        1_000_100,
      ),
    );
  });

  test('the serializer fails pre-flight — no contiguous buffer is ever allocated', async () => {
    // A pre-compressed payload declaring a raw size past u32 is the cheapest
    // honest way to drive the writer past the ceiling without materialising
    // 4 GiB in the test process.
    const mesh = meshLike(7);
    const precompressed = new Map([
      [0, { data: mesh, compression: 0, uncompressedSize: OVER_U32 }],
    ]);

    await assert.rejects(
      () => serializeVoxlDocumentV2(
        testInput(['m0']),
        new Map([[0, mesh]]),
        new Map([[0, 'sha-0']]),
        { precompressed },
      ),
      VoxlSizeLimitError,
    );

    assert.equal(
      voxlCodecStats.largestContiguousAllocation,
      0,
      'the writer allocated the output buffer before checking whether it could address it',
    );
  });

  test('the error carries a user-facing message naming the size and the cause', () => {
    // 2 × 2.15 GiB → 4.3 GiB total, each chunk individually inside u32.
    const entries = [
      { type: 'MESH', index: 0, compressedSize: 2_308_544_922, uncompressedSize: 2_308_544_922 },
      { type: 'MESH', index: 1, compressedSize: 2_308_544_922, uncompressedSize: 2_308_544_922 },
    ];
    const total = 4_617_089_844;

    const error = captureSizeLimitError(
      () => assertVoxlSizeLimits(entries, total, { modelNames: ['Dragon', 'Castle'] }),
    );

    // The message the modal shows. It must state the measured size, the limit,
    // and what the user can actually do about it — never a bare stack trace.
    assert.match(error.userMessage, /4\.3 GB/);
    assert.match(error.userMessage, /4 GB limit/);
    assert.match(error.userMessage, /Remove a model/i);
    assert.ok(
      error.perModelBreakdown.some((row) => row.name === 'Dragon'),
      'the breakdown must name the models so the user knows which one to remove',
    );
  });
});
