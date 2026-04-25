import * as THREE from 'three';
import { applySmoothingToTopology, type SmoothingScratch, type SmoothingStepOptions } from './smoothingAlgorithms';
import { getMeshTopology, queryUniqueVerticesInSphere } from './topologyCache';
import { clampMeshSmoothingBrushSizeMm, getMeshSmoothingSettings, type MeshSmoothingSettings } from './settings';

export type MeshSmoothingStrokeFinalizedPayload = {
  geometryKey: number;
  uniqueIds: Uint32Array;
  before: Float32Array;
  after: Float32Array;
};

export type MeshSmoothingProcessingState = {
  active: boolean;
  progress: number;
};

export type MeshSmoothingLoadingState = {
  active: boolean;
};

type MeshSmoothingWorkerInitMessage = {
  type: 'init';
  geometryKey: number;
  uniquePositions: Float32Array;
  neighborOffsets: Uint32Array;
  neighborsFlat: Uint32Array;
};

type MeshSmoothingWorkerStepMessage = {
  type: 'step';
  geometryKey: number;
  jobId: number;
  center: [number, number, number];
  radius: number;
  strength: number;
  iterations: number;
  falloff: MeshSmoothingSettings['falloff'];
  maxVertices: number;
  affected: Uint32Array;
};

type MeshSmoothingWorkerFinalizeMessage = {
  type: 'finalize';
  geometryKey: number;
  jobId: number;
  strength: number;
  iterations: number;
  maxVertices: number;
  affected: Uint32Array;
};

type MeshSmoothingWorkerResultMessage = {
  type: 'result';
  geometryKey: number;
  jobId: number;
  applied: Uint32Array;
  newPositions: Float32Array;
};

type BVHGeometry = THREE.BufferGeometry & {
  boundsTree?: {
    refit?: () => void;
    shapecast?: (callbacks: {
      intersectsBounds: (box: THREE.Box3) => boolean;
      intersectsTriangle: (tri: THREE.Triangle, triIndex: number, contained: boolean) => boolean | void;
    }) => void;
  };
  computeBoundsTree?: () => void;
  disposeBoundsTree?: () => void;
};

type SmoothingHighlightState = {
  colorAttr: THREE.BufferAttribute;
  colors: Float32Array;
  mark: Uint32Array;
  stamp: number;
  savedIndices: Uint32Array;
  savedColors: Float32Array;
  savedCount: number;
};

type StrokeUndoState = {
  affectedUnique: Set<number>;
  // uid -> index in ids/before arrays
  beforeIndexByUid: Map<number, number>;
  ids: number[];
  before: number[];
  samples: number[];
};

const activeStrokeGeometry = new WeakMap<THREE.BufferGeometry, StrokeUndoState>();
const scratchIdsByGeometry = new WeakMap<THREE.BufferGeometry, number[]>();
const scratchAffectedByGeometry = new WeakMap<THREE.BufferGeometry, Uint32Array>();
const scratchNewlyHighlightedByGeometry = new WeakMap<THREE.BufferGeometry, Uint32Array>();
const scratchSmoothingByGeometry = new WeakMap<THREE.BufferGeometry, SmoothingScratch>();
const scratchQueryObjectsByGeometry = new WeakMap<THREE.BufferGeometry, { sphere: THREE.Sphere; closestPoint: THREE.Vector3 }>();

type HighlightQueueState = {
  buf: Uint32Array;
  count: number;
  read: number;
  timeoutId: number | null;
};

const highlightQueueByGeometry = new WeakMap<THREE.BufferGeometry, HighlightQueueState>();

const highlightStateByGeometry = new WeakMap<THREE.BufferGeometry, SmoothingHighlightState>();

const geometryKeyByGeometry = new WeakMap<THREE.BufferGeometry, number>();
const geometryByKey = new Map<number, THREE.BufferGeometry>();
const geometryDisposeListenerInstalled = new WeakSet<THREE.BufferGeometry>();
let nextGeometryKey = 1;

const strokeFinalizedSubscribers = new Set<(payload: MeshSmoothingStrokeFinalizedPayload) => void>();

let processingState: MeshSmoothingProcessingState = { active: false, progress: 0 };
const processingSubscribers = new Set<() => void>();

let loadingState: MeshSmoothingLoadingState = { active: false };
const loadingSubscribers = new Set<() => void>();

const readyByGeometry = new WeakSet<THREE.BufferGeometry>();
const pendingInitByGeometry = new WeakMap<THREE.BufferGeometry, { canceled: boolean }>();

export function getMeshSmoothingProcessingState(): MeshSmoothingProcessingState {
  return processingState;
}

