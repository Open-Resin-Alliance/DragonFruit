import assert from 'node:assert/strict';
import test from 'node:test';

import { readScenePlates } from '../codec';
import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import type { VoxlPrinterBundle } from '../types';
import { readVoxlChunkText, testInput } from './voxlTestSupport';

/** A chunk's JSON as an untyped record: these tests assert on the wire keys. */
function chunkRecord(bytes: Uint8Array, type: string): Record<string, unknown> {
  return JSON.parse(readVoxlChunkText(bytes, type)) as Record<string, unknown>;
}

/** The same, for a chunk whose payload is a list of entries (MODL). */
function chunkEntries(bytes: Uint8Array, type: string): Record<string, unknown>[] {
  const parsed = chunkRecord(bytes, type);
  if (!Array.isArray(parsed)) throw new Error(`${type} is not a list of entries`);
  return parsed as Record<string, unknown>[];
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

test('readScenePlates takes a plate list at its word', () => {
  assert.deepEqual(
    readScenePlates({
      activeModelId: null,
      selectedModelIds: [],
      plates: [{ id: 'p1', name: 'Bed' }, { id: 'p2' }],
      activePlateId: 'p2',
      plateName: 'Stale shorthand',
    }),
    { plates: [{ id: 'p1', name: 'Bed' }, { id: 'p2' }], legacyName: null, activePlateId: 'p2' },
  );
});

test('readScenePlates falls back to the shorthand and to a plate with no identity', () => {
  // A file written before plates carries only the shorthand.
  assert.deepEqual(
    readScenePlates({ activeModelId: null, selectedModelIds: [], plateName: 'Bed' }),
    { plates: [], legacyName: 'Bed', activePlateId: null },
  );

  // Neither: one plate, whose identity the caller mints.
  assert.deepEqual(
    readScenePlates({ activeModelId: null, selectedModelIds: [] }),
    { plates: [], legacyName: null, activePlateId: null },
  );
});

test('readScenePlates ignores a cursor that names no plate, and drops empty names', () => {
  assert.deepEqual(
    readScenePlates({
      activeModelId: null,
      selectedModelIds: [],
      plates: [{ id: 'p1', name: '' }],
      activePlateId: 'gone',
    }),
    { plates: [{ id: 'p1' }], legacyName: null, activePlateId: 'p1' },
  );
});

test('plate membership and the active cursor round-trip', async () => {
  const input = {
    ...testInput(['m1', 'm2']),
    plates: [{ id: 'plate-a', name: 'Left bed' }, { id: 'plate-b', name: 'Right bed' }],
    activePlateId: 'plate-b',
  };
  input.models[1].plateId = 'plate-b';

  const binary = await serializeVoxlDocumentV2(input, new Map());
  const parsed = parseVoxlBinaryV2(binary);

  assert.equal(parsed.document.scene.activePlateId, 'plate-b');
  assert.equal(parsed.document.models[1].plateId, 'plate-b');
  // The first plate needs no membership field, so a model on it stays bare.
  assert.equal('plateId' in parsed.document.models[0], false);
});

test('a model on the first plate writes no membership key', async () => {
  const input = {
    ...testInput(['m1']),
    plates: [{ id: 'plate-a', name: 'Left bed' }],
    activePlateId: 'plate-a',
  };
  input.models[0].plateId = 'plate-a';

  const modl = chunkEntries(await serializeVoxlDocumentV2(input, new Map()), 'MODL');

  assert.equal('plateId' in modl[0], false);
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
