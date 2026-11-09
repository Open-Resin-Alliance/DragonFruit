import React from 'react';
import * as THREE from 'three';

import { useContactPenetrationResolver } from '@/supports/instanced/contactPenetration';
import {
  createCavityTester,
  interiorSupportIds,
  isAnySegmentPointInterior,
  isInteriorContact,
} from '@/supports/interiorSupportGeometry';
import { getSnapshot as getSupportSnapshot, subscribe as subscribeSupportState } from '@/supports/state';
import { collectProxyPrimitives, type ProxyModelGeometry } from '@/supports/SupportProxyMeshLayer';
import { changedSupportModels, getSupportModelIndex, type SupportModelIndex } from '@/supports/supportModelIndex';
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import type { SupportState } from '@/supports/types';
import { releaseGeometryStorage } from '@/utils/releaseGeometry';
import { perfEnabled, perfMark, perfMeasure } from '@/utils/perfProbe';
import { buildMergedSupportGeometry } from './mergedSupportGeometry';

/**
 * The Prepare view's merged support layer, one entry per model.
 *
 * Prepare draws supports as one merged mesh per model parented to the model
 * group; moving a model is then a parent-matrix update over a handful of draws
 * instead of re-laying out instanced batches. The expensive parts are the walk
 * (`collectProxyPrimitives`, ~15-50 ms for a plate) and the merge (~17 ms for a
 * typical model, ~300 ms for a plate), so both live here rather than in a
 * component:
 *
 * - one walk per support-collection key, shared by every model;
 * - one merge per idle slice, so entering Prepare never blocks the frame;
 * - the previous entry stays drawn until its replacement lands, and the
 *   replaced geometry is disposed here — one geometry is shared by every
 *   consumer of the entry (base mesh, later the out-of-bounds overlay and the
 *   ghost previews), so no component may own it.
 *
 * No BVH: the mesh answers no pointer (the model mesh does), so nothing
 * raycasts this geometry.
 */

const IDLE_TIMEOUT_MS = 200;

/**
 * The nib depth for one cone, from the depth it was authored with. The proxy's
 * `useContactPenetrationResolver` supplies the profile-driven half.
 */
type ResolvePenetration = (authoredPenetrationMm: number | undefined) => number;

export type PrepareMergedSupportEntry = {
  /** The model this geometry belongs to; `null` for the loose-support bucket. */
  modelId: string | null;
  /** World space, three groups (bodies, contact disks, disc-coloured parts). */
  geometry: THREE.BufferGeometry;
  triangles: number;
  /** `rebuilding` entries still carry their previous geometry and stay drawn. */
  status: 'ready' | 'rebuilding';
};

export type PrepareMergedSupportCacheView = {
  entries: ReadonlyMap<string, PrepareMergedSupportEntry>;
  /** Models whose supports are drawn by a merged mesh, and so are hidden in the proxy. */
  readyModelIds: ReadonlySet<string>;
  /** A walk or a merge is still queued. */
  finalizing: boolean;
};

export type PrepareMergedSupportCacheOptions = {
  /** Prepare is the only consumer; the cache stays suspended everywhere else. */
  enabled: boolean;
  includeDetailedPrimitives?: boolean;
  interiorView?: boolean;
  cavityGeometryByModelId?: Map<string, THREE.BufferGeometry>;
  modelWorldInverseById?: Map<string, THREE.Matrix4>;
  /**
   * The models the scene still holds. An entry whose model is gone is released
   * here, whether or not the cache is enabled: leaving Prepare (or emptying the
   * scene) disables the cache, and the merged geometry of a deleted model is
   * hundreds of MB on a supported plate.
   */
  liveModelIds?: ReadonlySet<string>;
  /**
   * Pause the idle walk and merges while the camera or a model drag is live.
   * A slice is one model's merge (~50 ms), which is longer than a frame; running
   * it under a gesture is the hitch this flag exists to remove.
   */
  suspended?: boolean;
};

/** What the walk depends on. Element identity, as in the proxy's shared cache. */
type WalkKey = {
  collectionRefs: readonly unknown[];
  includeDetailedPrimitives: boolean;
  interiorView: boolean;
  cavityGeometryByModelId: Map<string, THREE.BufferGeometry> | null;
  /**
   * Only present when the interior filter runs.
   *
   * Support contacts are world space and the cavity is model-local, so a model
   * move changes which supports are interior. Everywhere else the inverse map
   * is a build-time input only: moving a model must not re-walk the plate.
   */
  interiorModelWorldInverseById: Map<string, THREE.Matrix4> | null;
};

