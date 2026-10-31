import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSupportModelIndex, changedSupportModels } from '../supportModelIndex';

/**
 * The per-model index is the cache key for two render-path walks (the
 * out-of-bounds extent and the proxy layout). Both rely on the store's promise
 * that a support write replaces only the entities it touched, so they rebuild
 * one model and reuse the rest. If the index stops telling them that, a move
 * silently goes back to re-walking the whole plate and nothing else breaks —
 * which is why this is pinned.
 */

function makeState() {
  const rootA: Record<string, unknown> = { id: 'root-a', modelId: 'a' };
  const rootB: Record<string, unknown> = { id: 'root-b', modelId: 'b' };
  const branchA: Record<string, unknown> = { id: 'branch-a', modelId: 'a', parentKnotId: 'knot-a' };
  const branchB: Record<string, unknown> = { id: 'branch-b', modelId: 'b', parentKnotId: 'knot-b' };
  const knotA: Record<string, unknown> = { id: 'knot-a', modelId: 'a', pos: { x: 0, y: 0, z: 1 } };
  const knotB: Record<string, unknown> = { id: 'knot-b', modelId: 'b', pos: { x: 5, y: 0, z: 1 } };
  return {
    roots: { 'root-a': rootA, 'root-b': rootB } as Record<string, Record<string, unknown>>,
    knots: { 'knot-a': knotA, 'knot-b': knotB } as Record<string, Record<string, unknown>>,
    branches: { 'branch-a': branchA, 'branch-b': branchB } as Record<string, Record<string, unknown>>,
  };
}

test('the index groups roots, types and hosted knots by model', () => {
  const index = buildSupportModelIndex(makeState());
  assert.deepEqual(index.modelKeys.sort(), ['a', 'b']);
  assert.deepEqual(index.rootsByModel.get('a')?.map((root) => root.id), ['root-a']);
  assert.deepEqual(index.entitiesByTypeByModel.get('branches')?.get('b')?.map((entity) => entity.id), ['branch-b']);
  assert.deepEqual(index.knotsByModel.get('a')?.map((knot) => knot.id), ['knot-a']);
});

test('a write that replaces one model reports only that model', () => {
  const before = makeState();
  // The store copies the collections and carries the untouched entries through.
  const after = {
    roots: { ...before.roots },
    knots: { ...before.knots },
    branches: { ...before.branches },
  };
  after.roots['root-b'] = { ...after.roots['root-b'], z: 2 };
  after.branches['branch-b'] = { ...after.branches['branch-b'], z: 2 };
  after.knots['knot-b'] = { ...after.knots['knot-b'], pos: { x: 5, y: 0, z: 3 } };

  const changed = changedSupportModels(
    buildSupportModelIndex(before),
    buildSupportModelIndex(after),
  );

  assert.deepEqual([...changed], ['b']);
});

test('an identical state reports nothing changed', () => {
  const state = makeState();
  assert.equal(changedSupportModels(buildSupportModelIndex(state), buildSupportModelIndex(state)).size, 0);
});

test('a removed model drops out of the index', () => {
  const before = makeState();
  const after = makeState();
  delete (after.roots as Record<string, unknown>)['root-b'];
  delete after.branches['branch-b'];

  const index = buildSupportModelIndex(after);
  assert.deepEqual(index.modelKeys.sort(), ['a']);
  assert.equal(changedSupportModels(buildSupportModelIndex(before), index).has('b'), false);
});
