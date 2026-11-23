import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHistorySelection } from '../historySelection';

const all = () => true;
const sel = (activeModelId: string | null, ...modelIds: string[]) => ({ activeModelId, modelIds });

test('an entry made on another model brings that model back', () => {
  assert.deepEqual(resolveHistorySelection(sel('apple', 'apple'), sel('boat', 'boat'), all), sel('apple', 'apple'));
});

test('an entry made on the model already selected changes nothing', () => {
  assert.equal(resolveHistorySelection(sel('apple', 'apple'), sel('apple', 'apple'), all), null);
  assert.equal(resolveHistorySelection(sel('a', 'a', 'b'), sel('a', 'b', 'a'), all), null, 'order does not matter');
});

test('models that are gone or cannot be selected are left out', () => {
  const selectable = (id: string) => id !== 'gone';
  assert.deepEqual(resolveHistorySelection(sel('gone', 'gone', 'apple'), sel('boat', 'boat'), selectable), sel('apple', 'apple'));
  assert.equal(resolveHistorySelection(sel('gone', 'gone'), sel('boat', 'boat'), selectable), null, 'nothing left: keep the selection');
});

test('an entry with no selection leaves the current one', () => {
  assert.equal(resolveHistorySelection(undefined, sel('boat', 'boat'), all), null);
  assert.equal(resolveHistorySelection(sel(null), sel('boat', 'boat'), all), null);
});
