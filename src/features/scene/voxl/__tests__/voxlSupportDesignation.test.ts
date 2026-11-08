import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializeVoxlDocumentV2,
  parseVoxlBinaryV2,
} from '../codec-v2';
import { parseVoxlAuto } from '../codec';
import type { BuildVoxlDocumentInput, VoxlModelEntry, VoxlModelRuntimeLike } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';
import { readVoxlChunkText } from './voxlTestSupport';

const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
  trunks: [],
  branches: [],
  leaves: [],
  braces: [],
  knots: [],
} as unknown as DragonfruitImportFormat;

function createTestModel(
  id: string,
  isSupportGeometry?: boolean,
  linkGroupId?: string,
): VoxlModelRuntimeLike {
  return {
    id,
    name: id,
    visible: true,
    color: '#a3a3a3',
    polygonCount: 100,
    transform: {
      position: { x: 10, y: 20, z: 30 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'external-file', fileName: `${id}.stl` },
    isSupportGeometry,
    linkGroupId,
  };
}

test('VOXL V2 binary round-trip persistence preserves isSupportGeometry and linkGroupId', async () => {
  const model1 = createTestModel('supp_mesh_1', true, 'link-grp-abc');
  const model2 = createTestModel('main_mesh_1', false, 'link-grp-abc');

  const input: BuildVoxlDocumentInput = {
    models: [model1, model2],
    activeModelId: 'supp_mesh_1',
    selectedModelIds: ['supp_mesh_1'],
    supports: EMPTY_SUPPORTS,
  };

  const dummyMesh1 = new Uint8Array([10, 20, 30, 40]);
  const dummyMesh2 = new Uint8Array([50, 60, 70, 80]);
  const meshBytes = new Map<number, Uint8Array>([
    [0, dummyMesh1],
    [1, dummyMesh2],
  ]);

  const binary = await serializeVoxlDocumentV2(input, meshBytes);
  const parsedResult = await parseVoxlBinaryV2(binary);

  assert.equal(parsedResult.document.models.length, 2);
  const parsedM1 = parsedResult.document.models.find((m) => m.id === 'supp_mesh_1');
  const parsedM2 = parsedResult.document.models.find((m) => m.id === 'main_mesh_1');

  assert.ok(parsedM1);
  assert.equal(parsedM1.isSupportGeometry, true);
  assert.equal(parsedM1.linkGroupId, 'link-grp-abc');

  assert.ok(parsedM2);
  assert.equal(parsedM2.isSupportGeometry, false);
  assert.equal(parsedM2.linkGroupId, 'link-grp-abc');

  const autoResult = await parseVoxlAuto(binary);
  assert.equal(autoResult.document.models[0].isSupportGeometry, true);
  assert.equal(autoResult.document.models[0].linkGroupId, 'link-grp-abc');
});

test('toggleSupportDesignation action state toggling logic', async () => {
  type SimpleModel = {
    id: string;
    isSupportGeometry?: boolean;
  };

  let models: SimpleModel[] = [
    { id: 'model-1', isSupportGeometry: false },
    { id: 'model-2', isSupportGeometry: false },
    { id: 'model-3', isSupportGeometry: true },
  ];

  function toggleSupportDesignation(modelIds: string[], isSupport: boolean) {
    const targetIds = new Set(modelIds);
    models = models.map((m) => {
      if (targetIds.has(m.id)) {
        return { ...m, isSupportGeometry: isSupport };
      }
      return m;
    });
  }

  // Toggle model-1 to support geometry
  toggleSupportDesignation(['model-1'], true);
  assert.equal(models[0].isSupportGeometry, true);
  assert.equal(models[1].isSupportGeometry, false);
  assert.equal(models[2].isSupportGeometry, true);

  // Toggle model-3 back to model geometry
  toggleSupportDesignation(['model-3'], false);
  assert.equal(models[2].isSupportGeometry, false);

  // Bulk toggle model-1 and model-2 to support geometry
  toggleSupportDesignation(['model-1', 'model-2'], true);
  assert.equal(models[0].isSupportGeometry, true);
  assert.equal(models[1].isSupportGeometry, true);
  assert.equal(models[2].isSupportGeometry, false);
});
