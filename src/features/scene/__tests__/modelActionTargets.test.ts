import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchCutModelAction,
  dispatchDeleteModelAction,
  resolveModelActionTargetIds,
} from '@/features/scene/modelActionTargets';

test('selected models take precedence over active and context fallbacks', () => {
  const targets = resolveModelActionTargetIds({
    modelIds: ['model-a', 'model-b', 'model-c'],
    selectedModelIds: ['model-a', 'missing', 'model-b', 'model-a'],
    activeModelId: 'model-c',
    contextModelId: 'model-c',
  });

  assert.deepEqual(targets, ['model-a', 'model-b']);
});

test('context and active models are single-target fallbacks', () => {
  assert.deepEqual(resolveModelActionTargetIds({
    modelIds: ['model-a', 'model-b'],
    selectedModelIds: [],
    activeModelId: 'model-a',
    contextModelId: 'model-b',
  }), ['model-b']);

  assert.deepEqual(resolveModelActionTargetIds({
    modelIds: ['model-a'],
    selectedModelIds: ['missing'],
    activeModelId: 'model-a',
  }), ['model-a']);
});

test('multi-selection Delete invokes the history-bearing batch command once', () => {
  const calls: string[][] = [];

  const dispatched = dispatchDeleteModelAction({
    modelIds: ['model-a', 'model-b', 'model-c'],
    selectedModelIds: ['model-a', 'model-b'],
    activeModelId: 'model-b',
  }, (ids) => {
    calls.push(ids);
  });

  assert.equal(dispatched, true);
  assert.deepEqual(calls, [['model-a', 'model-b']]);
});

test('single-selection Delete uses one fallback and missing targets do not dispatch', () => {
  const calls: string[][] = [];
  const deleteModels = (ids: string[]) => {
    calls.push(ids);
  };

  assert.equal(dispatchDeleteModelAction({
    modelIds: ['model-a'],
    selectedModelIds: [],
    activeModelId: 'model-a',
  }, deleteModels), true);

  assert.equal(dispatchDeleteModelAction({
    modelIds: ['model-a'],
    selectedModelIds: ['missing'],
    activeModelId: 'missing',
  }, deleteModels), false);

  assert.deepEqual(calls, [['model-a']]);
});

test('multi-selection Cut invokes one ordered batch command', () => {
  const calls: string[][] = [];

  const dispatched = dispatchCutModelAction({
    modelIds: ['model-a', 'model-b', 'model-c'],
    selectedModelIds: ['model-c', 'model-a'],
    activeModelId: 'model-a',
  }, (ids) => {
    calls.push(ids);
    return true;
  });

  assert.equal(dispatched, true);
  assert.deepEqual(calls, [['model-c', 'model-a']]);
});

test('single-selection Cut uses one fallback and missing targets do not dispatch', () => {
  const calls: string[][] = [];
  const cutSelectedModels = (ids: string[]) => {
    calls.push(ids);
    return true;
  };

  assert.equal(dispatchCutModelAction({
    modelIds: ['model-a'],
    selectedModelIds: [],
    activeModelId: 'model-a',
  }, cutSelectedModels), true);

  assert.equal(dispatchCutModelAction({
    modelIds: ['model-a'],
    selectedModelIds: ['missing'],
    activeModelId: 'missing',
  }, cutSelectedModels), false);

  assert.deepEqual(calls, [['model-a']]);
});
