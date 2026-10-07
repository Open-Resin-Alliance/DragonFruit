import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeVoxlDocumentV2, parseVoxlBinaryV2 } from '../codec-v2';
import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
} as unknown as DragonfruitImportFormat;

function model(id: string): VoxlModelRuntimeLike {
  return {
    id,
    name: id,
    visible: true,
    color: '#ffffff',
    polygonCount: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'embedded-file', fileName: `${id}.stl`, mimeType: 'model/stl' },
  };
}

function input(ids: string[]): BuildVoxlDocumentInput {
  return {
    models: ids.map(model),
    activeModelId: ids[0] ?? null,
    selectedModelIds: [],
    supports: EMPTY_SUPPORTS,
  };
}

// The serializer takes the mesh bytes and their content hashes; without them it
// writes MESH chunks it has no payload for and the parse trips over them.
const MESH = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const meshes = (count: number) =>
  new Map<number, Uint8Array>(Array.from({ length: count }, (_, index) => [index, MESH] as const));
const shas = (count: number) =>
  new Map<number, string>(Array.from({ length: count }, (_, index) => [index, `sha-${index}`] as const));

// V2.5. The plate fields are the whole revision, so the round trip is the thing to
// pin: a writer that drops them, or a reader that stops passing them through, loses
// the plates silently and every scene opens as one plate again.
test('a scene with plates round-trips them, and which plate a model is on', async () => {
  const source = input(['a', 'b']);
  source.plates = [
    { id: 'p1', name: 'Plate 1' },
    { id: 'p2', name: 'Spare' },
  ];
  source.activePlateId = 'p2';
  // The second model sits on the second plate; the first stays on the default.
  source.models = source.models.map((entry, index) => (index === 1 ? { ...entry, plateId: 'p2' } : entry));

  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(source, meshes(2), shas(2)));

  assert.deepEqual(parsed.document.scene.plates, [
    { id: 'p1', name: 'Plate 1' },
    { id: 'p2', name: 'Spare' },
  ]);
  assert.equal(parsed.document.scene.activePlateId, 'p2');
  assert.equal(parsed.document.models[0]?.plateId, undefined);
  assert.equal(parsed.document.models[1]?.plateId, 'p2');
});

// The other half of the revision's contract: a single-plate scene writes nothing, so
// its bytes stay comparable with a V2.4 write and an older reader sees no change.
test('a single-plate scene writes no plate fields at all', async () => {
  const source = input(['a']);
  source.plates = [{ id: 'p1', name: 'Plate 1' }];
  source.activePlateId = 'p1';

  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(source, meshes(1), shas(1)));

  assert.equal(parsed.document.scene.plates, undefined);
  assert.equal(parsed.document.scene.activePlateId, undefined);
  assert.equal(parsed.document.models[0]?.plateId, undefined);
});
