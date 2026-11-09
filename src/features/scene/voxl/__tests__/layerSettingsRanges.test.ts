import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseVoxlBinaryV2,
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
} from '../codec-v2';
import type { BuildVoxlDocumentInput } from '../types';
import { VoxlChunkCache } from '../voxlChunkCache';
import {
  readVoxlChunkText,
  testInput,
  withFrozenClock,
} from './voxlTestSupport';
import {
  compileLayerSettingsRanges,
  resolveLayerSettingsAt,
  type LayerSettingsRange,
} from '@/features/slicing/layerSettingsRanges';

function ranges(): LayerSettingsRange[] {
  return [
    { id: 'A', startLayer: 3, endLayer: 10, settings: { exposureSec: 4, liftHeightMm: 8 } },
    { id: 'B', startLayer: 5, endLayer: 6, settings: { exposureSec: 7 } },
    { id: 'C', startLayer: 6, endLayer: 7, settings: { exposureSec: 9 } },
  ];
}

function layerSix(stored: readonly LayerSettingsRange[]) {
  return compileLayerSettingsRanges(stored, 12)
    .find((segment) => segment.startLayer <= 6 && segment.endLayer >= 6)?.settings;
}

async function streamSerialize(
  input: BuildVoxlDocumentInput,
  options: Parameters<typeof serializeVoxlDocumentV2Streaming>[4],
) {
  const parts: Uint8Array[] = [];
  const result = await serializeVoxlDocumentV2Streaming(
    input,
    new Map(),
    undefined,
    (bytes) => { parts.push(bytes); },
    options,
  );
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, ...result };
}

function chunkDirectoryBase(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < view.getUint32(8, true); index += 1) {
    const base = 16 + index * 20;
    if (new TextDecoder().decode(bytes.subarray(base, base + 4)) === type) return base;
  }
  throw new Error(`Missing ${type} chunk`);
}

/** Replace only SCNE so malformed input reaches the reader, not writer validation. */
function withStoredRanges(bytes: Uint8Array, value: unknown): Uint8Array {
  const scene = JSON.parse(readVoxlChunkText(bytes, 'SCNE')) as Record<string, unknown>;
  scene.layerSettingsRanges = value;
  const raw = new TextEncoder().encode(JSON.stringify(scene));
  const out = new Uint8Array(bytes.length + raw.length);
  out.set(bytes);
  out.set(raw, bytes.length);
  const view = new DataView(out.buffer);
  const base = chunkDirectoryBase(out, 'SCNE');
  view.setUint16(base + 6, 0, true);
  view.setUint32(base + 8, bytes.length, true);
  view.setUint32(base + 12, raw.length, true);
  view.setUint32(base + 16, raw.length, true);
  return out;
}

test('stored ranges retain equal-span priority and wider motion inheritance', async () => {
  const input = { ...testInput(['m1']), layerSettingsRanges: ranges() };
  const pending = serializeVoxlDocumentV2(input, new Map());
  input.layerSettingsRanges[2].settings.exposureSec = 11;
  input.layerSettingsRanges.reverse();
  const bytes = await pending;
  const { document } = await parseVoxlBinaryV2(bytes);

  assert.deepEqual(document.scene.layerSettingsRanges, ranges());
  assert.deepEqual(layerSix(document.scene.layerSettingsRanges!), { exposureSec: 9, liftHeightMm: 8 });
  assert.deepEqual(
    (JSON.parse(readVoxlChunkText(bytes, 'SCNE')) as Record<string, unknown>).layerSettingsRanges,
    ranges(),
  );
  assert.equal(new DataView(bytes.buffer).getUint16(4, true), 2);
});