export function recordMeshSmoothingEngineStrokeSample(geometry: THREE.BufferGeometry, centerLocal: THREE.Vector3): void {
  const stroke = activeStrokeGeometry.get(geometry);
  if (!stroke) return;

  const s = stroke.samples;
  const n = s.length;
  if (n >= 3) {
    const lx = s[n - 3] ?? 0;
    const ly = s[n - 2] ?? 0;
    const lz = s[n - 1] ?? 0;
    const dx = centerLocal.x - lx;
    const dy = centerLocal.y - ly;
    const dz = centerLocal.z - lz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 0.01 * 0.01) return;
  }

  s.push(centerLocal.x, centerLocal.y, centerLocal.z);
}

export function subscribeToMeshSmoothingProcessingState(listener: () => void): () => void {
  processingSubscribers.add(listener);
  return () => processingSubscribers.delete(listener);
}

function setProcessingState(next: MeshSmoothingProcessingState): void {
  processingState = next;
  processingSubscribers.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[MeshSmoothingEngine] processing subscriber error', err);
    }
  });
}

export function getMeshSmoothingLoadingState(): MeshSmoothingLoadingState {
  return loadingState;
}

export function subscribeToMeshSmoothingLoadingState(listener: () => void): () => void {
  loadingSubscribers.add(listener);
  return () => loadingSubscribers.delete(listener);
}

function setLoadingState(next: MeshSmoothingLoadingState): void {
  loadingState = next;
  loadingSubscribers.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[MeshSmoothingEngine] loading subscriber error', err);
    }
  });
}

export function subscribeToMeshSmoothingStrokeFinalized(
  listener: (payload: MeshSmoothingStrokeFinalizedPayload) => void,
): () => void {
  strokeFinalizedSubscribers.add(listener);
  return () => strokeFinalizedSubscribers.delete(listener);
}

function applyUniformSmoothingToTopology(topology: NonNullable<ReturnType<typeof getMeshTopology>>, affected: Uint32Array, settings: MeshSmoothingSettings, maxVertices: number): Uint32Array {
  const ids = limitVertices(affected, maxVertices);
  if (ids.length === 0) return ids;

  const pos = topology.uniquePositions;
  const neighbors = topology.neighbors;

  const lambda = Math.max(0, Math.min(1, settings.strength));
  const iters = Math.max(1, Math.floor(settings.iterations));

  const scratch = getSmoothingScratch(topology.geometry, ids.length);
  const tmp = scratch.tmp;

  const doPass = (coeff: number) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const i3 = id * 3;
      const nbs = neighbors[id];
      if (!nbs || nbs.length === 0 || coeff === 0) {
        tmp[i * 3 + 0] = pos[i3 + 0];
        tmp[i * 3 + 1] = pos[i3 + 1];
        tmp[i * 3 + 2] = pos[i3 + 2];
        continue;
      }

      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j];
        const nb3 = nb * 3;
        ax += pos[nb3 + 0];
        ay += pos[nb3 + 1];
        az += pos[nb3 + 2];
      }
      const inv = 1 / nbs.length;
      ax *= inv;
      ay *= inv;
      az *= inv;

      const px = pos[i3 + 0];
      const py = pos[i3 + 1];
      const pz = pos[i3 + 2];

      tmp[i * 3 + 0] = px + (ax - px) * coeff;
      tmp[i * 3 + 1] = py + (ay - py) * coeff;
      tmp[i * 3 + 2] = pz + (az - pz) * coeff;
    }

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const i3 = id * 3;
      pos[i3 + 0] = tmp[i * 3 + 0];
      pos[i3 + 1] = tmp[i * 3 + 1];
      pos[i3 + 2] = tmp[i * 3 + 2];
    }
  };

  for (let iter = 0; iter < iters; iter++) {
    doPass(lambda);
  }

  return ids;
}

export function getMeshSmoothingGeometryByKey(geometryKey: number): THREE.BufferGeometry | null {
  return geometryByKey.get(geometryKey) ?? null;
}

let smoothingWorker: Worker | null = null;
let workerActiveGeometry: THREE.BufferGeometry | null = null;
let workerActiveGeometryKey = 0;
let workerNextJobId = 1;
let workerLatestSentJobId = 0;
let workerLatestAppliedJobId = 0;
let workerPendingFinalize = false;

const flatNeighborsByGeometry = new WeakMap<THREE.BufferGeometry, { neighborOffsets: Uint32Array; neighborsFlat: Uint32Array }>();

function initSmoothingForGeometry(geometry: THREE.BufferGeometry): boolean {
  const topo = getMeshTopology(geometry);
  if (!topo) return false;

  const w = ensureSmoothingWorker();
  if (!w) return false;

  const flat = getFlatNeighbors(geometry);
  if (!flat) return false;

  const geometryKey = getGeometryKey(geometry);
  workerActiveGeometry = geometry;
  workerActiveGeometryKey = geometryKey;
  workerNextJobId = 1;
  workerLatestSentJobId = 0;
  workerLatestAppliedJobId = 0;
  workerPendingFinalize = false;

  // Copy arrays so the worker maintains its own authoritative smoothing positions.
  const initMsg: MeshSmoothingWorkerInitMessage = {
    type: 'init',
    geometryKey,
    uniquePositions: topo.uniquePositions,
    neighborOffsets: flat.neighborOffsets,
    neighborsFlat: flat.neighborsFlat,
  };
  w.postMessage(initMsg);
  return true;
}