type ScheduledHandle = { kind: 'idle' | 'timeout'; handle: number };

/** The idle scheduler is a browser API; feature-detect it off `globalThis`. */
type IdleSchedulerGlobal = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const EMPTY_VIEW: PrepareMergedSupportCacheView = {
  entries: new Map(),
  readyModelIds: new Set(),
  finalizing: false,
};

const listeners = new Set<() => void>();

/**
 * Stands in for a deleted model's merged geometry: entry objects outlive their
 * map slot (views, mounted props, fibers), so the buffers are let go by
 * re-pointing the entry at something with no attributes at all.
 */
const EMPTY_GEOMETRY = new THREE.BufferGeometry();

let view: PrepareMergedSupportCacheView = EMPTY_VIEW;
let scheduled: ScheduledHandle | null = null;
let suspended = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * A model transform rewrites every support point, but the merged entries are
 * parented to their model groups and the group matrix already carries the same
 * delta. Rebuilding them would walk and merge the whole plate for no visual
 * change, so the next request updates its key without invalidating entries.
 */
let skipNextTransformRebuild = false;
/** Let orbit damping finish before an idle merge can interrupt it. */
const RESUME_AFTER_GESTURE_MS = 350;

const state = {
  enabled: false,
  key: null as WalkKey | null,
  snapshot: null as SupportState | null,
  resolvePenetration: null as ResolvePenetration | null,
  walk: null as Map<string, ProxyModelGeometry> | null,
  /** The per-model index the walk reflects, so a later write can re-collect one model. */
  walkIndex: null as SupportModelIndex | null,
  /** The interior filter the walk was collected with; reused for a per-model refresh. */
  walkInteriorSet: null as Set<string> | null,
  /** Models whose walk entry must be re-collected before their merge. */
  walkRefresh: null as Set<string> | null,
  entries: new Map<string, PrepareMergedSupportEntry>(),
  /** Models still to merge for the current walk; `null` until the walk lands. */
  pending: null as string[] | null,
  pendingIndex: 0,
  inverses: null as Map<string, THREE.Matrix4> | null,
  walks: 0,
  builds: 0,
};

/** Element identity only: `SUPPORT_COLLECTION_KEYS` yields a fresh array per snapshot. */
function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isFinalizing(): boolean {
  if (!state.enabled) return false;
  if (!state.walk) return state.key !== null;
  return state.pending !== null && state.pendingIndex < state.pending.length;
}

function publish(): void {
  const entries = new Map(state.entries);
  const readyModelIds = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.modelId) readyModelIds.add(entry.modelId);
  }
  view = { entries, readyModelIds, finalizing: isFinalizing() };
  for (const listener of listeners) listener();
}

function cancelScheduled(): void {
  const handle = scheduled;
  scheduled = null;
  if (!handle) return;
  if (handle.kind === 'idle') {
    (globalThis as unknown as IdleSchedulerGlobal).cancelIdleCallback?.(handle.handle);
    return;
  }
  clearTimeout(handle.handle);
}

/**
 * Hold or resume the idle queue.
 *
 * Called from the scene while an orbit, wheel zoom, SpaceMouse or model drag is
 * live. The queue is cancelled rather than left pending so no 50 ms merge can
 * start under the gesture; it resumes from the same model when the gesture ends.
 */
/** Mark the next request as a model-transform commit, not a support edit. */
export function skipNextPrepareMergedSupportRebuild(): void {
  skipNextTransformRebuild = true;
}

/** Clear a transform marker when the commit turned out not to move supports. */
export function cancelPrepareMergedSupportRebuildSkip(): void {
  skipNextTransformRebuild = false;
}

export function setPrepareMergedSupportsSuspended(next: boolean): void {
  if (suspended === next) return;
  suspended = next;
  if (resumeTimer !== null) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (suspended) {
    cancelScheduled();
    return;
  }
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    scheduleNextSlice();
  }, RESUME_AFTER_GESTURE_MS);
}

