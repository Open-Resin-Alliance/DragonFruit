import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
  parseVoxlBinaryV2,
  VOXL_V2,
  VOXL_V2_SEMANTIC_REVISION,
  VOXL_V2_INLINE_REVISION,
} from '../codec-v2';
import { countVoxlChunks, readVoxlVersion, testInput, testModel, withFrozenClock } from './voxlTestSupport';
import { bytesToBase64 } from '@/utils/base64';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';

// Distinctive Float32-sized blobs. Content identity (not SHA) keys the dedup, so
// any stable byte pattern that base64-encodes deterministically works.
const floats = (seed: number, verts: number): string => {
  const arr = new Float32Array(verts * 3);
  for (let i = 0; i < arr.length; i += 1) arr[i] = seed + i * 0.5;
  return bytesToBase64(new Uint8Array(arr.buffer));
};

const SOURCE = floats(1, 64);
const CAVITY = floats(2, 32);
const HOLE = floats(3, 48);

const hollowMods = (source: string, cavity: string): ModelMeshModifiers => ({
  hollowing: {
    enabled: true,
    bakedIntoGeometry: true,
    mode: 'cavity',
    voxelSizeMm: 0.5,
    shellThicknessMm: 2,
    openFace: 'z_max',
    sourcePositionsBase64: source,
    sourcePositionCount: 64,
    cavityPositionsBase64: cavity,
    cavityPositionCount: 32,
  },
  holePunchesBakedIntoGeometry: true,
  holePunchSourcePositionsBase64: HOLE,
  holePunchSourcePositionCount: 48,
});

test('modifier snapshots move into HSRC/CAVT/PSRC chunks and round-trip byte-for-byte', async () => {
  const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY) });
  const bin = await serializeVoxlDocumentV2(testInput([model]), new Map());

  // The blobs are no longer inside MODL: header stays V2 (no MESH dedup fired),
  // and one chunk of each modifier type is present.
  assert.equal(readVoxlVersion(bin), VOXL_V2, 'a modifier-only file must stay V2');
  assert.equal(countVoxlChunks(bin, 'HSRC'), 1);
  assert.equal(countVoxlChunks(bin, 'CAVT'), 1);
  assert.equal(countVoxlChunks(bin, 'PSRC'), 1);

  const { document } = parseVoxlBinaryV2(bin);
  const mm = document.models[0].meshModifiers!;
  assert.equal(mm.hollowing!.sourcePositionsBase64, SOURCE, 'source snapshot round-trips exactly');
  assert.equal(mm.hollowing!.cavityPositionsBase64, CAVITY, 'cavity snapshot round-trips exactly');
  assert.equal(mm.holePunchSourcePositionsBase64, HOLE, 'hole-punch snapshot round-trips exactly');
  // Pointers are an on-disk detail; the re-attached in-memory shape has none.
  assert.equal(mm.hollowing!.sourceChunkIndex, undefined);
  assert.equal(mm.hollowing!.cavityChunkIndex, undefined);
  assert.equal(mm.holePunchSourceChunkIndex, undefined);
});

test('identical snapshots across models collapse to one chunk per type, and both re-attach', async () => {
  const a = testModel('a', { meshModifiers: hollowMods(SOURCE, CAVITY) });
  const b = testModel('b', { meshModifiers: hollowMods(SOURCE, CAVITY) });
  const bin = await serializeVoxlDocumentV2(testInput([a, b]), new Map());

  assert.equal(countVoxlChunks(bin, 'HSRC'), 1, '2 identical source snapshots → 1 HSRC chunk');
  assert.equal(countVoxlChunks(bin, 'CAVT'), 1);
  assert.equal(countVoxlChunks(bin, 'PSRC'), 1);
  // Modifier-blob dedup is invisible to old readers → no header bump.
  assert.equal(readVoxlVersion(bin), VOXL_V2, 'modifier dedup must not bump the header');

  const { document } = parseVoxlBinaryV2(bin);
  for (const m of document.models) {
    assert.equal(m.meshModifiers!.hollowing!.sourcePositionsBase64, SOURCE);
    assert.equal(m.meshModifiers!.hollowing!.cavityPositionsBase64, CAVITY);
    assert.equal(m.meshModifiers!.holePunchSourcePositionsBase64, HOLE);
  }
});

