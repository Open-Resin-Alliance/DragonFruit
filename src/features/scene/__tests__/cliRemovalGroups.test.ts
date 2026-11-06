import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutModelInGroups } from '../../../../scripts/cli/sceneRemovalGroups';

const group = (id: string, ...modelIds: string[]) => ({ id, name: id, modelIds });

test('the removed model leaves every group it was in', () => {
  const { groups } = withoutModelInGroups({
    models: [{ id: 'b' }, { id: 'c' }],
    groups: [group('one', 'a', 'b', 'c'), group('two', 'c', 'a', 'b')],
    removed: { id: 'a' },
  });
  assert.deepEqual(groups, [group('one', 'b', 'c'), group('two', 'c', 'b')]);
});

test('a group left with one member is dissolved', () => {
  const { groups } = withoutModelInGroups({
    models: [{ id: 'b' }],
    groups: [group('pair', 'a', 'b')],
    removed: { id: 'a' },
  });
  assert.deepEqual(groups, []);
});

test('groups without the removed model stay as they were, even a single-member one', () => {
  const groups = [group('other', 'b', 'c'), group('solo', 'c')];
  assert.deepEqual(
    withoutModelInGroups({ models: [{ id: 'b' }, { id: 'c' }], groups, removed: { id: 'a' } }).groups,
    groups,
  );
});

test('a link group with one peer left is dissolved, one with two keeps its id', () => {
  const pair = withoutModelInGroups({
    models: [{ id: 'b', linkGroupId: 'l' }, { id: 'c', linkGroupId: 'other' }],
    groups: [],
    removed: { id: 'a', linkGroupId: 'l' },
  });
  assert.deepEqual(pair.models, [{ id: 'b', linkGroupId: undefined }, { id: 'c', linkGroupId: 'other' }]);

  const trio = withoutModelInGroups({
    models: [{ id: 'b', linkGroupId: 'l' }, { id: 'c', linkGroupId: 'l' }],
    groups: [],
    removed: { id: 'a', linkGroupId: 'l' },
  });
  assert.deepEqual(trio.models.map((model) => model.linkGroupId), ['l', 'l']);
});

test('a model outside any link group changes no link group', () => {
  const models = [{ id: 'b', linkGroupId: 'l' }];
  assert.equal(withoutModelInGroups({ models, groups: [], removed: { id: 'a' } }).models, models);
});
