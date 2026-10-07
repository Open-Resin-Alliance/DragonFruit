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

// The serializer needs the mesh bytes and their content hashes, or it writes MESH
// chunks it has no payload for.
const MESH = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const meshes = (count: number) =>
  new Map<number, Uint8Array>(Array.from({ length: count }, (_, index) => [index, MESH] as const));
const shas = (count: number) =>
  new Map<number, string>(Array.from({ length: count }, (_, index) => [index, `sha-${index}`] as const));

// V2.6. The point of storing the volume, rather than only the profile id, is that a
// plate can be checked against the machine it is opened on. A writer that dropped the
// volume, or a reader that lost it, would leave that check with nothing to run.
test('the printer a scene was packed for round-trips, volume included', async () => {
  const source = input(['a']);
  source.printer = {
    profileId: 'photon-mono-4-ultra',
    name: 'Photon Mono 4 Ultra',
    buildVolume: {
      widthMm: 200,
      depthMm: 125,
      maxZMm: 220,
      originMode: 'front_left',
      safetyMarginMm: { front: 2, back: 2, left: 2, right: 2 },
    },
  };

  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(source, meshes(1), shas(1)));

  assert.deepEqual(parsed.document.scene.printer, source.printer);
});

// Absent is not a mismatch: a reader with no printer knows what the scene holds, not
// what it was built to fit, so there is nothing to compare against.
test('a scene saved without a printer writes no printer field', async () => {
  const parsed = parseVoxlBinaryV2(await serializeVoxlDocumentV2(input(['a']), meshes(1), shas(1)));

  assert.equal(parsed.document.scene.printer, undefined);
});