function scheduleNextSlice(): void {
  if (!state.enabled || suspended || resumeTimer !== null || scheduled) return;
  if (state.walk && (state.pending === null || state.pendingIndex >= state.pending.length)) return;
  const run = () => {
    scheduled = null;
    runSlice();
  };
  const scheduler = globalThis as unknown as IdleSchedulerGlobal;
  if (typeof scheduler.requestIdleCallback === 'function') {
    scheduled = { kind: 'idle', handle: scheduler.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS }) };
    return;
  }
  // No idle scheduler (server render, workers, unit tests): yield to the next
  // task instead of running the merge inside the current one.
  scheduled = { kind: 'timeout', handle: setTimeout(run, 0) as unknown as number };
}

/** Queue every model that needs a merge again, without losing the queued ones. */
function requeue(keys: Iterable<string>): void {
  const remaining = state.pending ? state.pending.slice(state.pendingIndex) : [];
  const queued = new Set(remaining);
  for (const key of keys) {
    if (queued.has(key)) continue;
    queued.add(key);
    remaining.push(key);
  }
  state.pending = remaining;
  state.pendingIndex = 0;
}

function disposeEntry(entry: PrepareMergedSupportEntry): void {
  // No BVH: nothing raycasts this geometry. Storage is deliberately NOT
  // dropped here: the previous entry stays drawn until the replacement
  // publishes, so its attributes must survive the swap.
  entry.geometry.dispose();
}

/**
 * Releases the merged geometry of models the scene no longer holds.
 *
 * Runs on every request, enabled or not: the cache outlives the Prepare view,
 * and a scene-wide clear disables it, so waiting for the next walk would keep
 * every deleted model's merged plate in RAM. On a supported plate that is
 * hundreds of MB — the biggest thing this module holds.
 */
function dropEntriesForGoneModels(liveModelIds: ReadonlySet<string> | null | undefined): void {
  if (!liveModelIds) return;
  dropEntriesFor([...state.entries.keys()].filter((key) => {
    const entry = state.entries.get(key);
    return entry !== undefined && entry.modelId !== null && !liveModelIds.has(entry.modelId);
  }));
}

/**
 * Drop the merged entries of models the scene just deleted.
 *
 * The delete path calls this directly: when the last model goes the canvas can
 * unmount in the same commit, so an effect that only runs on the next render
 * never sees the empty scene — and the merged supports of a deleted model are
 * the largest thing this module keeps.
 */
export function releasePrepareMergedSupportsFor(modelIds: Iterable<string>): void {
  const ids = new Set(modelIds);
  if (ids.size === 0) return;
  dropEntriesFor([...state.entries.keys()].filter((key) => {
    const entry = state.entries.get(key);
    return entry !== undefined && entry.modelId !== null && ids.has(entry.modelId);
  }));
}

/**
 * Release an entry whose model has left the scene.
 *
 * Unlike `disposeEntry`, which must keep a replaced entry's arrays alive because
 * the previous mesh stays drawn until the replacement publishes, nothing draws
 * a deleted model's merged supports — but the entry OBJECT can still be held by
 * a view, a mounted child's props or a stale fiber. Pointing the entry at a
 * shared empty geometry drops the buffers no matter who still holds it.
 */
function releaseGoneEntry(entry: PrepareMergedSupportEntry): void {
  const geometry = entry.geometry;
  if (geometry === EMPTY_GEOMETRY) return;
  entry.geometry = EMPTY_GEOMETRY;
  releaseGeometryStorage(geometry);
}

function dropEntriesFor(modelKeys: Iterable<string>): void {
  let dropped = false;
  for (const modelKey of modelKeys) {
    const entry = state.entries.get(modelKey);
    if (!entry) continue;
    state.entries.delete(modelKey);
    releaseGoneEntry(entry);
    dropped = true;
  }
  if (dropped) publish();
}

function buildEntry(modelKey: string): void {
  const perfStart = perfMark();
  try {
    const model = state.walk?.get(modelKey);
    const previous = state.entries.get(modelKey);

    if (!model) {
      if (previous) {
        state.entries.delete(modelKey);
        releaseGoneEntry(previous);
      }
      return;
    }

    const localInverse = model.modelId ? state.inverses?.get(model.modelId) ?? null : null;
    const built = buildMergedSupportGeometry(model, {
      ...(state.resolvePenetration ? { resolvePenetration: state.resolvePenetration } : {}),
      localInverse,
    });

    if (built.triangles === 0) {
      built.geometry.dispose();
      if (previous) {
        state.entries.delete(modelKey);
        disposeEntry(previous);
      }
      return;
    }

    state.builds += 1;
    const entry: PrepareMergedSupportEntry = {
      modelId: model.modelId ?? null,
      geometry: built.geometry,
      triangles: built.triangles,
      status: 'ready',
    };
    state.entries.set(modelKey, entry);
    if (previous) disposeEntry(previous);
  } finally {
    perfMeasure('merged:build', perfStart);
    if (perfEnabled() && perfStart !== 0) console.log('[df] merged build', modelKey, (performance.now() - perfStart).toFixed(1));
  }
}