test('millimetre ranges reopen as physical bounds and follow the selected layer height', async () => {
  const stored: LayerSettingsRange[] = [
    { id: 'legacy', startLayer: 1, endLayer: 100, settings: { waitTimeAfterLiftSec: 0 } },
    { id: 'A-mm', unit: 'mm', startMm: 0.15, endMm: 0.5, settings: { exposureSec: 4, liftHeightMm: 8 } },
    { id: 'B-mm', unit: 'mm', startMm: 0.25, endMm: 0.3, settings: { exposureSec: 7 } },
    { id: 'C-mm', unit: 'mm', startMm: 0.3, endMm: 0.35, settings: { exposureSec: 9 } },
  ];
  const bytes = await serializeVoxlDocumentV2({ ...testInput(['m1']), layerSettingsRanges: stored }, new Map());
  const reopened = (await parseVoxlBinaryV2(bytes)).document.scene.layerSettingsRanges!;
  assert.deepEqual(reopened, stored);
  assert.deepEqual(JSON.parse(readVoxlChunkText(bytes, 'SCNE')).layerSettingsRanges, stored);
  for (const range of reopened) {
    if (range.unit !== 'mm') continue;
    assert.equal(Object.hasOwn(range, 'startLayer'), false);
    assert.equal(Object.hasOwn(range, 'endLayer'), false);
  }
  const at = (height: number, layer: number) => compileLayerSettingsRanges(reopened, 24, height)
    .find((segment) => segment.startLayer <= layer && layer <= segment.endLayer)?.settings;
  assert.deepEqual(at(0.05, 6), { exposureSec: 9, waitTimeAfterLiftSec: 0, liftHeightMm: 8 });
  assert.deepEqual(at(0.025, 6), { exposureSec: 4, waitTimeAfterLiftSec: 0, liftHeightMm: 8 });
  assert.deepEqual(at(0.025, 12), { exposureSec: 9, waitTimeAfterLiftSec: 0, liftHeightMm: 8 });
  assert.deepEqual(reopened, stored, 'resolving another grid never rewrites physical bounds');
});

test('a raw millimetre-bound edit cannot be skipped merely because the current grid is unchanged', async () => {
  await withFrozenClock(async () => {
    const chunkCache = new VoxlChunkCache();
    const original: LayerSettingsRange[] = [{ id: 'mm', unit: 'mm', startMm: 0.15, endMm: 0.5, settings: { exposureSec: 4 } }];
    const edited: LayerSettingsRange[] = [{ id: 'mm', unit: 'mm', startMm: 0.149, endMm: 0.5, settings: { exposureSec: 4 } }];
    assert.deepEqual(compileLayerSettingsRanges(original, 12, 0.05), compileLayerSettingsRanges(edited, 12, 0.05));
    const first = await streamSerialize({ ...testInput(['m1']), layerSettingsRanges: original }, { chunkCache });
    const changed = await streamSerialize({ ...testInput(['m1']), layerSettingsRanges: edited }, {
      chunkCache,
      previousFingerprint: first.fingerprint,
    });
    assert.equal(changed.skipped, false);
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.deepEqual(changed.chunkReport.filter((chunk) => chunk.changed).map((chunk) => chunk.type), ['SCNE']);
    assert.deepEqual((await parseVoxlBinaryV2(changed.bytes)).document.scene.layerSettingsRanges, edited);
  });
});

test('a legacy absent schedule stays absent while an explicit cleared schedule survives reopening', async () => {
  const legacy = await serializeVoxlDocumentV2(testInput(['m1']), new Map());
  const cleared = await serializeVoxlDocumentV2(
    { ...testInput(['m1']), layerSettingsRanges: [] },
    new Map(),
  );
  const legacyScene = (await parseVoxlBinaryV2(legacy)).document.scene;
  const clearedScene = (await parseVoxlBinaryV2(cleared)).document.scene;

  assert.equal(Object.hasOwn(legacyScene, 'layerSettingsRanges'), false);
  assert.equal(Object.hasOwn(JSON.parse(readVoxlChunkText(legacy, 'SCNE')), 'layerSettingsRanges'), false);
  assert.equal(Object.hasOwn(clearedScene, 'layerSettingsRanges'), true);
  assert.deepEqual(clearedScene.layerSettingsRanges, []);
  assert.deepEqual(JSON.parse(readVoxlChunkText(cleared, 'SCNE')).layerSettingsRanges, []);
});

