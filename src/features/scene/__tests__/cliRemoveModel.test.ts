import assert from 'node:assert/strict';
import test from 'node:test';

import { removeModelFromDocument } from '../../../../scripts/cli/sceneRemoveModel';
import { payloadOf, supportsOf } from '../../../supports/__tests__/helpers/modelSupportFixtures';
import type { VoxlDocumentV1, VoxlModelEntry } from '../voxl/types';

const group = (id: string, ...modelIds: string[]) => ({ id, name: id, modelIds });

function sceneOf(models: Partial<VoxlModelEntry>[], extensions?: Record<string, unknown>): VoxlDocumentV1 {
  return {
    magic: 'VOXL',
    version: 1,
    meta: { generator: 'test', createdAt: '', updatedAt: '', units: 'mm', coordinateSystem: 'right-handed-z-up' },
    scene: { activeModelId: 'a', selectedModelIds: ['a', 'b'] },
    models: models as VoxlModelEntry[],
    supports: payloadOf(...models.map((model) => supportsOf(model.id!))),
    ...(extensions ? { extensions } : {}),
  } as VoxlDocumentV1;
}

test('an unknown id throws and leaves the document as it was', () => {
  const doc = sceneOf([{ id: 'a' }]);
  const copy = structuredClone(doc);

  assert.throws(() => removeModelFromDocument(doc, 'nope'), /Model 'nope' not found/);
  assert.deepEqual(doc, copy);
});

test('the model, its supports, its selection and its link group go', () => {
  const doc = sceneOf([{ id: 'a', linkGroupId: 'l' }, { id: 'b', linkGroupId: 'l' }]);

  removeModelFromDocument(doc, 'a');

  assert.deepEqual(doc.models, [{ id: 'b', linkGroupId: undefined }]);
  assert.deepEqual(doc.supports.trunks.map((trunk) => trunk.id), ['b-trunk']);
  assert.equal(doc.scene.activeModelId, null);
  assert.deepEqual(doc.scene.selectedModelIds, ['b']);
});

test('the model leaves the CLI groups it was in, and a group it leaves empty goes', () => {
  const doc = sceneOf([{ id: 'a' }, { id: 'b' }], {
    groups: [group('pair', 'a', 'b'), group('solo', 'a'), group('other', 'b'), group('empty')],
    other: 'kept',
  });

  removeModelFromDocument(doc, 'a');

  assert.deepEqual(doc.extensions, {
    groups: [group('pair', 'b'), group('other', 'b'), group('empty')],
    other: 'kept',
  });
});

test('a document without groups gets none', () => {
  const doc = sceneOf([{ id: 'a' }, { id: 'b' }]);

  removeModelFromDocument(doc, 'a');

  assert.equal(doc.extensions, undefined);
});
