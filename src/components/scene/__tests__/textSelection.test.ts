import assert from 'node:assert/strict';
import test from 'node:test';

import { rangeForClicks, wordRangeAt } from '../SceneCanvas/textSelection';

const NAME = 'Benchy grande';

test('one click puts the caret where it landed, kept inside the text', () => {
  assert.deepEqual(rangeForClicks(NAME, 3, 1), { start: 3, end: 3 });
  assert.deepEqual(rangeForClicks(NAME, 99, 1), { start: 13, end: 13 });
  assert.deepEqual(rangeForClicks(NAME, -2, 1), { start: 0, end: 0 });
});

test('a double click takes the word under it', () => {
  assert.deepEqual(rangeForClicks(NAME, 2, 2), { start: 0, end: 6 });
  assert.deepEqual(rangeForClicks(NAME, 10, 2), { start: 7, end: 13 });
});

test('a double click past the end takes the last word', () => {
  assert.deepEqual(rangeForClicks(NAME, 13, 2), { start: 7, end: 13 });
});

test('a double click between words takes the spaces', () => {
  assert.deepEqual(wordRangeAt('a   b', 2), { start: 1, end: 4 });
});

test('a triple click takes the whole name', () => {
  assert.deepEqual(rangeForClicks(NAME, 4, 3), { start: 0, end: 13 });
});

test('an empty field has nothing to take', () => {
  assert.deepEqual(rangeForClicks('', 0, 2), { start: 0, end: 0 });
  assert.deepEqual(rangeForClicks('', 0, 3), { start: 0, end: 0 });
});
