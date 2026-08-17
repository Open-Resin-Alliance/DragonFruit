import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
} from '../codec-v2';
import { serializeSupportsChunk } from '../supportsSerializeWorkerClient';
import { VoxlChunkCache } from '../voxlChunkCache';
import { EMPTY_SUPPORTS, testInput, testModel, withFrozenClock } from './voxlTestSupport';
import type { BuildVoxlDocumentInput } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

// A supports payload big + repetitive enough to exercise the zlib-shrink branch,
// so the worker/inline compress decision is actually tested (not just the raw
// fallthrough for tiny inputs).
function bigSupports(): DragonfruitImportFormat {
  const roots = Array.from({ length: 400 }, (_, i) => ({
    id: `root-${i}`,
    modelId: 'm0',
    transform: { pos: { x: i, y: i * 0.5, z: i * 0.25 } },
  }));
  return { ...EMPTY_SUPPORTS, roots } as unknown as DragonfruitImportFormat;
}

function inputWithSupports(
  models: Array<ReturnType<typeof testModel>>,
  supports: DragonfruitImportFormat,
): BuildVoxlDocumentInput {
  return { ...testInput(models), supports };
}

async function streamSerialize(
  input: BuildVoxlDocumentInput,
  options?: Parameters<typeof serializeVoxlDocumentV2Streaming>[4],
) {
  const parts: Uint8Array[] = [];
  const res = await serializeVoxlDocumentV2Streaming(
    input,
    new Map(),
    undefined,
    (b) => { parts.push(b); },
    options,
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return { bytes, ...res };
}

test('the off-thread supportsCodec path is byte-identical to the inline SUPP path', async () => {
  await withFrozenClock(async () => {
    const supports = bigSupports();

    const inline = await serializeVoxlDocumentV2(
      inputWithSupports([testModel('m0')], supports),
      new Map(),
    );
    const viaCodec = await serializeVoxlDocumentV2(
      inputWithSupports([testModel('m0')], supports),
      new Map(),
      undefined,
      { supportsCodec: serializeSupportsChunk },
    );

    assert.deepEqual([...viaCodec], [...inline], 'off-thread SUPP must emit identical bytes');
  });
});

test('a warm SUPP cache skips the supportsCodec entirely (no rebuild, no clone)', async () => {
  await withFrozenClock(async () => {
    const supports = bigSupports();
    const cache = new VoxlChunkCache();
    let calls = 0;
    const countingCodec = (s: DragonfruitImportFormat) => {
      calls += 1;
      return serializeSupportsChunk(s);
    };

    // A stable supportsCacheKey means the 2nd tick's SUPP is a cache HIT, so the
    // codec must never be consulted — the fast path that also avoids the worker
    // clone when supports are unchanged.
    const opts = { chunkCache: cache, supportsCacheKey: 'k', supportsCodec: countingCodec };
    await serializeVoxlDocumentV2(inputWithSupports([testModel('m0')], supports), new Map(), undefined, opts);
    assert.equal(calls, 1, 'first tick is a miss → codec runs once');
    await serializeVoxlDocumentV2(inputWithSupports([testModel('m0')], supports), new Map(), undefined, opts);
    assert.equal(calls, 1, 'second tick is a cache hit → codec must not run again');
  });
});

test('the SUPP worker digest yields the same document fingerprint as inline', async () => {
  await withFrozenClock(async () => {
    const supports = bigSupports();

    const inline = await streamSerialize(
      inputWithSupports([testModel('m0')], supports),
      { chunkCache: new VoxlChunkCache() },
    );
    const viaCodec = await streamSerialize(
      inputWithSupports([testModel('m0')], supports),
      { chunkCache: new VoxlChunkCache(), supportsCodec: serializeSupportsChunk },
    );

    assert.notEqual(inline.fingerprint, '', 'a cache-enabled serialize must produce a fingerprint');
    assert.equal(viaCodec.fingerprint, inline.fingerprint, 'worker digest must match inline digest');
    assert.deepEqual([...viaCodec.bytes], [...inline.bytes], 'streaming bytes must also match');
  });
});
