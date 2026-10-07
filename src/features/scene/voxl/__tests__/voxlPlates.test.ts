import assert from 'node:assert/strict';
import test from 'node:test';

import { readScenePlate } from '../codec';
import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import type { VoxlPrinterBundle } from '../types';
import { readVoxlChunkText, testInput } from './voxlTestSupport';

/** A chunk's JSON as an untyped record: these tests assert on the wire keys. */
function chunkRecord(bytes: Uint8Array, type: string): Record<string, unknown> {
  return JSON.parse(readVoxlChunkText(bytes, type)) as Record<string, unknown>;
}

test('plates round-trip with their ids and names', async () => {
  const input = {
    ...testInput(['m1']),
    plates: [{ id: 'plate-a', name: 'Left bed' }],
  };

  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(input, new Map()));

  assert.deepEqual(parsed.document.scene.plates, [{ id: 'plate-a', name: 'Left bed' }]);
});

test('a scene with no plates writes no plates key at all', async () => {
  const scene = chunkRecord(await serializeVoxlDocumentV2(testInput(['m1']), new Map()), 'SCNE');

  assert.equal('plates' in scene, false);
  assert.equal('plateName' in scene, false);
});

test('one named plate also writes the older plateName shorthand', async () => {
  const input = { ...testInput(['m1']), plates: [{ id: 'plate-a', name: 'Left bed' }] };
  const scene = chunkRecord(await serializeVoxlDocumentV2(input, new Map()), 'SCNE');

  assert.equal(scene.plateName, 'Left bed');
});

test('an unnamed plate writes no shorthand, and several plates cannot', async () => {
  const unnamed = chunkRecord(
    await serializeVoxlDocumentV2({ ...testInput(['m1']), plates: [{ id: 'plate-a' }] }, new Map()),
    'SCNE',
  );
  assert.equal('plateName' in unnamed, false);

  const twoPlates = chunkRecord(
    await serializeVoxlDocumentV2(
      {
        ...testInput(['m1']),
        plates: [{ id: 'plate-a', name: 'Left bed' }, { id: 'plate-b', name: 'Right bed' }],
      },
      new Map(),
    ),
    'SCNE',
  );
  assert.equal('plateName' in twoPlates, false);

  const plates = twoPlates.plates;
  assert.ok(Array.isArray(plates), 'both plates are written');
  assert.equal(plates.length, 2);
});

test('readScenePlate prefers the plate list and falls back to the shorthand', () => {
  assert.deepEqual(
    readScenePlate({ activeModelId: null, selectedModelIds: [], plates: [{ id: 'p1', name: 'Bed' }], plateName: 'Stale' }),
    { id: 'p1', name: 'Bed' },
  );

  // A file written before plates carries only the shorthand.
  assert.deepEqual(
    readScenePlate({ activeModelId: null, selectedModelIds: [], plateName: 'Bed' }),
    { id: null, name: 'Bed' },
  );

  // Neither: one unnamed plate, whose identity the caller mints.
  assert.deepEqual(
    readScenePlate({ activeModelId: null, selectedModelIds: [] }),
    { id: null, name: null },
  );

  // Empty strings are absent values, not names.
  assert.deepEqual(
    readScenePlate({ activeModelId: null, selectedModelIds: [], plates: [{ id: 'p1', name: '' }] }),
    { id: 'p1', name: null },
  );
});

test('the printer a scene was written for round-trips in the document meta', async () => {
  const printer: VoxlPrinterBundle = {
    version: 1,
    printer: {
      name: 'Saturn 4 Ultra',
      officialPresetId: 'elegoo-saturn-4-ultra',
      buildVolumeMm: { width: 218.88, depth: 122.88, height: 220 },
    },
    materials: [{ id: 'material-1', name: 'Standard Grey' }],
  };

  const binary = await serializeVoxlDocumentV2(
    { ...testInput(['m1']), meta: { generator: 'DragonFruit', printer } },
    new Map(),
  );

  assert.deepEqual(parseVoxlBinaryV2(binary).document.meta.printer, printer);
  assert.deepEqual(chunkRecord(binary, 'META').printer, printer);
});

test('a scene with no printer selected writes no printer key', async () => {
  const meta = chunkRecord(await serializeVoxlDocumentV2(testInput(['m1']), new Map()), 'META');

  assert.equal('printer' in meta, false);
});
