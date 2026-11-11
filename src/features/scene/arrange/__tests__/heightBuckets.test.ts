import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketModelsByHeight, heightRangesFit } from '../heightBuckets';

const heightOf = (heightMm: number) => heightMm;

test('mixed heights form descending groups with their actual height ranges', () => {
  assert.deepEqual(bucketModelsByHeight([5, 42, 21, 37, 19, 0], heightOf, 5), [
    { minHeightMm: 37, maxHeightMm: 42, models: [42, 37] },
    { minHeightMm: 19, maxHeightMm: 21, models: [21, 19] },
    { minHeightMm: 0, maxHeightMm: 5, models: [5, 0] },
  ]);
});

test('near heights straddling a tolerance multiple stay together', () => {
  assert.deepEqual(bucketModelsByHeight([19, 21], heightOf, 10), [
    { minHeightMm: 19, maxHeightMm: 21, models: [21, 19] },
  ]);
});

test('near-neighbour chains cannot exceed the span from the tallest model', () => {
  assert.deepEqual(bucketModelsByHeight([18, 30, 24, 12], heightOf, 10), [
    { minHeightMm: 24, maxHeightMm: 30, models: [30, 24] },
    { minHeightMm: 12, maxHeightMm: 18, models: [18, 12] },
  ]);
});

test('the bucket span includes the tolerance boundary', () => {
  assert.deepEqual(bucketModelsByHeight([10, 20, 9], heightOf, 10), [
    { minHeightMm: 10, maxHeightMm: 20, models: [20, 10] },
    { minHeightMm: 9, maxHeightMm: 9, models: [9] },
  ]);
});

test('zero tolerance groups only identical heights, including zero', () => {
  assert.deepEqual(bucketModelsByHeight([0, 10, 0, 11, 10], heightOf, 0), [
    { minHeightMm: 11, maxHeightMm: 11, models: [11] },
    { minHeightMm: 10, maxHeightMm: 10, models: [10, 10] },
    { minHeightMm: 0, maxHeightMm: 0, models: [0, 0] },
  ]);
});

test('bucketing preserves input and same-height order', () => {
  const low = Object.freeze({ id: 'low', heightMm: 5 });
  const first = Object.freeze({ id: 'first', heightMm: 20 });
  const second = Object.freeze({ id: 'second', heightMm: 20 });
  const third = Object.freeze({ id: 'third', heightMm: 20 });
  const models = Object.freeze([low, first, second, third]);
  const buckets = bucketModelsByHeight(models, (model) => model.heightMm, 10);

  assert.deepEqual(models, [low, first, second, third]);
  assert.deepEqual(buckets, [
    { minHeightMm: 20, maxHeightMm: 20, models: [first, second, third] },
    { minHeightMm: 5, maxHeightMm: 5, models: [low] },
  ]);
});

test('no models produce no buckets', () => {
  assert.deepEqual(bucketModelsByHeight([], heightOf, 10), []);
});

test('an empty bed accepts an incoming height range', () => {
  assert.equal(heightRangesFit(null, { minHeightMm: 20, maxHeightMm: 30 }, 10), true);
  assert.equal(heightRangesFit(null, { minHeightMm: 0, maxHeightMm: 0 }, 0), true);
});

test('occupied beds accept compatible ranges including the exact span boundary', () => {
  const existing = Object.freeze({ minHeightMm: 20, maxHeightMm: 25 });
  const incoming = Object.freeze({ minHeightMm: 26, maxHeightMm: 30 });
  assert.equal(heightRangesFit(existing, incoming, 10), true);
  assert.equal(heightRangesFit(incoming, existing, 10), true);
  assert.equal(heightRangesFit(existing, { minHeightMm: 22, maxHeightMm: 24 }, 10), true);
});

test('occupied beds reject a combined span beyond the tolerance in either direction', () => {
  const existing = { minHeightMm: 20, maxHeightMm: 25 };
  assert.equal(heightRangesFit(existing, { minHeightMm: 26, maxHeightMm: 31 }, 10), false);
  assert.equal(heightRangesFit(existing, { minHeightMm: 14, maxHeightMm: 19 }, 10), false);
  assert.equal(heightRangesFit(existing, { minHeightMm: 15, maxHeightMm: 30 }, 10), false);
});

test('occupied beds at zero tolerance accept only the same exact height', () => {
  const existing = { minHeightMm: 20, maxHeightMm: 20 };
  assert.equal(heightRangesFit(existing, { minHeightMm: 20, maxHeightMm: 20 }, 0), true);
  assert.equal(heightRangesFit(existing, { minHeightMm: 19, maxHeightMm: 19 }, 0), false);
  assert.equal(heightRangesFit(existing, { minHeightMm: 21, maxHeightMm: 21 }, 0), false);
});
