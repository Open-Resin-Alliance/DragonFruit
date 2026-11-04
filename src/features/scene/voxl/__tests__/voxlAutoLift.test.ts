import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import { readVoxlChunkText, testInput, testModel } from './voxlTestSupport';

test('auto-lift mode round-trips per model', async () => {
  const input = testInput([
    testModel('lifted', { autoLift: true }),
    testModel('placed'),
  ]);

  const parsed = await parseVoxlBinaryV2(await serializeVoxlDocumentV2(input, new Map()));
  const models = parsed.document.models;

  assert.equal(models.find((model) => model.id === 'lifted')?.autoLift, true);
  assert.equal(models.find((model) => model.id === 'placed')?.autoLift, undefined);
});

test('a scene that never used auto-lift writes no autoLift key', async () => {
  const bytes = await serializeVoxlDocumentV2(testInput(['m1']), new Map());
  const entries = JSON.parse(readVoxlChunkText(bytes, 'MODL')) as Record<string, unknown>[];

  assert.equal('autoLift' in entries[0], false);
});
