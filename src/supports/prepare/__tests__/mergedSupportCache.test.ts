import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { addRoot, addSupportEntity, getSnapshot, resetStore, setHoveredState } from '@/supports/state';
import { DEFAULT_TIP_PROFILE } from '@/supports/SupportPrimitives/ContactCone/types';
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import type { SupportState } from '@/supports/types';
import {
  flushPrepareMergedSupportSlice,
  getPrepareMergedSupportCacheStats,
  getPrepareMergedSupportView,
  releasePrepareMergedSupportsFor,
  requestPrepareMergedSupports,
  resetPrepareMergedSupportCache,
  setPrepareMergedSupportsSuspended,
  skipNextPrepareMergedSupportRebuild,
  type PrepareMergedSupportCacheView,
} from '../mergedSupportCache';

/**
 * The Prepare merged support cache.
 *
 * Pins the contract the scene relies on: one primitive walk per collection key
 * however many models mount a mesh, one merged geometry per model built in idle
 * slices, the previous entry kept until its replacement lands, and the inverse
 * the geometry was baked under travelling with the entry instead of being read
 * from the live scene.
 */

const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

const DISK_PROFILE = { ...DEFAULT_TIP_PROFILE };
const UP_NORMAL = { x: 0, y: 0, z: 1 };