/** The proxy's interior filter for the current walk: supports touching the cavity. */
function resolveInteriorSupportIdSet(key: WalkKey): Set<string> | null {
  const cavityGeometryByModelId = key.cavityGeometryByModelId;
  if (!key.interiorView || !cavityGeometryByModelId || cavityGeometryByModelId.size === 0) return null;
  if (!state.snapshot) return null;
  const cavityTester = createCavityTester(cavityGeometryByModelId, state.inverses ?? undefined);
  return interiorSupportIds(
    state.snapshot,
    (contact, id) => isInteriorContact(contact, id, cavityTester.isOnInteriorSide),
    (segments, id) => isAnySegmentPointInterior(segments, cavityTester.isOnInteriorSide, id),
  );
}

/** Run one idle slice: either the walk, or one model's merge. */
function runSlice(): void {
  if (!state.enabled || suspended || !state.key) return;

  if (!state.walk) {
    if (!state.snapshot) return;
    // The cavity test is the expensive half of an interior walk and needs the
    // cavity BVH; it belongs in this idle slice, not in a React render.
    const interiorSupportIdSet = resolveInteriorSupportIdSet(state.key);
    state.walk = collectProxyPrimitives(state.snapshot, {
      includeDetailedPrimitives: state.key.includeDetailedPrimitives,
      interiorSupportIdSet,
    });
    state.walkIndex = getSupportModelIndex(state.snapshot as unknown as Record<string, unknown>);
    state.walkInteriorSet = interiorSupportIdSet;
    state.walkRefresh = null;
    state.walks += 1;
    const pending = new Set<string>();
    for (const [modelKey, geometry] of state.walk) {
      // The loose bucket has no model group to live in; the world proxy keeps
      // drawing those supports, so merging them here would build a geometry
      // nothing can mount.
      if (geometry.modelId) pending.add(modelKey);
    }
    // Entries of models that vanished from the walk must be visited too, so
    // their geometry is disposed rather than leaked.
    for (const modelKey of state.entries.keys()) pending.add(modelKey);
    state.pending = Array.from(pending);
    state.pendingIndex = 0;
    publish();
    scheduleNextSlice();
    return;
  }

  const pending = state.pending;
  if (!pending || state.pendingIndex >= pending.length) return;

  const modelKey = pending[state.pendingIndex];
  state.pendingIndex += 1;
  const refresh = state.walkRefresh?.delete(modelKey) ?? false;
  if (refresh && state.snapshot && state.key && state.walk) {
    // One model's primitives moved: re-collect that model, not the plate. The
    // filter still reads every entity, which is why a plate-wide change takes
    // the full walk instead.
    const fresh = collectProxyPrimitives(state.snapshot, {
      includeDetailedPrimitives: state.key.includeDetailedPrimitives,
      interiorSupportIdSet: state.walkInteriorSet,
    }, modelKey).get(modelKey);
    if (fresh) state.walk.set(modelKey, fresh);
    else state.walk.delete(modelKey);
  }
  buildEntry(modelKey);

  if (state.pendingIndex >= pending.length) {
    state.pending = null;
    state.pendingIndex = 0;
    publish();
    return;
  }

  publish();
  scheduleNextSlice();
}

/**
 * Run the next queued slice now and return whether work is still queued.
 *
 * The idle scheduler slides one slice per callback; tests and the A/B harness
 * need to drive that queue deterministically instead of waiting on timers.
 */
export function flushPrepareMergedSupportSlice(): boolean {
  cancelScheduled();
  runSlice();
  scheduleNextSlice();
  return isFinalizing();
}

/**
 * Declare the inputs the Prepare support layer needs.
 *
 * Safe to call every render: only an input-identity change does any work, and
 * neither the walk nor a merge ever runs inside the call. Called from an effect,
 * so the first builds land after the frame that entered Prepare.
 */
