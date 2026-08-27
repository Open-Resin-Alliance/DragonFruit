import assert from 'node:assert/strict';
import test from 'node:test';

import {
  performModelCut,
  selectModelsForClipboard,
} from '@/features/scene/modelCut';

test('clipboard sources preserve scene order and attached support payloads', () => {
  const models = [
    { id: 'model-a', supportClipboard: ['support-a'] },
    { id: 'model-b', supportClipboard: ['support-b'] },
    { id: 'model-c', supportClipboard: ['support-c'] },
  ];

  const selected = selectModelsForClipboard(models, ['model-c', 'missing', 'model-a']);

  assert.deepEqual(selected, [models[0], models[2]]);
});

test('batch Cut copies before one full-selection deletion and restores in one step', () => {
  const initialModels = [
    { id: 'model-a' },
    { id: 'model-b' },
    { id: 'model-c' },
  ];
  const initialSupports = new Map([
    ['model-a', ['support-a']],
    ['model-b', ['support-b']],
  ]);
  let models = [...initialModels];
  let supports = new Map(initialSupports);
  let clipboard: Array<{ id: string; supports: string[] }> = [];
  const undo: Array<() => void> = [];
  const events: string[] = [];

  const cut = performModelCut(['model-b', 'model-a'], (ids) => {
    events.push('copy');
    clipboard = selectModelsForClipboard(models, ids).map((model) => ({
      id: model.id,
      supports: [...(supports.get(model.id) ?? [])],
    }));
    return true;
  }, (ids) => {
    events.push('delete');
    const beforeModels = [...models];
    const beforeSupports = new Map(supports);
    const idSet = new Set(ids);
    models = models.filter((model) => !idSet.has(model.id));
    supports = new Map([...supports].filter(([id]) => !idSet.has(id)));
    undo.push(() => {
      models = beforeModels;
      supports = beforeSupports;
    });
  });

  assert.equal(cut, true);
  assert.deepEqual(events, ['copy', 'delete']);
  assert.deepEqual(clipboard, [
    { id: 'model-a', supports: ['support-a'] },
    { id: 'model-b', supports: ['support-b'] },
  ]);
  assert.deepEqual(models, [{ id: 'model-c' }]);
  assert.deepEqual([...supports], []);
  assert.equal(undo.length, 1);

  undo[0]();
  assert.deepEqual(models, initialModels);
  assert.deepEqual([...supports], [...initialSupports]);
});

test('failed clipboard capture prevents deletion', () => {
  let deleteCalls = 0;

  assert.equal(performModelCut(['missing'], () => false, () => {
    deleteCalls += 1;
  }), false);
  assert.equal(deleteCalls, 0);
});