export function ensureMeshSmoothingEngineReady(geometry: THREE.BufferGeometry): void {
  if (readyByGeometry.has(geometry)) return;

  const existing = pendingInitByGeometry.get(geometry);
  if (existing) return;

  // Pre-warm silently in the background — no loading indicator.
  // By the time the user starts painting, the topology will already be built.
  const token = { canceled: false };
  pendingInitByGeometry.set(geometry, token);

  const run = () => {
    const current = pendingInitByGeometry.get(geometry);
    if (!current || current !== token || token.canceled) return;

    try {
      if (initSmoothingForGeometry(geometry)) {
        readyByGeometry.add(geometry);
      }
    } finally {
      pendingInitByGeometry.delete(geometry);
    }
  };

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as Window & { requestIdleCallback: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number })
      .requestIdleCallback(run, { timeout: 1500 });
  } else {
    setTimeout(run, 0);
  }
}

function getGeometryKey(geometry: THREE.BufferGeometry): number {
  const existing = geometryKeyByGeometry.get(geometry);
  if (existing) return existing;
  const next = nextGeometryKey++;
  geometryKeyByGeometry.set(geometry, next);

  geometryByKey.set(next, geometry);
  if (!geometryDisposeListenerInstalled.has(geometry)) {
    geometryDisposeListenerInstalled.add(geometry);
    geometry.addEventListener('dispose', () => {
      geometryByKey.delete(next);
    });
  }

  return next;
}

function captureBeforeUniquePositions(geometry: THREE.BufferGeometry, topo: NonNullable<ReturnType<typeof getMeshTopology>>, uniqueIds: Uint32Array): void {
  const stroke = activeStrokeGeometry.get(geometry);
  if (!stroke) return;

  const uPos = topo.uniquePositions;
  const beforeIndexByUid = stroke.beforeIndexByUid;
  const ids = stroke.ids;
  const before = stroke.before;

  for (let i = 0; i < uniqueIds.length; i++) {
    const uid = uniqueIds[i];
    if (beforeIndexByUid.has(uid)) continue;

    const u3 = uid * 3;
    if (u3 + 2 >= uPos.length) continue;

    beforeIndexByUid.set(uid, ids.length);
    ids.push(uid);
    before.push(uPos[u3 + 0], uPos[u3 + 1], uPos[u3 + 2]);
  }
}

function limitVertices(input: Uint32Array, maxVertices: number): Uint32Array {
  if (input.length <= maxVertices) return input;
  const stride = Math.ceil(input.length / maxVertices);
  const out: number[] = [];
  for (let i = 0; i < input.length; i += stride) {
    out.push(input[i]);
  }
  return Uint32Array.from(out);
}

function getFlatNeighbors(geometry: THREE.BufferGeometry): { neighborOffsets: Uint32Array; neighborsFlat: Uint32Array } | null {
  const cached = flatNeighborsByGeometry.get(geometry);
  if (cached) return cached;

  const topo = getMeshTopology(geometry);
  if (!topo) return null;

  const count = topo.neighbors.length;
  const offsets = new Uint32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = total;
    total += topo.neighbors[i]?.length ?? 0;
  }
  offsets[count] = total;

  const flat = new Uint32Array(total);
  let w = 0;
  for (let i = 0; i < count; i++) {
    const nbs = topo.neighbors[i];
    for (let j = 0; j < nbs.length; j++) {
      flat[w++] = nbs[j];
    }
  }

  const built = { neighborOffsets: offsets, neighborsFlat: flat };
  flatNeighborsByGeometry.set(geometry, built);
  return built;
}