export function requestPrepareMergedSupports(request: {
  enabled: boolean;
  snapshot: SupportState;
  collectionRefs: readonly unknown[];
  includeDetailedPrimitives: boolean;
  interiorView: boolean;
  cavityGeometryByModelId: Map<string, THREE.BufferGeometry> | null;
  modelWorldInverseById: Map<string, THREE.Matrix4> | null;
  /** Optional so tests and callers without a scene can skip the prune. */
  liveModelIds?: ReadonlySet<string> | null;
  resolvePenetration: ResolvePenetration | null;
}): void {
  dropEntriesForGoneModels(request.liveModelIds);
  if (!request.enabled) {
    if (state.enabled) {
      state.enabled = false;
      cancelScheduled();
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      publish();
    }
    return;
  }

  state.enabled = true;
  state.snapshot = request.snapshot;
  // Read at build time, never a build key: moving a model does not invalidate
  // support geometry.
  state.inverses = request.modelWorldInverseById;

  const interiorFilterActive = request.interiorView
    && !!request.cavityGeometryByModelId
    && request.cavityGeometryByModelId.size > 0;
  const nextKey: WalkKey = {
    collectionRefs: request.collectionRefs,
    includeDetailedPrimitives: request.includeDetailedPrimitives,
    interiorView: request.interiorView,
    cavityGeometryByModelId: request.cavityGeometryByModelId,
    interiorModelWorldInverseById: interiorFilterActive ? request.modelWorldInverseById : null,
  };
  const keyChanged = state.key === null
    || !sameRefs(state.key.collectionRefs, nextKey.collectionRefs)
    || state.key.includeDetailedPrimitives !== nextKey.includeDetailedPrimitives
    || state.key.interiorView !== nextKey.interiorView
    || state.key.cavityGeometryByModelId !== nextKey.cavityGeometryByModelId
    || state.key.interiorModelWorldInverseById !== nextKey.interiorModelWorldInverseById;

  const penetrationChanged = state.resolvePenetration !== request.resolvePenetration;
  state.resolvePenetration = request.resolvePenetration;

  if (keyChanged) {
    if (skipNextTransformRebuild && state.walk !== null) {
      // A pure XY move translates the world support data and the model frame by
      // the same delta, so the model-local support geometry is unchanged. Keep
      // it; the group carries the move. Only valid once the walk exists;
      // otherwise a transform during the initial build would strand every model
      // on the proxy forever.
      skipNextTransformRebuild = false;
      state.key = nextKey;
      // No publish: the entries, their statuses and `finalizing` are unchanged,
      // and every consumer keys on the view's identity. Publishing here handed
      // the world proxy a fresh `readyModelIds`, which re-cut its batches and
      // tiles and re-uploaded every support instance for a move that changed no
      // support geometry.
      return;
    }
    skipNextTransformRebuild = false;
    // A support write replaces the entities of the models it touched and carries
    // every other entity through by reference, so the walk and the merge can
    // follow that split: only the touched models are re-collected and re-merged,
    // and the rest keep their geometry. The old entries stay drawn while their
    // replacement lands either way.
    //
    // The filter still reads every entity, so a write that touched most of the
    // plate takes the whole walk instead: twenty filtered passes would read the
    // plate twenty times.
    const nextIndex = getSupportModelIndex(request.snapshot as unknown as Record<string, unknown>);
    const sameWalkOptions = state.walk !== null
      && state.walkIndex !== null
      && state.key !== null
      && state.key.includeDetailedPrimitives === nextKey.includeDetailedPrimitives
      && state.key.interiorView === nextKey.interiorView
      && state.key.cavityGeometryByModelId === nextKey.cavityGeometryByModelId
      && state.key.interiorModelWorldInverseById === nextKey.interiorModelWorldInverseById;

    state.key = nextKey;

    if (sameWalkOptions) {
      const changed = changedSupportModels(state.walkIndex, nextIndex);
      const vanished = Array.from(state.entries.keys()).filter((modelKey) => !nextIndex.byModel.has(modelKey));
      for (const modelKey of vanished) state.walk?.delete(modelKey);
      if (changed.size * 2 <= nextIndex.modelKeys.length) {
        state.walkRefresh = changed;
        state.pending = [
          ...changed,
          ...nextIndex.modelKeys.filter((modelKey) => !state.walk!.has(modelKey) && !changed.has(modelKey)),
          ...vanished,
        ];
        state.pendingIndex = 0;
        for (const modelKey of state.pending) {
          const entry = state.entries.get(modelKey);
          if (entry) entry.status = 'rebuilding';
        }
        state.walkIndex = nextIndex;
        publish();
        scheduleNextSlice();
        return;
      }
    }

    state.walk = null;
    state.walkIndex = nextIndex;
    state.walkRefresh = null;
    state.pending = null;
    state.pendingIndex = 0;
    for (const entry of state.entries.values()) entry.status = 'rebuilding';
    publish();
    scheduleNextSlice();
    return;
  }

  if (penetrationChanged) {
    // Only the contact disks read the resolved nib depth, but the merge is one
    // buffer: re-merge every entry against the new resolver. A walk still
    // draining already reads the new resolver for the models it has left.
    for (const entry of state.entries.values()) entry.status = 'rebuilding';
    if (state.walk) requeue(state.entries.keys());
    publish();
    scheduleNextSlice();
    return;
  }

  scheduleNextSlice();
}

