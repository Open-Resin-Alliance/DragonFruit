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
