import assert from 'node:assert/strict';
import test from 'node:test';

import { dissolveLoneLinkGroups } from '../linkGroups';

test('a link group with one peer left is dissolved, one with two keeps its id', () => {
  const pair = dissolveLoneLinkGroups({
    models: [{ id: 'b', linkGroupId: 'l' }, { id: 'c', linkGroupId: 'other' }],
    removed: [{ linkGroupId: 'l' }],
  });
  assert.deepEqual(pair, [{ id: 'b', linkGroupId: undefined }, { id: 'c', linkGroupId: 'other' }]);

  const trio = dissolveLoneLinkGroups({
    models: [{ id: 'b', linkGroupId: 'l' }, { id: 'c', linkGroupId: 'l' }],
    removed: [{ linkGroupId: 'l' }],
  });
  assert.deepEqual(trio.map((model) => model.linkGroupId), ['l', 'l']);
});

test('removing several models of one link group checks the group once, after all of them', () => {
  const models = dissolveLoneLinkGroups({
    models: [{ id: 'c', linkGroupId: 'l' }],
    removed: [{ linkGroupId: 'l' }, { linkGroupId: 'l' }],
  });
  assert.deepEqual(models, [{ id: 'c', linkGroupId: undefined }]);
});

test('a removal outside any link group hands back the same models', () => {
  const models = [{ id: 'b', linkGroupId: 'l' }];
  assert.equal(dissolveLoneLinkGroups({ models, removed: [{}] }), models);
});