export function subscribeToPrepareMergedSupports(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPrepareMergedSupportView(): PrepareMergedSupportCacheView {
  return view;
}

export type PrepareMergedSupportCacheStats = {
  /** `collectProxyPrimitives` walks, one per support-collection key. */
  walks: number;
  /** Merged geometries built, replacing any previous entry. */
  builds: number;
};

/** Instrumentation for the A/B gates and the unit tests. */
export function getPrepareMergedSupportCacheStats(): Readonly<PrepareMergedSupportCacheStats> {
  return { walks: state.walks, builds: state.builds };
}

/** Drop every entry and the walk. Scene teardown, and each test. */
export function resetPrepareMergedSupportCache(): void {
  cancelScheduled();
  for (const entry of state.entries.values()) disposeEntry(entry);
  state.entries.clear();
  state.key = null;
  state.snapshot = null;
  state.walk = null;
  state.pending = null;
  state.pendingIndex = 0;
  state.enabled = false;
  state.inverses = null;
  state.resolvePenetration = null;
  state.walks = 0;
  state.builds = 0;
  skipNextTransformRebuild = false;
  suspended = false;
  if (resumeTimer !== null) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  view = EMPTY_VIEW;
  listeners.clear();
}

/**
 * The Prepare support layer's inputs, resolved once for the whole scene.
 *
 * One hook, one walk: every model's merged mesh reads the same entry map, so
 * mounting N meshes costs N lookups rather than N walks. The scene calls this
 * once; the per-model component only consumes an entry.
 */
export function usePrepareMergedSupportCache(
  options: PrepareMergedSupportCacheOptions,
): PrepareMergedSupportCacheView {
  const {
    enabled,
    includeDetailedPrimitives = true,
    interiorView = false,
    cavityGeometryByModelId = null,
    modelWorldInverseById = null,
    liveModelIds = null,
    suspended: suspendedByScene = false,
  } = options;

  React.useEffect(() => {
    setPrepareMergedSupportsSuspended(suspendedByScene);
  }, [suspendedByScene]);

  const snapshot = React.useSyncExternalStore(subscribeSupportState, getSupportSnapshot, getSupportSnapshot);
  const contactPenetration = useContactPenetrationResolver();
  // Same resolver identity the proxy's cone group keys on, adapted to the
  // builder's "authored depth in, resolved depth out" shape.
  const resolvePenetration = React.useMemo<ResolvePenetration>(
    () => (authoredPenetrationMm) => contactPenetration({ penetrationMm: authoredPenetrationMm }),
    [contactPenetration],
  );

  // A fresh array per snapshot is fine: the cache compares element identity, so
  // a hover (same collections) is not an invalidation. Building the interior
  // filter happens in the cache's idle walk, not here.
  const collectionRefs = React.useMemo(
    () => SUPPORT_COLLECTION_KEYS.map((key) => snapshot[key]),
    [snapshot],
  );

  React.useEffect(() => {
    requestPrepareMergedSupports({
      enabled,
      snapshot,
      collectionRefs,
      includeDetailedPrimitives,
      interiorView,
      cavityGeometryByModelId,
      modelWorldInverseById,
      liveModelIds,
      resolvePenetration,
    });
  }, [
    cavityGeometryByModelId,
    collectionRefs,
    enabled,
    includeDetailedPrimitives,
    interiorView,
    liveModelIds,
    modelWorldInverseById,
    resolvePenetration,
    snapshot,
  ]);

  return React.useSyncExternalStore(
    subscribeToPrepareMergedSupports,
    getPrepareMergedSupportView,
    getPrepareMergedSupportView,
  );
}