test('range-only edits and clearing invalidate a cached streamed write without clock changes', async () => {
  await withFrozenClock(async () => {
    const chunkCache = new VoxlChunkCache();
    const input = { ...testInput(['m1']), layerSettingsRanges: ranges() };
    const first = await streamSerialize(input, { chunkCache });
    const unchanged = await streamSerialize(input, {
      chunkCache,
      previousFingerprint: first.fingerprint,
    });
    assert.notEqual(first.fingerprint, '');
    assert.equal(first.skipped, false);
    assert.equal(unchanged.fingerprint, first.fingerprint);
    assert.equal(unchanged.skipped, true);
    assert.equal(unchanged.bytes.length, 0);
    assert.ok(unchanged.chunkReport.every((chunk) => !chunk.changed));

    const editedRanges = ranges();
    editedRanges[2].settings.exposureSec = 11;
    const edited = await streamSerialize({ ...input, layerSettingsRanges: editedRanges }, {
      chunkCache,
      previousFingerprint: first.fingerprint,
    });
    assert.notEqual(edited.fingerprint, first.fingerprint);
    assert.equal(edited.skipped, false);
    assert.ok(edited.bytes.length > 0);
    assert.deepEqual(edited.chunkReport.filter((chunk) => chunk.changed).map((chunk) => chunk.type), ['SCNE']);
    const editedScene = (await parseVoxlBinaryV2(edited.bytes)).document.scene;
    assert.deepEqual(layerSix(editedScene.layerSettingsRanges!), { exposureSec: 11, liftHeightMm: 8 });

    const clearedInput = { ...input, layerSettingsRanges: [] };
    const cleared = await streamSerialize(clearedInput, {
      chunkCache,
      previousFingerprint: edited.fingerprint,
    });
    assert.notEqual(cleared.fingerprint, edited.fingerprint);
    assert.equal(cleared.skipped, false);
    assert.ok(cleared.bytes.length > 0);
    assert.deepEqual(cleared.chunkReport.filter((chunk) => chunk.changed).map((chunk) => chunk.type), ['SCNE']);
    assert.deepEqual((await parseVoxlBinaryV2(cleared.bytes)).document.scene.layerSettingsRanges, []);

    const clearedAgain = await streamSerialize(clearedInput, {
      chunkCache,
      previousFingerprint: cleared.fingerprint,
    });
    assert.equal(clearedAgain.fingerprint, cleared.fingerprint);
    assert.equal(clearedAgain.skipped, true);
    assert.equal(clearedAgain.bytes.length, 0);
    assert.ok(clearedAgain.chunkReport.every((chunk) => !chunk.changed));
  });
});

test('the writer rejects a malformed present schedule rather than clearing it', async () => {
  await assert.rejects(
    serializeVoxlDocumentV2(
      { ...testInput(['m1']), layerSettingsRanges: null as unknown as LayerSettingsRange[] },
      new Map(),
    ),
    /Invalid layer settings range: expected an array/,
  );
});