function seedLimb(id: string, modelId: string, z: number): void {
  // A standalone root emits nothing: the proxy's roots come from the support
  // that owns them, so the fixture pairs a root with a trunk standing on it, and
  // adds a stick whose disk profiles are the one part a profile edit moves.
  addRoot({
    id: `${id}-root`,
    modelId,
    transform: { pos: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    diameter: 3,
    diskHeight: 1,
    coneHeight: 2,
  } as never);
  addSupportEntity('trunk', {
    id,
    modelId,
    rootId: `${id}-root`,
    segments: [],
  } as never);
  addSupportEntity('stick', {
    id: `${id}-stick`,
    modelId,
    segments: [],
    contactConeA: {
      id: `${id}-cone-a`,
      modelId,
      pos: { x: 0, y: 0, z: z + 10 },
      normal: UP_NORMAL,
      surfaceNormal: UP_NORMAL,
      profile: DISK_PROFILE,
    },
    contactConeB: {
      id: `${id}-cone-b`,
      modelId,
      pos: { x: 0, y: 0, z: z + 20 },
      normal: UP_NORMAL,
      surfaceNormal: UP_NORMAL,
      profile: DISK_PROFILE,
    },
  } as never);
}

function reset(): void {
  resetPrepareMergedSupportCache();
  resetStore();
  seedLimb('trunk-a', MODEL_A, 10);
  seedLimb('trunk-b', MODEL_B, 20);
}

function collectionRefs(snapshot: SupportState): readonly unknown[] {
  return SUPPORT_COLLECTION_KEYS.map((key) => snapshot[key]);
}

function request(snapshot: SupportState, overrides: {
  enabled?: boolean;
  resolvePenetration?: ((authoredPenetrationMm: number | undefined) => number) | null;
  includeDetailedPrimitives?: boolean;
  modelWorldInverseById?: Map<string, THREE.Matrix4> | null;
  liveModelIds?: ReadonlySet<string> | null;
} = {}): void {
  requestPrepareMergedSupports({
    enabled: overrides.enabled ?? true,
    snapshot,
    collectionRefs: collectionRefs(snapshot),
    includeDetailedPrimitives: overrides.includeDetailedPrimitives ?? true,
    interiorView: false,
    cavityGeometryByModelId: null,
    modelWorldInverseById: overrides.modelWorldInverseById ?? null,
    liveModelIds: overrides.liveModelIds ?? null,
    resolvePenetration: overrides.resolvePenetration ?? null,
  });
}

/** Drain the idle queue the way the scheduler's callbacks would. */
function drain(): void {
  let guard = 0;
  while (flushPrepareMergedSupportSlice()) {
    guard += 1;
    assert.ok(guard < 100, 'the build queue must finish');
  }
}

test('a suspended queue does not merge under a gesture', () => {
  reset();
  setPrepareMergedSupportsSuspended(true);
  try {
    request(getSnapshot());
    assert.equal(view().entries.size, 0, 'the walk must not run while suspended');
    assert.equal(flushPrepareMergedSupportSlice(), true, 'work stays queued');
    assert.equal(view().entries.size, 0, 'a flush must not merge while suspended');
  } finally {
    setPrepareMergedSupportsSuspended(false);
  }
  drain();
  assert.equal(view().entries.size, 2, 'the same queue resumes after the gesture');
});

function view(): PrepareMergedSupportCacheView {
  return getPrepareMergedSupportView();
}

/** A distinct committed inverse per model, so an entry's bake is observable. */
function commitInverses(offsetX: Record<string, number>): Map<string, THREE.Matrix4> {
  const map = new Map<string, THREE.Matrix4>();
  for (const [modelId, x] of Object.entries(offsetX)) {
    map.set(modelId, new THREE.Matrix4().makeTranslation(x, 0, 0).invert());
  }
  return map;
}

test('one walk feeds one entry per model, built one model per slice', () => {
  reset();
  const inverses = commitInverses({ [MODEL_A]: 1, [MODEL_B]: 2 });

  request(getSnapshot(), { modelWorldInverseById: inverses });

  // Nothing is built inside the request: entering Prepare never blocks a frame.
  assert.equal(getPrepareMergedSupportCacheStats().walks, 0);
  assert.equal(view().entries.size, 0);
  assert.equal(view().finalizing, true);

  // First slice: the shared walk only.
  assert.equal(flushPrepareMergedSupportSlice(), true);
  assert.equal(getPrepareMergedSupportCacheStats().walks, 1);
  assert.equal(view().entries.size, 0, 'the walk is its own slice');

  // Then one model per slice, each becoming usable on its own.
  flushPrepareMergedSupportSlice();
  assert.equal(view().entries.size, 1);
  assert.equal(view().finalizing, true);

  flushPrepareMergedSupportSlice();
  assert.equal(view().entries.size, 2);
  assert.equal(view().finalizing, false);
  assert.equal(getPrepareMergedSupportCacheStats().walks, 1, 'one walk for both models');
  assert.equal(getPrepareMergedSupportCacheStats().builds, 2);

  assert.ok(view().readyModelIds.has(MODEL_A));
  assert.ok(view().readyModelIds.has(MODEL_B));
  for (const entry of view().entries.values()) {
    assert.ok(entry.triangles > 0);
    assert.equal(entry.geometry.groups.length, 3);
    assert.equal(entry.status, 'ready');
  }
});

test('a snapshot rewrite with the same collections does not walk or rebuild', () => {
  reset();
  request(getSnapshot());
  drain();
  const walks = getPrepareMergedSupportCacheStats().walks;
  const builds = getPrepareMergedSupportCacheStats().builds;
  const entryBefore = view().entries.get(MODEL_A);

  // A hover writes the snapshot but replaces no collection.
  const snapshotBefore = getSnapshot();
  setHoveredState('model', MODEL_A);
  const hovered = getSnapshot();
  assert.notEqual(hovered, snapshotBefore, 'the store replaced its snapshot');
  request(hovered);
  drain();

  assert.equal(getPrepareMergedSupportCacheStats().walks, walks);
  assert.equal(getPrepareMergedSupportCacheStats().builds, builds);
  assert.equal(view().entries.get(MODEL_A), entryBefore, 'the entry is kept');
});

test('an entry bakes its geometry into the committed model frame', () => {
  reset();
  const inverses = commitInverses({ [MODEL_A]: 5, [MODEL_B]: -3 });
  request(getSnapshot(), { modelWorldInverseById: inverses });
  drain();

  const entryA = view().entries.get(MODEL_A)!;
  // The fixture stands at world x=0 and the inverse translates by -5, so the
  // geometry must be local; world-space bounds would still straddle zero.
  assert.ok(entryA.geometry.boundingBox, 'the merged geometry has bounds');
  assert.ok(entryA.geometry.boundingBox!.min.x < -4, 'the bake moved the geometry into model space');

  // Moving the models without touching their supports rebuilds nothing: local
  // geometry is unchanged and the group carries the new matrix.
  const builds = getPrepareMergedSupportCacheStats().builds;
  request(getSnapshot(), { modelWorldInverseById: commitInverses({ [MODEL_A]: 50, [MODEL_B]: 50 }) });
  drain();
  assert.equal(getPrepareMergedSupportCacheStats().builds, builds);
  assert.equal(view().entries.get(MODEL_A), entryA);
});

test('a support edit re-merges only the model it touched', () => {
  reset();
  request(getSnapshot());
  drain();

  const previousA = view().entries.get(MODEL_A)!;
  const previousB = view().entries.get(MODEL_B)!;
  const disposed = new Map<string, number>();
  for (const [key, entry] of [[MODEL_A, previousA], [MODEL_B, previousB]] as const) {
    const original = entry.geometry.dispose.bind(entry.geometry);
    entry.geometry.dispose = () => {
      disposed.set(key, (disposed.get(key) ?? 0) + 1);
      original();
    };
  }
  const walks = getPrepareMergedSupportCacheStats().walks;
  const builds = getPrepareMergedSupportCacheStats().builds;

  // One placement rewrites the roots collection. The store carries every other
  // model's entities through by reference, so only MODEL_A is stale.
  seedLimb('trunk-a2', MODEL_A, 12);
  request(getSnapshot());

  assert.equal(view().entries.get(MODEL_A)?.status, 'rebuilding');
  assert.equal(view().entries.get(MODEL_B)?.status, 'ready', 'the untouched model is not rebuilt');
  assert.equal(view().entries.get(MODEL_A), previousA, 'the old entry stays drawn');

  drain();

  assert.equal(getPrepareMergedSupportCacheStats().walks, walks, 'no second walk of the plate');
  assert.equal(getPrepareMergedSupportCacheStats().builds, builds + 1, 'one model re-merges');
  assert.equal(view().entries.get(MODEL_A)?.status, 'ready');
  assert.equal(disposed.get(MODEL_A), 1, 'the replaced geometry is disposed once');
  assert.equal(disposed.get(MODEL_B) ?? 0, 0);
  assert.equal(view().entries.get(MODEL_B), previousB, 'B keeps its entry');
  assert.notEqual(view().entries.get(MODEL_A), previousA);
  assert.notEqual(view().entries.get(MODEL_A)!.geometry, previousA.geometry);
});

test('a profile penetration change re-merges without another walk', () => {
  reset();
  request(getSnapshot());
  drain();
  const walks = getPrepareMergedSupportCacheStats().walks;
  const builds = getPrepareMergedSupportCacheStats().builds;
  const previous = view().entries.get(MODEL_A);

  let resolved = 0;
  const resolvePenetration = (authoredPenetrationMm: number | undefined) => {
    resolved += 1;
    return authoredPenetrationMm ?? 0;
  };

  request(getSnapshot(), { resolvePenetration });
  drain();

  assert.equal(getPrepareMergedSupportCacheStats().walks, walks, 'the walk is penetration-free');
  assert.equal(getPrepareMergedSupportCacheStats().builds, builds + 2);
  assert.notEqual(view().entries.get(MODEL_A), previous);
  assert.ok(resolved > 0, 'the merge asks the profile for the nib depth');
});

test('the cache suspends outside Prepare', () => {
  reset();
  request(getSnapshot(), { enabled: false });

  assert.equal(flushPrepareMergedSupportSlice(), false);
  assert.equal(getPrepareMergedSupportCacheStats().walks, 0);
  assert.equal(getPrepareMergedSupportCacheStats().builds, 0);
  assert.equal(view().entries.size, 0);
  assert.equal(view().finalizing, false);

  // Re-enabling picks the work back up from the same key.
  request(getSnapshot(), { enabled: true });
  drain();
  assert.equal(view().entries.size, 2);
});

test('the model-less support bucket stays on the proxy', () => {
  reset();
  // A support with no model has no model group to parent a merged mesh to.
  addRoot({
    id: 'loose-root',
    modelId: undefined,
    transform: { pos: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    diameter: 3,
    diskHeight: 1,
    coneHeight: 2,
  } as never);
  addSupportEntity('trunk', {
    id: 'loose-trunk',
    modelId: undefined,
    rootId: 'loose-root',
    segments: [],
  } as never);

  request(getSnapshot());
  drain();

  assert.equal(view().entries.size, 2, 'only the two real models get entries');
  assert.equal(getPrepareMergedSupportCacheStats().builds, 2);
  assert.equal(view().readyModelIds.has('__none__'), false);
});

test('a model whose supports disappear loses its entry and its geometry', () => {
  reset();
  request(getSnapshot());
  drain();
  const previousB = view().entries.get(MODEL_B)!;
  let disposed = 0;
  const original = previousB.geometry.dispose.bind(previousB.geometry);
  previousB.geometry.dispose = () => {
    disposed += 1;
    original();
  };

  // Remove every primitive that carried model-b.
  resetStore();
  seedLimb('trunk-a', MODEL_A, 10);
  request(getSnapshot());
  drain();

  assert.equal(view().entries.has(MODEL_B), false, 'the stale entry is evicted');
  assert.equal(disposed, 1);
  assert.ok(view().entries.has(MODEL_A));
});

test('an entry whose model left the scene is released even while the cache is disabled', () => {
  reset();
  request(getSnapshot());
  drain();
  assert.equal(view().entries.size, 2);
  const previousB = view().entries.get(MODEL_B)!;
  let disposed = 0;
  previousB.geometry.dispose = () => {
    disposed += 1;
  };

  // The scene cleared: the Prepare layer is gone, so the cache is disabled and
  // no walk will ever run — the model's merged geometry must still go.
  request(getSnapshot(), { enabled: false, liveModelIds: new Set([MODEL_A]) });

  assert.equal(view().entries.has(MODEL_B), false, 'the vanished model\'s entry is released');
  assert.equal(disposed, 1, 'and its geometry is disposed');
  assert.ok(view().entries.has(MODEL_A), 'a model the scene still holds keeps its entry');
});

test('deleting a model releases its merged supports without waiting for a request', () => {
  reset();
  request(getSnapshot());
  drain();
  assert.equal(view().entries.size, 2);
  let disposed = 0;
  const entryA = view().entries.get(MODEL_A)!;
  entryA.geometry.dispose = () => {
    disposed += 1;
  };

  // The delete path calls this directly: the last model can take the canvas
  // down with it, so no further request is guaranteed.
  releasePrepareMergedSupportsFor([MODEL_A]);

  assert.equal(view().entries.has(MODEL_A), false, 'the deleted model\'s entry is released');
  assert.equal(disposed, 1, 'and its geometry is disposed');
  assert.ok(view().entries.has(MODEL_B), 'another model keeps its entry');
});

test('a transform commit updates the key without rebuilding merged entries', () => {
  reset();
  request(getSnapshot());
  drain();
  const builds = getPrepareMergedSupportCacheStats().builds;
  const entryA = view().entries.get(MODEL_A);
  assert.ok(entryA);

  const snapshot = getSnapshot();
  // A model move rewrites the support collections, so every element identity
  // changes even though the primitives only moved with their model.
  const movedRefs = collectionRefs(snapshot).map((value) => (Array.isArray(value) ? [...value] : value));
  skipNextPrepareMergedSupportRebuild();
  requestPrepareMergedSupports({
    enabled: true,
    snapshot,
    collectionRefs: movedRefs,
    includeDetailedPrimitives: true,
    interiorView: false,
    cavityGeometryByModelId: null,
    modelWorldInverseById: null,
    resolvePenetration: null,
  });

  assert.equal(getPrepareMergedSupportCacheStats().builds, builds, 'a transform must not merge again');
  assert.equal(view().entries.get(MODEL_A), entryA, 'the baked entry and its inverse stay');
  assert.equal(view().finalizing, false);
});

test('a transform before the first walk still builds every entry', () => {
  reset();
  skipNextPrepareMergedSupportRebuild();
  request(getSnapshot());
  drain();
  assert.equal(view().entries.size, 2, 'the initial build is not skipped');
  assert.equal(view().readyModelIds.size, 2);
});
