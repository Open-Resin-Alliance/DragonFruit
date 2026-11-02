import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeVoxlBodyChunk, parseVoxlBinaryV2, serializeVoxlDocumentV2 } from '../codec-v2';
import { testInput, testModel, readVoxlChunkText } from './voxlTestSupport';

test('multi-material assignments, bodies and material profiles round-trip', async () => {
  const bodies = [
    { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([0, 1, 2]) },
    { positions: new Float32Array([5, 0, 0, 6, 0, 0, 5, 1, 0]), index: null },
  ];
  const materials = [
    { id: 'mat-blue', name: 'Blue Resin', printerProfileId: 'printer-a' },
    { id: 'mat-yellow', name: 'Yellow Resin', printerProfileId: 'printer-a' },
  ];
  const input = {
    ...testInput([
      testModel('m1', {
        materialProfileId: 'mat-blue',
        materialBaseColor: '#a3a3a3',
        bodies,
        bodyCenter: { x: 2, y: 3, z: 4 },
        bodyMaterialProfileIds: ['mat-blue', 'mat-yellow'],
        bodyColors: ['#3b82f6', '#eab308'],
      }),
    ]),
    materials,
  };

  const parsed = await parseVoxlBinaryV2(await serializeVoxlDocumentV2(input, new Map()));
  const model = parsed.document.models[0];

  assert.equal(model.materialProfileId, 'mat-blue');
  assert.equal(model.materialBaseColor, '#a3a3a3');
  assert.equal(model.bodyCount, 2);
  assert.deepEqual(model.bodyMaterialProfileIds, ['mat-blue', 'mat-yellow']);
  assert.deepEqual(model.bodyColors, ['#3b82f6', '#eab308']);
  assert.deepEqual(parsed.document.materials, materials);

  const bodyBytes = parsed.bodyChunks?.get('m1');
  assert.ok(bodyBytes, 'the BODY chunk came back');
  const decoded = decodeVoxlBodyChunk(bodyBytes);
  assert.deepEqual(decoded.center, { x: 2, y: 3, z: 4 });
  assert.equal(decoded.bodies.length, 2);
  assert.deepEqual(Array.from(decoded.bodies[0].positions), Array.from(bodies[0].positions));
  assert.deepEqual(Array.from(decoded.bodies[0].index ?? []), [0, 1, 2]);
  assert.equal(decoded.bodies[1].index, null);
});

test('a single-material model writes no body fields and no BODY chunk', async () => {
  const bytes = await serializeVoxlDocumentV2(
    testInput([testModel('m1', { materialProfileId: 'mat-blue' })]),
    new Map(),
  );
  const parsed = await parseVoxlBinaryV2(bytes);
  const model = parsed.document.models[0];

  assert.equal('bodyCount' in model, false);
  assert.equal('bodyMaterialProfileIds' in model, false);
  assert.equal(parsed.bodyChunks?.size ?? 0, 0);
  const modl = JSON.parse(readVoxlChunkText(bytes, 'MODL')) as Array<Record<string, unknown>>;
  assert.equal('bodyCount' in modl[0], false);
});