test('malformed stored schedules fail before eager or deferred mesh processing', async (t) => {
  const bytes = await serializeVoxlDocumentV2(
    testInput(['m1']),
    new Map([[0, new Uint8Array([0])]]),
  );
  // Deliberately invalid zlib: range errors must win before bulk mesh inflation.
  new DataView(bytes.buffer).setUint16(chunkDirectoryBase(bytes, 'MESH') + 6, 1, true);
  const valid = ranges()[0];
  const malformed: Array<[string, unknown]> = [
    ['null collection', null],
    ['object collection', {}],
    ['null range', [null]],
    ['duplicate ids', [valid, valid]],
    ['inverted endpoints', [{ ...valid, startLayer: 11 }]],
    ['fractional endpoint', [{ ...valid, startLayer: 3.5 }]],
    ['unknown range key', [{ ...valid, color: '#ffffff' }]],
    ['fractional layer blur', [{ ...valid, blendStart: 0.5 }]],
    ['null edge blur', [{ ...valid, blendEnd: null }]],
    ['null settings', [{ ...valid, settings: null }]],
    ['empty settings', [{ ...valid, settings: {} }]],
    ['null field', [{ ...valid, settings: { exposureSec: null } }]],
    ['unknown field', [{ ...valid, settings: { exposureSec: 4, layerHeightMm: 0.05 } }]],
  ];
  for (const [name, value] of malformed) {
    await t.test(name, async () => {
      for (const deferMeshChunks of [false, true]) {
        await assert.rejects(
          parseVoxlBinaryV2(withStoredRanges(bytes, value), { deferMeshChunks }),
          /Invalid layer settings range:/,
        );
      }
    });
  }
});

test('layer and millimetre edge blurs reopen with their distances and effective inheritance intact', async () => {
  const stored: LayerSettingsRange[] = [
    { id: 'wide', startLayer: 1, endLayer: 30, settings: { exposureSec: 4, liftHeightMm: 8 } },
    { id: 'layers', startLayer: 10, endLayer: 20, blendStart: 2, blendEnd: 3, settings: { exposureSec: 8 } },
    { id: 'mm', unit: 'mm', startMm: 0.125, endMm: 0.375, blendEnd: 0.125, settings: { exposureSec: 12 } },
  ];
  const input = { ...testInput(['m1']), layerSettingsRanges: stored };
  const eager = await serializeVoxlDocumentV2(input, new Map());
  const streamed = await streamSerialize(input, {});
  for (const bytes of [eager, streamed.bytes]) {
    const reopened = (await parseVoxlBinaryV2(bytes)).document.scene.layerSettingsRanges!;
    assert.deepEqual(reopened, stored);
    assert.deepEqual(resolveLayerSettingsAt(reopened, 11, { exposureSec: 2 }, 0.05), { exposureSec: 8, liftHeightMm: 8 });
    assert.deepEqual(resolveLayerSettingsAt(reopened, 5, { exposureSec: 2 }, 0.0625), { exposureSec: 12, liftHeightMm: 8 });
    assert.deepEqual(resolveLayerSettingsAt(reopened, 7, { exposureSec: 2 }, 0.0625), { exposureSec: 8, liftHeightMm: 8 });
    assert.deepEqual(resolveLayerSettingsAt(reopened, 8, { exposureSec: 2 }, 0.0625), { exposureSec: 4, liftHeightMm: 8 });
  }
});

test('a blur-only edit changes streamed scene content even with unchanged coverage and clock', async () => {
  await withFrozenClock(async () => {
    const chunkCache = new VoxlChunkCache();
    const original: LayerSettingsRange[] = [{ id: 'edge', startLayer: 3, endLayer: 10, blendStart: 1, settings: { exposureSec: 8 } }];
    const edited: LayerSettingsRange[] = [{ ...original[0], blendStart: 2 }];
    assert.deepEqual(compileLayerSettingsRanges(original, 12), compileLayerSettingsRanges(edited, 12));
    const first = await streamSerialize({ ...testInput(['m1']), layerSettingsRanges: original }, { chunkCache });
    const changed = await streamSerialize({ ...testInput(['m1']), layerSettingsRanges: edited }, { chunkCache, previousFingerprint: first.fingerprint });
    assert.equal(changed.skipped, false);
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.deepEqual(changed.chunkReport.filter((chunk) => chunk.changed).map((chunk) => chunk.type), ['SCNE']);
    assert.deepEqual((await parseVoxlBinaryV2(changed.bytes)).document.scene.layerSettingsRanges, edited);
  });
});