function finalizeStrokeGeometry(geometry: THREE.BufferGeometry): void {
  const topo = getMeshTopology(geometry);
  if (!topo) return;

  const stroke = activeStrokeGeometry.get(geometry);
  if (stroke && stroke.ids.length > 0) {
    const geometryKey = getGeometryKey(geometry);
    const uniqueIds = Uint32Array.from(stroke.ids);
    const before = Float32Array.from(stroke.before);
    const after = new Float32Array(stroke.ids.length * 3);
    const uPos = topo.uniquePositions;
    for (let i = 0; i < stroke.ids.length; i++) {
      const uid = stroke.ids[i];
      const u3 = uid * 3;
      after[i * 3 + 0] = uPos[u3 + 0] ?? 0;
      after[i * 3 + 1] = uPos[u3 + 1] ?? 0;
      after[i * 3 + 2] = uPos[u3 + 2] ?? 0;
    }

    const payload: MeshSmoothingStrokeFinalizedPayload = {
      geometryKey,
      uniqueIds,
      before,
      after,
    };

    strokeFinalizedSubscribers.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error('[MeshSmoothingEngine] stroke finalized subscriber error', err);
      }
    });
  }

  const hs = highlightStateByGeometry.get(geometry);
  if (hs && hs.savedCount > 0) {
    const colors = hs.colors;
    const savedIdx = hs.savedIndices;
    const savedCol = hs.savedColors;
    const n = hs.savedCount;
    for (let i = 0; i < n; i++) {
      const vi = savedIdx[i];
      const v3 = vi * 3;
      colors[v3 + 0] = savedCol[i * 3 + 0];
      colors[v3 + 1] = savedCol[i * 3 + 1];
      colors[v3 + 2] = savedCol[i * 3 + 2];
    }
    hs.savedCount = 0;
    hs.colorAttr.needsUpdate = true;
  }

  // Normals are needed for proper shading after geometry edits.
  geometry.computeVertexNormals();
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (normalAttr) normalAttr.needsUpdate = true;

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // BVH refit if available; otherwise rebuild.
  const g = geometry as BVHGeometry;
  if (g.boundsTree && typeof g.boundsTree.refit === 'function') {
    try {
      g.boundsTree.refit();
    } catch {
      // fall through to rebuild
      if (typeof g.disposeBoundsTree === 'function') {
        try { g.disposeBoundsTree(); } catch { }
      }
      if (typeof g.computeBoundsTree === 'function') {
        try { g.computeBoundsTree(); } catch { }
      }
    }
  } else {
    if (typeof g.disposeBoundsTree === 'function') {
      try { g.disposeBoundsTree(); } catch { }
    }
    if (typeof g.computeBoundsTree === 'function') {
      try { g.computeBoundsTree(); } catch { }
    }
  }

  // Topology cache remains valid for vertex position edits (neighbors/groups unchanged).
  activeStrokeGeometry.delete(geometry);
}

function getOrCreateHighlightState(geometry: THREE.BufferGeometry): SmoothingHighlightState | null {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;

  const existing = highlightStateByGeometry.get(geometry);
  if (existing && existing.colorAttr.count === pos.count && existing.colorAttr.itemSize === 3) return existing;

  let col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col || col.count !== pos.count || col.itemSize !== 3) {
    const arr = new Float32Array(pos.count * 3);
    arr.fill(1);
    col = new THREE.BufferAttribute(arr, 3);
    geometry.setAttribute('color', col);
  }

  const state: SmoothingHighlightState = {
    colorAttr: col,
    colors: col.array as Float32Array,
    mark: new Uint32Array(pos.count),
    stamp: 1,
    savedIndices: new Uint32Array(1024),
    savedColors: new Float32Array(1024 * 3),
    savedCount: 0,
  };

  highlightStateByGeometry.set(geometry, state);
  return state;
}

function beginHighlightStroke(geometry: THREE.BufferGeometry): void {
  const hs = highlightStateByGeometry.get(geometry);
  if (!hs) return;
  hs.savedCount = 0;
  hs.stamp = (hs.stamp + 1) >>> 0;
  if (hs.stamp === 0) {
    hs.mark.fill(0);
    hs.stamp = 1;
  }
}

function getOrCreateHighlightQueueState(geometry: THREE.BufferGeometry): HighlightQueueState {
  const existing = highlightQueueByGeometry.get(geometry);
  if (existing) return existing;

  const next: HighlightQueueState = {
    buf: new Uint32Array(1024),
    count: 0,
    read: 0,
    timeoutId: null,
  };
  highlightQueueByGeometry.set(geometry, next);
  return next;
}

function clearHighlightQueue(geometry: THREE.BufferGeometry): void {
  const state = highlightQueueByGeometry.get(geometry);
  if (!state) return;
  if (state.timeoutId != null) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  state.count = 0;
  state.read = 0;
}

function enqueueHighlightUniqueIds(geometry: THREE.BufferGeometry, uniqueIds: Uint32Array): void {
  if (uniqueIds.length === 0) return;

  // If there is no active stroke, don't do background highlight work.
  if (!activeStrokeGeometry.has(geometry)) return;

  const state = getOrCreateHighlightQueueState(geometry);

  const needed = state.count + uniqueIds.length;
  if (needed > state.buf.length) {
    const nextLen = Math.max(needed, state.buf.length * 2);
    const next = new Uint32Array(nextLen);
    next.set(state.buf.subarray(0, state.count));
    state.buf = next;
  }

  state.buf.set(uniqueIds, state.count);
  state.count += uniqueIds.length;

  if (state.timeoutId != null) return;

  const flushChunk = () => {
    state.timeoutId = null;

    // Stop if stroke ended.
    if (!activeStrokeGeometry.has(geometry)) {
      state.count = 0;
      state.read = 0;
      return;
    }

    const topo = getMeshTopology(geometry);
    if (!topo) {
      state.count = 0;
      state.read = 0;
      return;
    }

    const chunkSize = 128;
    const end = Math.min(state.count, state.read + chunkSize);
    if (end > state.read) {
      applyHighlightToUniqueVertices(geometry, topo, state.buf.subarray(state.read, end));
      state.read = end;
    }

    if (state.read < state.count) {
      state.timeoutId = setTimeout(flushChunk, 0) as unknown as number;
      return;
    }

    // Finished.
    state.count = 0;
    state.read = 0;
  };

  state.timeoutId = setTimeout(flushChunk, 0) as unknown as number;
}

