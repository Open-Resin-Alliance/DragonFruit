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
import { SUPPORT_COLLECTION_KEYS } from '@/supports/supportTypeRegistry';
import type { SupportState } from '@/supports/types';
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
  /**
   * Inverse of the committed model transform this geometry was merged under.
   *
   * Baked with the geometry, not read from the scene: while a replacement is
   * being built the old entry keeps its own inverse, so stale supports follow
   * the model rigidly (`current * committed⁻¹ * old`) instead of popping to the
   * new position before the data catches up.
   */
  sourceInverse: THREE.Matrix4;
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
  // No BVH: nothing raycasts this geometry.
  entry.geometry.dispose();
}

function buildEntry(modelKey: string): void {
  const model = state.walk?.get(modelKey);
  const previous = state.entries.get(modelKey);

  if (!model) {
    if (previous) {
      state.entries.delete(modelKey);
      disposeEntry(previous);
    }
    return;
  }

  const modelId = model.modelId ?? null;
  const modelWorldInverse = modelId ? state.inverses?.get(modelId) : undefined;
  const built = buildMergedSupportGeometry(model, {
    ...(state.resolvePenetration ? { resolvePenetration: state.resolvePenetration } : {}),
    ...(modelWorldInverse ? { modelWorldInverse } : {}),
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
    modelId,
    geometry: built.geometry,
    triangles: built.triangles,
    // The model pose is baked into the vertices; the group matrix is identity.
    sourceInverse: new THREE.Matrix4(),
    status: 'ready',
  };
  state.entries.set(modelKey, entry);
  if (previous) disposeEntry(previous);
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
  resolvePenetration: ResolvePenetration | null;
}): void {
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
      // The supports moved with the model, and the entries are children of the
      // model group. Keep their geometry and inverses: current * baked⁻¹ is the
      // transform that was just committed. The next real support edit rebuilds
      // at the new positions. Only valid once the walk exists; otherwise a
      // transform during the initial build would strand every model on the
      // proxy forever.
      skipNextTransformRebuild = false;
      state.key = nextKey;
      publish();
      return;
    }
    skipNextTransformRebuild = false;
    // Every model's merge depends on the whole walk, and a support edit rewrites
    // whole collections; a per-model diff is a later optimisation. The old
    // entries stay drawn (and keep their own inverses) until each replacement
    // lands.
    state.key = nextKey;
    state.walk = null;
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
      resolvePenetration,
    });
  }, [
    cavityGeometryByModelId,
    collectionRefs,
    enabled,
    includeDetailedPrimitives,
    interiorView,
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
