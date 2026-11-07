import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSceneSaveContext, type SceneSaveSource } from '../sceneSaveContext';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/** Only the fields this test reads: an id, and whether the model is visible. */
const model = (id: string, visible: boolean): LoadedModel => ({ id, visible } as LoadedModel);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const source = (models: LoadedModel[]): SceneSaveSource => deepFreeze({
  models,
  activeModelId: models[0]?.id ?? null,
  selectedModelIds: [],
  plates: [{ id: 'plate-1', name: 'Plate 1' }],
  activePlateId: 'plate-1',
  plateName: 'Plate 1',
  printer: undefined,
  plateOrdering: undefined,
});

test('a save writes hidden models as well as visible ones (#925)', () => {
  const context = buildSceneSaveContext(source([model('shown', true), model('hidden', false)]));
  assert.deepEqual(context.models.map((m) => m.id), ['shown', 'hidden']);
});

test('a scene whose models are all hidden still saves them all', () => {
  const context = buildSceneSaveContext(source([model('a', false), model('b', false)]));
  assert.deepEqual(context.models.map((m) => m.id), ['a', 'b']);
});

test('the plates, the active plate and its name reach the save unchanged', () => {
  const context = buildSceneSaveContext(source([model('a', true)]));
  assert.deepEqual(context.plates, [{ id: 'plate-1', name: 'Plate 1' }]);
  assert.equal(context.activePlateId, 'plate-1');
  assert.equal(context.plateName, 'Plate 1');
});

test('a thumbnail is attached only when there is one', () => {
  const scene = source([model('a', true)]);
  assert.equal('exportThumbnailPng' in buildSceneSaveContext(scene), false);
  assert.equal('exportThumbnailPng' in buildSceneSaveContext(scene, null), false);
  const png = new Uint8Array([0x89, 0x50]);
  assert.equal(buildSceneSaveContext(scene, png).exportThumbnailPng, png);
});