function applyHighlightToUniqueVertices(geometry: THREE.BufferGeometry, topo: NonNullable<ReturnType<typeof getMeshTopology>>, uniqueIds: Uint32Array): void {
  const hs = getOrCreateHighlightState(geometry);
  if (!hs) return;

  const stamp = hs.stamp;
  const mark = hs.mark;
  const colors = hs.colors;

  let savedIndices = hs.savedIndices;
  let savedColors = hs.savedColors;
  let savedCount = hs.savedCount;

  const hex = getMeshSmoothingSettings().highlightColor;
  const m = typeof hex === 'string' ? hex.match(/^#?([0-9a-fA-F]{6})$/) : null;
  const rgb = m ? parseInt(m[1], 16) : 0x269eff;
  const hr = ((rgb >> 16) & 0xff) / 255;
  const hg = ((rgb >> 8) & 0xff) / 255;
  const hb = (rgb & 0xff) / 255;

  for (let i = 0; i < uniqueIds.length; i++) {
    const uid = uniqueIds[i];
    const group = topo.groups[uid];
    if (!group) continue;
    for (let gi = 0; gi < group.length; gi++) {
      const vi = group[gi];
      if (vi >= mark.length) continue;

      // Already highlighted in this stroke; avoid redundant writes.
      if (mark[vi] === stamp) continue;
      mark[vi] = stamp;

      if (savedCount >= savedIndices.length) {
        const nextLen = Math.max(savedCount + 1, savedIndices.length * 2);
        const nextIdx = new Uint32Array(nextLen);
        nextIdx.set(savedIndices);
        savedIndices = nextIdx;

        const nextCol = new Float32Array(nextLen * 3);
        nextCol.set(savedColors);
        savedColors = nextCol;
      }

      const v3 = vi * 3;
      savedIndices[savedCount] = vi;
      savedColors[savedCount * 3 + 0] = colors[v3 + 0];
      savedColors[savedCount * 3 + 1] = colors[v3 + 1];
      savedColors[savedCount * 3 + 2] = colors[v3 + 2];
      savedCount++;

      colors[v3 + 0] = hr;
      colors[v3 + 1] = hg;
      colors[v3 + 2] = hb;
    }
  }

  hs.savedIndices = savedIndices;
  hs.savedColors = savedColors;
  hs.savedCount = savedCount;
  hs.colorAttr.needsUpdate = true;
}

function ensureSmoothingWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (smoothingWorker) return smoothingWorker;

  try {
    const w = new Worker(new URL('./meshSmoothing.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<MeshSmoothingWorkerResultMessage>) => {
      const msg = e.data;
      if (!msg || msg.type !== 'result') return;
      if (!workerActiveGeometry) return;
      if (msg.geometryKey !== workerActiveGeometryKey) return;
      // Apply progressively: accept any newer-than-last-applied job so updates appear live.
      // We still only finalize the stroke once the latest-sent job has landed.
      if (msg.jobId <= workerLatestAppliedJobId) return;

      const geometry = workerActiveGeometry;
      const topo = getMeshTopology(geometry);
      if (!topo) return;

      applyHighlightToUniqueVertices(geometry, topo, msg.applied);

      captureBeforeUniquePositions(geometry, topo, msg.applied);

      // Apply updated unique positions.
      const applied = msg.applied;
      const newPos = msg.newPositions;
      const uPos = topo.uniquePositions;
      const posAttr = topo.positionAttribute;
      const arr = posAttr.array as Float32Array;

      // Safety: never write invalid numbers into geometry.
      for (let i = 0; i < applied.length; i++) {
        const x = newPos[i * 3 + 0];
        const y = newPos[i * 3 + 1];
        const z = newPos[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          console.error('[MeshSmoothingEngine] Worker produced invalid vertex positions; aborting apply', {
            geometryKey: msg.geometryKey,
            jobId: msg.jobId,
            index: i,
            x,
            y,
            z,
          });

          // Disable worker for this stroke and finalize safely on the current geometry.
          workerPendingFinalize = false;
          workerActiveGeometry = null;
          workerActiveGeometryKey = 0;
          try { finalizeStrokeGeometry(geometry); } catch { }
          return;
        }
      }

      if (workerPendingFinalize) {
        setProcessingState({ active: true, progress: 0 });
      }

      let i = 0;
      const total = applied.length;
      const chunkSize = 512;

      const applyChunk = () => {
        const end = Math.min(total, i + chunkSize);
        for (; i < end; i++) {
          const uid = applied[i];
          const x = newPos[i * 3 + 0];
          const y = newPos[i * 3 + 1];
          const z = newPos[i * 3 + 2];

          const u3 = uid * 3;
          uPos[u3 + 0] = x;
          uPos[u3 + 1] = y;
          uPos[u3 + 2] = z;

          const group = topo.groups[uid];
          for (let gi = 0; gi < group.length; gi++) {
            const vi = group[gi];
            const v3 = vi * 3;
            arr[v3 + 0] = x;
            arr[v3 + 1] = y;
            arr[v3 + 2] = z;
          }
        }

        if (workerPendingFinalize) {
          const progress = total > 0 ? i / total : 1;
          setProcessingState({ active: true, progress });
        }

        if (i < total) {
          setTimeout(applyChunk, 0);
          return;
        }

        posAttr.needsUpdate = true;
        workerLatestAppliedJobId = msg.jobId;

        if (workerPendingFinalize && workerLatestAppliedJobId === workerLatestSentJobId) {
          workerPendingFinalize = false;
          setTimeout(() => {
            try {
              finalizeStrokeGeometry(geometry);
            } finally {
              setProcessingState({ active: false, progress: 1 });
              workerActiveGeometry = null;
              workerActiveGeometryKey = 0;
            }
          }, 0);
        }
      };

      if (total > 0) {
        setTimeout(applyChunk, 0);
      } else {
        posAttr.needsUpdate = true;
        workerLatestAppliedJobId = msg.jobId;
      }
    };

    smoothingWorker = w;
    return smoothingWorker;
  } catch (err) {
    console.error('[MeshSmoothingEngine] Failed to create worker', err);
    smoothingWorker = null;
    return null;
  }
}

function getSmoothingScratch(geometry: THREE.BufferGeometry, uniqueCount: number): SmoothingScratch {
  const neededWeights = uniqueCount;
  const neededTmp = uniqueCount * 3;

  const existing = scratchSmoothingByGeometry.get(geometry);
  if (existing && existing.weights.length >= neededWeights && existing.tmp.length >= neededTmp) {
    return existing;
  }

  const next: SmoothingScratch = {
    weights: new Float32Array(Math.max(neededWeights, existing?.weights.length ?? 0)),
    tmp: new Float32Array(Math.max(neededTmp, existing?.tmp.length ?? 0)),
  };

  scratchSmoothingByGeometry.set(geometry, next);
  return next;
}

function queryAffectedUniqueVertices(
  geometry: THREE.BufferGeometry,
  centerLocal: THREE.Vector3,
  radius: number,
): Uint32Array {
  const topology = getMeshTopology(geometry);
  if (!topology) return new Uint32Array(0);

  // For small brush radii, the spatial hash query is typically faster than BVH shapecast.
  if (radius <= 1.5) {
    return queryUniqueVerticesInSphere(topology, centerLocal, radius);
  }

  const g = geometry as BVHGeometry;
  if (!g.boundsTree || typeof g.boundsTree.shapecast !== 'function') {
    // Fallback: spatial hash scan (slower)
    return queryUniqueVerticesInSphere(topology, centerLocal, radius);
  }

  const indexAttr = geometry.getIndex();
  const idxArray = indexAttr ? (indexAttr.array as unknown as ArrayLike<number>) : null;

  let qo = scratchQueryObjectsByGeometry.get(geometry);
  if (!qo) {
    qo = { sphere: new THREE.Sphere(new THREE.Vector3(), 1), closestPoint: new THREE.Vector3() };
    scratchQueryObjectsByGeometry.set(geometry, qo);
  }
  qo.sphere.center.copy(centerLocal);
  qo.sphere.radius = radius;
  const sphere = qo.sphere;
  const closestPoint = qo.closestPoint;
  const radius2 = radius * radius;

  let scratch = scratchIdsByGeometry.get(geometry);
  if (!scratch) {
    scratch = [];
    scratchIdsByGeometry.set(geometry, scratch);
  }
  scratch.length = 0;

  // Increment stamp, reset if we overflow.
  topology.stamp = (topology.stamp + 1) >>> 0;
  if (topology.stamp === 0) {
    topology.mark.fill(0);
    topology.stamp = 1;
  }

  const mark = topology.mark;
  const stamp = topology.stamp;
  const uPos = topology.uniquePositions;
  const originalToUnique = topology.originalToUnique;

  const maybeAddUnique = (uid: number) => {
    if (uid >= mark.length) return;
    if (mark[uid] === stamp) return;

    const u3 = uid * 3;
    const dx = uPos[u3 + 0] - centerLocal.x;
    const dy = uPos[u3 + 1] - centerLocal.y;
    const dz = uPos[u3 + 2] - centerLocal.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > radius2) return;

    mark[uid] = stamp;
    scratch!.push(uid);
  };

  g.boundsTree.shapecast({
    intersectsBounds: (box) => sphere.intersectsBox(box),
    intersectsTriangle: (_tri, triIndex) => {
      // Fast reject: triangle doesn't touch the sphere.
      _tri.closestPointToPoint(centerLocal, closestPoint);
      if (closestPoint.distanceToSquared(centerLocal) > radius2) return false;

      if (idxArray) {
        const a = idxArray[triIndex * 3 + 0] as number;
        const b = idxArray[triIndex * 3 + 1] as number;
        const c = idxArray[triIndex * 3 + 2] as number;
        maybeAddUnique(originalToUnique[a]);
        maybeAddUnique(originalToUnique[b]);
        maybeAddUnique(originalToUnique[c]);
      } else {
        const a = triIndex * 3 + 0;
        const b = triIndex * 3 + 1;
        const c = triIndex * 3 + 2;
        maybeAddUnique(originalToUnique[a]);
        maybeAddUnique(originalToUnique[b]);
        maybeAddUnique(originalToUnique[c]);
      }

      return false;
    },
  });

  let typed = scratchAffectedByGeometry.get(geometry);
  if (!typed || typed.length < scratch.length) {
    typed = new Uint32Array(Math.max(scratch.length, typed?.length ?? 0, 64));
    scratchAffectedByGeometry.set(geometry, typed);
  }

  for (let i = 0; i < scratch.length; i++) {
    typed[i] = scratch[i];
  }
  return typed.subarray(0, scratch.length);
}

