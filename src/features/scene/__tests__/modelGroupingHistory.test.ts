import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyModelGrouping,
  applyModelUngrouping,
  applyModelGroupUngrouping,
  type GroupableModel,
} from '@/features/scene/modelGroupingHistory';

const models: GroupableModel[] = [
  { id: 'model-a', name: 'Alpha' },
  { id: 'model-b', name: 'Beta' },
  { id: 'model-c', name: 'Gamma', groupId: 'group-existing', groupName: 'Existing' },
];

test('applyModelGrouping reports a changed transition for undo history', () => {
  const result = applyModelGrouping({
    models,
    modelIds: ['model-a', 'model-b'],
    groupId: 'group-new',
    activeModelId: null,
    selectedModelIds: ['model-a'],
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeModelId, 'model-a');
  assert.deepEqual(result.selectedModelIds, ['model-a', 'model-b']);
  assert.equal(result.description, 'Group 2 Models');
  assert.equal(result.models.find((model) => model.id === 'model-a')?.groupId, 'group-new');
  assert.equal(result.models.find((model) => model.id === 'model-b')?.groupName, 'Alpha');
});

test('applyModelUngrouping reports a changed transition for undo history', () => {
  const result = applyModelUngrouping({
    models,
    modelIds: ['model-c'],
    activeModelId: 'model-c',
    selectedModelIds: ['model-c'],
  });

  assert.equal(result.changed, true);
  assert.equal(result.description, 'Ungroup Model Gamma');
  assert.equal(result.models.find((model) => model.id === 'model-c')?.groupId, undefined);
  assert.equal(result.models.find((model) => model.id === 'model-c')?.groupName, undefined);
});

test('applyModelGroupUngrouping reports a changed transition for undo history', () => {
  const result = applyModelGroupUngrouping({
    models,
    groupId: 'group-existing',
    activeModelId: 'model-c',
    selectedModelIds: ['model-c'],
  });

  assert.equal(result.changed, true);
  assert.equal(result.description, 'Ungroup Existing');
  assert.equal(result.models.find((model) => model.id === 'model-c')?.groupId, undefined);
});
