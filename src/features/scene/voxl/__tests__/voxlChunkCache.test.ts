import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
} from '../codec-v2';
import { VoxlChunkCache } from '../voxlChunkCache';
import { testInput, testModel, withFrozenClock } from './voxlTestSupport';
import { bytesToBase64 } from '@/utils/base64';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';

const floats = (seed: number, verts: number): string => {
  const arr = new Float32Array(verts * 3);
  for (let i = 0; i < arr.length; i += 1) arr[i] = seed + i * 0.5;
  return bytesToBase64(new Uint8Array(arr.buffer));
};

const SOURCE = floats(1, 512);
const CAVITY = floats(2, 512);
const HOLE = floats(3, 512);

const hollowMods = (source: string, cavity: string, hole: string): ModelMeshModifiers => ({
  hollowing: {
    enabled: true,
    bakedIntoGeometry: true,
    mode: 'cavity',
    voxelSizeMm: 0.5,
    shellThicknessMm: 2,
    openFace: 'z_max',
    sourcePositionsBase64: source,
    sourcePositionCount: 512,
    cavityPositionsBase64: cavity,
    cavityPositionCount: 512,
  },
  holePunchesBakedIntoGeometry: true,
  holePunchSourcePositionsBase64: hole,
  holePunchSourcePositionCount: 512,
});

async function streamSerialize(
  input: ReturnType<typeof testInput>,
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

test('a chunk cache leaves output byte-identical to the no-cache path', async () => {
  await withFrozenClock(async () => {
    const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });

    const plain = await serializeVoxlDocumentV2(testInput([model]), new Map());
    const cache = new VoxlChunkCache();
    const cached = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, { chunkCache: cache });

    assert.deepEqual([...cached], [...plain], 'cache must not change the emitted bytes');
    assert.ok(cache.size > 0, 'the modifier/SUPP chunks should have populated the cache');
  });
});

test('a warm cache reproduces identical bytes on the next tick (cache hit path)', async () => {
  await withFrozenClock(async () => {
    const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });
    const cache = new VoxlChunkCache();

    const first = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, { chunkCache: cache });
    // Second serialize reuses the cache — the modifier chunks take the hit path.
    const second = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, { chunkCache: cache });

    assert.deepEqual([...second], [...first], 'a cache hit must emit the same bytes as a miss');
  });
});

test('the fingerprint is stable for identical input and changes when content changes', async () => {
  await withFrozenClock(async () => {
    const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });
    const cache = new VoxlChunkCache();

    const a = await streamSerialize(testInput([model]), { chunkCache: cache });
    const b = await streamSerialize(testInput([model]), { chunkCache: cache });
    assert.notEqual(a.fingerprint, '', 'a cache-enabled serialize must produce a fingerprint');
    assert.equal(a.fingerprint, b.fingerprint, 'identical input ⇒ identical fingerprint');

    // A transform edit changes MODL but not the modifier snapshots.
    const moved = testModel('m0', {
      meshModifiers: hollowMods(SOURCE, CAVITY, HOLE),
      transform: {
        position: { x: 5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const c = await streamSerialize(testInput([moved]), { chunkCache: cache });
    assert.notEqual(c.fingerprint, a.fingerprint, 'a moved model must change the fingerprint');
  });
});

test('a transform edit reuses the modifier snapshot chunks unchanged', async () => {
  await withFrozenClock(async () => {
    const cache = new VoxlChunkCache();
    const base = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });
    await streamSerialize(testInput([base]), { chunkCache: cache });
    const sizeAfterFirst = cache.size;

    // Same modifier snapshots (same base64 refs), only the transform differs.
    const moved = testModel('m0', {
      meshModifiers: hollowMods(SOURCE, CAVITY, HOLE),
      transform: {
        position: { x: 9, y: 1, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const movedOut = await streamSerialize(testInput([moved]), { chunkCache: cache });

    // The cache did not grow — the modifier chunks were reused, not re-added.
    assert.equal(cache.size, sizeAfterFirst, 'unchanged snapshots must not add cache entries');
    assert.equal(movedOut.skipped, false);
  });
});

test('write-skip: a matching previousFingerprint emits nothing and reports skipped', async () => {
  await withFrozenClock(async () => {
    const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });
    const cache = new VoxlChunkCache();

    const first = await streamSerialize(testInput([model]), { chunkCache: cache });
    assert.equal(first.skipped, false);
    assert.ok(first.bytes.length > 0);

    const again = await streamSerialize(testInput([model]), {
      chunkCache: cache,
      previousFingerprint: first.fingerprint,
    });
    assert.equal(again.skipped, true, 'identical fingerprint must skip the write');
    assert.equal(again.bytes.length, 0, 'a skipped write must emit no bytes');
  });
});

test('the chunk report flags a transform edit as MODL-changed, snapshots unchanged', async () => {
  await withFrozenClock(async () => {
    const cache = new VoxlChunkCache();
    const base = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) });

    // First tick: every chunk is new.
    const first = await streamSerialize(testInput([base]), { chunkCache: cache });
    assert.ok(first.chunkReport.length > 0, 'a cache-enabled serialize must report chunks');
    assert.ok(first.chunkReport.every((c) => c.isNew && c.changed), 'first tick ⇒ all chunks new');

    // Second tick: only the transform moved. MODL carries the transform JSON so
    // it changes; the HSRC/CAVT/PSRC snapshot chunks are byte-identical (local
    // frame) and must report unchanged + reused from cache.
    const moved = testModel('m0', {
      meshModifiers: hollowMods(SOURCE, CAVITY, HOLE),
      transform: {
        position: { x: 7, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const second = await streamSerialize(testInput([moved]), { chunkCache: cache });

    const byKey = (t: string) => second.chunkReport.find((c) => c.type === t);
    assert.equal(byKey('MODL')?.changed, true, 'a moved model must mark MODL changed');
    assert.equal(byKey('MODL')?.isNew, false, 'MODL existed last tick, so not new');
    for (const t of ['HSRC', 'CAVT', 'PSRC']) {
      const row = byKey(t);
      assert.ok(row, `expected a ${t} chunk in the report`);
      assert.equal(row?.changed, false, `${t} snapshot must be unchanged on a transform edit`);
      assert.equal(row?.source, 'cache', `${t} must be reused from the chunk cache`);
    }
  });
});

test('write-skip does not fire when the content changed', async () => {
  await withFrozenClock(async () => {
    const cache = new VoxlChunkCache();
    const first = await streamSerialize(
      testInput([testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY, HOLE) })]),
      { chunkCache: cache },
    );

    const changed = await streamSerialize(
      testInput([testModel('m0', { meshModifiers: hollowMods(floats(9, 512), CAVITY, HOLE) })]),
      { chunkCache: cache, previousFingerprint: first.fingerprint },
    );
    assert.equal(changed.skipped, false, 'changed content must not be skipped');
    assert.ok(changed.bytes.length > 0);
  });
});