export function beginMeshSmoothingEngineStroke(geometry: THREE.BufferGeometry): void {
  activeStrokeGeometry.set(geometry, {
    affectedUnique: new Set(),
    beforeIndexByUid: new Map(),
    ids: [],
    before: [],
    samples: [],
  });

  clearHighlightQueue(geometry);
  beginHighlightStroke(geometry);

  if (readyByGeometry.has(geometry)) {
    initSmoothingForGeometry(geometry);
    return;
  }

  // First-time init can be heavy (topology build + worker warmup). Defer so UI can show a loading indicator.
  setLoadingState({ active: true });
  const token = { canceled: false };
  pendingInitByGeometry.set(geometry, token);

  setTimeout(() => {
    const current = pendingInitByGeometry.get(geometry);
    if (!current || current !== token || token.canceled) return;

    try {
      if (initSmoothingForGeometry(geometry)) {
        readyByGeometry.add(geometry);
      }
    } finally {
      pendingInitByGeometry.delete(geometry);
      setLoadingState({ active: false });
    }
  }, 0);
}

export function paintMeshSmoothingEngineStep(
  geometry: THREE.BufferGeometry,
  centerLocal: THREE.Vector3,
  settings: MeshSmoothingSettings,
): void {
  // We no longer mutate mesh vertex colors during the stroke.
  // Stroke preview is handled by a GPU overlay, and we collect samples for stroke-end smoothing.
  void geometry;
  void centerLocal;
  void settings;
}