test('distinct snapshots keep distinct chunks and map to the right owner', async () => {
  const otherSource = floats(9, 64);
  const a = testModel('a', { meshModifiers: hollowMods(SOURCE, CAVITY) });
  const b = testModel('b', { meshModifiers: hollowMods(otherSource, CAVITY) });
  const bin = await serializeVoxlDocumentV2(testInput([a, b]), new Map());

  assert.equal(countVoxlChunks(bin, 'HSRC'), 2, 'differing source snapshots must not share a chunk');
  assert.equal(countVoxlChunks(bin, 'CAVT'), 1, 'shared cavity snapshot still dedups');

  const { document } = parseVoxlBinaryV2(bin);
  assert.equal(document.models[0].meshModifiers!.hollowing!.sourcePositionsBase64, SOURCE);
  assert.equal(document.models[1].meshModifiers!.hollowing!.sourcePositionsBase64, otherSource);
});

test('chunkModifierSnapshots:false keeps snapshots inline (2.1 layout) and still round-trips', async () => {
  const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY) });
  const bin = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, {
    chunkModifierSnapshots: false,
  });

  // Format-preserving write: no modifier chunks, base64 stays in MODL.
  assert.equal(countVoxlChunks(bin, 'HSRC'), 0);
  assert.equal(countVoxlChunks(bin, 'CAVT'), 0);
  assert.equal(countVoxlChunks(bin, 'PSRC'), 0);

  const { document } = parseVoxlBinaryV2(bin);
  const mm = document.models[0].meshModifiers!;
  assert.equal(mm.hollowing!.sourcePositionsBase64, SOURCE);
  assert.equal(mm.hollowing!.cavityPositionsBase64, CAVITY);
  assert.equal(mm.holePunchSourcePositionsBase64, HOLE);
});

test('the chunking flag is byte-neutral for scenes without modifier snapshots', async () => {
  await withFrozenClock(async () => {
    const plain = testModel('m0');
    const chunked = await serializeVoxlDocumentV2(testInput([plain]), new Map(), undefined, {
      chunkModifierSnapshots: true,
    });
    const inline = await serializeVoxlDocumentV2(testInput([plain]), new Map(), undefined, {
      chunkModifierSnapshots: false,
    });
    assert.deepEqual([...inline], [...chunked], 'no-snapshot scenes must serialize identically either way');
  });
});

test('sourceVersion distinguishes chunked (2.2) from inline (2.1) — the no-downgrade signal', async () => {
  const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY) });

  const chunked = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, {
    chunkModifierSnapshots: true,
  });
  assert.equal(parseVoxlBinaryV2(chunked).sourceVersion, VOXL_V2_SEMANTIC_REVISION, 'chunked file reads as 2.2');

  const inline = await serializeVoxlDocumentV2(testInput([model]), new Map(), undefined, {
    chunkModifierSnapshots: false,
  });
  assert.equal(parseVoxlBinaryV2(inline).sourceVersion, VOXL_V2_INLINE_REVISION, 'inline file reads as 2.1');
});

test('buffered and streaming writers stay byte-identical with modifier chunks', async () => {
  const model = testModel('m0', { meshModifiers: hollowMods(SOURCE, CAVITY) });

  await withFrozenClock(async () => {
    const buffered = await serializeVoxlDocumentV2(testInput([model]), new Map());

    const parts: Uint8Array[] = [];
    await serializeVoxlDocumentV2Streaming(testInput([model]), new Map(), undefined, (b) => {
      parts.push(b);
    });
    const total = parts.reduce((n, p) => n + p.length, 0);
    const streamed = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      streamed.set(p, off);
      off += p.length;
    }

    assert.deepEqual([...streamed], [...buffered], 'both writers must emit identical bytes');
  });
});
