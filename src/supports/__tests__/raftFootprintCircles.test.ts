import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRaftBaseCirclesByModel,
  RAFT_UNASSIGNED_MODEL_KEY,
  raftFootprintSourceRefs,
  sameRaftFootprintSource,
  type RaftFootprintSource,
} from '../Rafts/Crenelated/raftFootprintCircles';
import { INLINE_ROOT_TYPES } from '../supportTypeRegistry';

/**
 * The raft footprint is read from the store rather than from collections the
 * caller names, so these fixtures build a `SupportState`-shaped object holding
 * only the fields the footprint reads. The cast is the test's boundary: a real
 * entity carries far more, and none of it is consulted.
 */
const root = (id: string, modelId: string | null, x: number, y: number, diameter: number) => ({
  id,
  modelId,
  diameter,
  transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
});

const inlineRooted = (id: string, typeId: string, modelId: string | null, x: number, y: number, diameter: number) => {
  const placement = INLINE_ROOT_TYPES.find((t) => t.typeId === typeId);
  if (!placement) throw new Error(`no inline-root type "${typeId}" is declared`);
  return {
    id,
    typeId,
    modelId,
    [placement.posField]: { x, y, z: 0 },
    [placement.radiusField]: diameter,
  };
};

function source(collections: Record<string, Record<string, unknown>>): RaftFootprintSource {
  return collections as unknown as RaftFootprintSource;
}

/** The one declared inline-root type, whatever it is called. */
const INLINE = INLINE_ROOT_TYPES[0]!;

test('a plate root, a kickstand root and an inline-root base all become circles', () => {
  // A kickstand's root is a `Roots` record in the shared collection -- its
  // descriptor declares `rootId` onto `roots` -- so it arrives through the same
  // walk as a trunk's.
  const circlesByModel = collectRaftBaseCirclesByModel(source({
    roots: {
      'trunk-root': root('trunk-root', 'model-a', 1, 2, 4),
      'ks-root': root('ks-root', 'model-a', 5, 6, 2),
      'unassigned-root': root('unassigned-root', null, -1, -2, 8),
    },
    [INLINE.collectionKey]: {
      'inline-1': inlineRooted('inline-1', INLINE.typeId, 'model-a', 3, 4, 6),
    },
  }));

  assert.deepEqual(circlesByModel.get('model-a'), [
    { x: 1, y: 2, r: 2 },
    { x: 5, y: 6, r: 1 },
    { x: 3, y: 4, r: 3 },
  ]);
  assert.deepEqual(circlesByModel.get(RAFT_UNASSIGNED_MODEL_KEY), [
    { x: -1, y: -2, r: 4 },
  ]);
});

test('model filters and exclusions apply to every contributing collection', () => {
  const state = source({
    roots: {
      'root-a': root('root-a', 'model-a', 1, 1, 4),
      'root-b': root('root-b', 'model-b', 3, 3, 2),
    },
    [INLINE.collectionKey]: {
      'inline-a': inlineRooted('inline-a', INLINE.typeId, 'model-a', 2, 2, 2),
    },
  });

  const filtered = collectRaftBaseCirclesByModel(state, { modelFilterId: 'model-a' });
  assert.deepEqual(Array.from(filtered.keys()), ['model-a']);
  assert.equal(filtered.get('model-a')?.length, 2, 'the root and the inline base');

  const excluded = collectRaftBaseCirclesByModel(state, {
    excludedModelIds: new Set(['model-b']),
  });
  assert.deepEqual(Array.from(excluded.keys()), ['model-a']);
});

test('an inline-root entity missing its declared radius contributes nothing', () => {
  // The fields come off the declaration, so an entity that does not carry them
  // is skipped rather than producing a circle of radius NaN.
  const circles = collectRaftBaseCirclesByModel(source({
    roots: {},
    [INLINE.collectionKey]: {
      'no-radius': { id: 'no-radius', typeId: INLINE.typeId, modelId: 'model-a', [INLINE.posField]: { x: 1, y: 1, z: 0 } },
      'no-pos': { id: 'no-pos', typeId: INLINE.typeId, modelId: 'model-a', [INLINE.radiusField]: 4 },
    },
  }));

  assert.equal(circles.size, 0);
});

test('the cache identity follows the contributing collections and nothing else', () => {
  // A type that puts nothing on the raft must not invalidate the raft's meshes.
  const state = source({
    roots: { r: root('r', 'model-a', 0, 0, 2) },
    [INLINE.collectionKey]: {},
    leaves: { l: { id: 'l' } },
    branches: { b: { id: 'b' } },
  });
  const refs = raftFootprintSourceRefs(state);

  assert.ok(sameRaftFootprintSource(refs, raftFootprintSourceRefs(state)), 'stable when nothing moved');

  // An unrelated type's collection is replaced: the footprint is unchanged.
  const unrelatedEdited = source({ ...state, leaves: { l: { id: 'l' }, l2: { id: 'l2' } } });
  assert.ok(
    sameRaftFootprintSource(refs, raftFootprintSourceRefs(unrelatedEdited)),
    'a leaf edit must not invalidate the raft',
  );

  // A contributing collection is replaced: the footprint must rebuild.
  const relevantEdited = source({ ...state, roots: { r: root('r', 'model-a', 0, 0, 2) } });
  assert.ok(
    !sameRaftFootprintSource(refs, raftFootprintSourceRefs(relevantEdited)),
    'a root edit must invalidate the raft',
  );
});