export function applyMeshSmoothingEngineStep(
  geometry: THREE.BufferGeometry,
  centerLocal: THREE.Vector3,
  settings: MeshSmoothingSettings,
): void {
  const topology = getMeshTopology(geometry);
  if (!topology) return;

  const radius = clampMeshSmoothingBrushSizeMm(settings.brushSizeMm);
  const affected = queryAffectedUniqueVertices(geometry, centerLocal, radius);
  if (affected.length === 0) return;

  applyHighlightToUniqueVertices(geometry, topology, affected);

  const w = ensureSmoothingWorker();
  const geometryKey = getGeometryKey(geometry);
  const maxVertices = 2500;

  // Use worker if available and geometry matches the active stroke.
  if (w && workerActiveGeometry === geometry && workerActiveGeometryKey === geometryKey && !workerPendingFinalize) {
    const jobId = workerNextJobId++;
    workerLatestSentJobId = jobId;

    // Important: transfer a tightly-sized buffer to avoid expensive structured cloning.
    const affectedPacked = new Uint32Array(affected.length);
    affectedPacked.set(affected);

    const msg: MeshSmoothingWorkerStepMessage = {
      type: 'step',
      geometryKey,
      jobId,
      center: [centerLocal.x, centerLocal.y, centerLocal.z],
      radius,
      strength: Math.max(0, Math.min(1, settings.strength)),
      iterations: settings.iterations,
      falloff: settings.falloff,
      maxVertices,
      affected: affectedPacked,
    };

    w.postMessage(msg, [affectedPacked.buffer]);
    return;
  }

  // CPU fallback (keeps functionality even if Worker is unavailable).
  const opts: SmoothingStepOptions = {
    center: centerLocal,
    radius,
    strength: Math.max(0, Math.min(1, settings.strength)),
    iterations: settings.iterations,
    falloff: settings.falloff,
    maxVertices,
  };

  const plannedApplied = limitVertices(affected, maxVertices);
  captureBeforeUniquePositions(geometry, topology, plannedApplied);

  const scratch = getSmoothingScratch(geometry, affected.length);
  const applied = applySmoothingToTopology(topology, affected, opts, scratch);

  const stroke = activeStrokeGeometry.get(geometry);
  if (stroke) {
    for (let i = 0; i < applied.length; i++) stroke.affectedUnique.add(applied[i]);
  }

  // Write back to geometry position attribute
  const posAttr = topology.positionAttribute;
  const arr = posAttr.array as Float32Array;

  for (let i = 0; i < applied.length; i++) {
    const uid = applied[i];
    const u3 = uid * 3;
    const x = topology.uniquePositions[u3 + 0];
    const y = topology.uniquePositions[u3 + 1];
    const z = topology.uniquePositions[u3 + 2];

    const group = topology.groups[uid];
    for (let gi = 0; gi < group.length; gi++) {
      const vi = group[gi];
      const v3 = vi * 3;
      arr[v3 + 0] = x;
      arr[v3 + 1] = y;
      arr[v3 + 2] = z;
    }
  }

  posAttr.needsUpdate = true;
}

