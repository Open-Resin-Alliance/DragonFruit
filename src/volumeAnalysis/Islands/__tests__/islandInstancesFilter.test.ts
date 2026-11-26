import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_ISLAND_INSTANCES, filterIslandInstances, type IslandInstances } from '../islandInstances';

function instances(): IslandInstances {
  return {
    centerRadius: new Float32Array([
      0, 0, 1, 0.5,
      10, 10, 1, 0.5,
      2, 2, 3, 0.5,
    ]),
    meta: new Float32Array([7, 0, 8, 1, 9, 2]),
    count: 3,
    layerHeightMm: 0.05,
  };
}

test('filters instance buffers to the interior predicate and preserves metadata order', () => {
  const filtered = filterIslandInstances(instances(), (x) => x < 5);
  assert.equal(filtered.count, 2);
  assert.deepEqual(Array.from(filtered.centerRadius), [0, 0, 1, 0.5, 2, 2, 3, 0.5]);
  assert.deepEqual(Array.from(filtered.meta), [7, 0, 9, 2]);
  assert.equal(filtered.layerHeightMm, 0.05);
});

test('an empty or fully-rejected filter returns the shared empty buffers', () => {
  assert.equal(filterIslandInstances(EMPTY_ISLAND_INSTANCES, () => true), EMPTY_ISLAND_INSTANCES);
  assert.equal(filterIslandInstances(instances(), () => false), EMPTY_ISLAND_INSTANCES);
});