export function endMeshSmoothingEngineStroke(geometry: THREE.BufferGeometry): void {
  clearHighlightQueue(geometry);

  const pending = pendingInitByGeometry.get(geometry);
  if (pending) {
    pending.canceled = true;
    pendingInitByGeometry.delete(geometry);
    setLoadingState({ active: false });
  }

  if (!readyByGeometry.has(geometry)) {
    activeStrokeGeometry.delete(geometry);
    if (workerActiveGeometry === geometry) {
      workerActiveGeometry = null;
      workerActiveGeometryKey = 0;
    }
    return;
  }

  const topo = getMeshTopology(geometry);
  const stroke = activeStrokeGeometry.get(geometry);
  const settings = getMeshSmoothingSettings();
  const maxVertices = 8000;

  // If we didn't collect affected verts during the stroke, compute them now from stroke samples.
  if (topo && stroke && stroke.affectedUnique.size === 0 && stroke.samples.length > 0) {
    const radius = clampMeshSmoothingBrushSizeMm(settings.brushSizeMm);
    const samples = stroke.samples;
    for (let i = 0; i + 2 < samples.length; i += 3) {
      const center = new THREE.Vector3(samples[i] ?? 0, samples[i + 1] ?? 0, samples[i + 2] ?? 0);
      const affected = queryUniqueVerticesInSphere(topo, center, radius);
      for (let j = 0; j < affected.length; j++) {
        stroke.affectedUnique.add(affected[j]);
      }
    }
  }

  if (!topo || !stroke || stroke.affectedUnique.size === 0) {
    workerPendingFinalize = false;
    finalizeStrokeGeometry(geometry);
    if (workerActiveGeometry === geometry) {
      workerActiveGeometry = null;
      workerActiveGeometryKey = 0;
    }
    return;
  }

  const affected = Uint32Array.from(stroke.affectedUnique);
  captureBeforeUniquePositions(geometry, topo, affected);

  const w = ensureSmoothingWorker();
  const geometryKey = getGeometryKey(geometry);

  if (w && workerActiveGeometry === geometry && workerActiveGeometryKey === geometryKey) {
    const jobId = workerNextJobId++;
    workerLatestSentJobId = jobId;
    workerLatestAppliedJobId = 0;
    workerPendingFinalize = true;
    setProcessingState({ active: true, progress: 0 });

    const affectedPacked = new Uint32Array(affected.length);
    affectedPacked.set(affected);

    const msg: MeshSmoothingWorkerFinalizeMessage = {
      type: 'finalize',
      geometryKey,
      jobId,
      strength: Math.max(0, Math.min(1, settings.strength)),
      iterations: settings.iterations,
      maxVertices,
      affected: affectedPacked,
    };

    w.postMessage(msg, [affectedPacked.buffer]);
    return;
  }

  setProcessingState({ active: true, progress: 0 });
  const applied = applyUniformSmoothingToTopology(topo, affected, settings, maxVertices);

  const posAttr = topo.positionAttribute;
  const arr = posAttr.array as Float32Array;
  for (let i = 0; i < applied.length; i++) {
    const uid = applied[i];
    const u3 = uid * 3;
    const x = topo.uniquePositions[u3 + 0];
    const y = topo.uniquePositions[u3 + 1];
    const z = topo.uniquePositions[u3 + 2];
    const group = topo.groups[uid];
    for (let gi = 0; gi < group.length; gi++) {
      const vi = group[gi];
      const v3 = vi * 3;
      arr[v3 + 0] = x;
      arr[v3 + 1] = y;
      arr[v3 + 2] = z;
    }
  }
  posAttr.needsUpdate = true;

  try {
    finalizeStrokeGeometry(geometry);
  } finally {
    setProcessingState({ active: false, progress: 1 });
    if (workerActiveGeometry === geometry) {
      workerActiveGeometry = null;
      workerActiveGeometryKey = 0;
    }
  }
}
