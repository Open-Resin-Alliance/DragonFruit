import * as THREE from 'three';

export type MeshTopology = {
  geometry: THREE.BufferGeometry;
  positionAttribute: THREE.BufferAttribute;
  /** Unique vertex positions (welded). Length = uniqueCount * 3. */
  uniquePositions: Float32Array;
  /** Map unique vertex -> list of original vertex indices in the geometry's position attribute. */
  groups: Uint32Array[];
  /** Map original vertex index (in position attribute) -> unique welded vertex id. */
  originalToUnique: Uint32Array;
  /** Adjacency list per unique vertex. */
  neighbors: Uint32Array[];
  /** Spatial hash for querying vertices near a point. */
  spatialHash: Map<string, Uint32Array>;
  /** Cell size used for spatial hash. */
  cellSize: number;
  /** Scratch mark buffer for fast per-query de-duping (mark[id] === stamp => seen). */
  mark: Uint32Array;
  /** Incrementing stamp used with `mark` to avoid clearing arrays. */
  stamp: number;
};

type BuildState = {
  uniquePositions: number[];
  groups: number[][];
  neighborSets: Array<Set<number>>;
  spatialBuckets: Map<string, number[]>;
};

const topologyCache = new WeakMap<THREE.BufferGeometry, MeshTopology>();
const sphereQueryScratch = new WeakMap<MeshTopology, number[]>();
const sphereQueryScratchTyped = new WeakMap<MeshTopology, Uint32Array>();

function makeKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

function quantize(v: number, tol: number): number {
  return Math.round(v / tol);
}

function getOrCreateUniqueVertex(
  state: BuildState,
  dedupe: Map<string, number>,
  tol: number,
  x: number,
  y: number,
  z: number,
  originalIndex: number,
  originalToUnique: Uint32Array,
): number {
  const qx = quantize(x, tol);
  const qy = quantize(y, tol);
  const qz = quantize(z, tol);
  const key = makeKey(qx, qy, qz);

  const existing = dedupe.get(key);
  if (existing !== undefined) {
    state.groups[existing].push(originalIndex);
    originalToUnique[originalIndex] = existing;
    return existing;
  }

  const id = state.groups.length;
  dedupe.set(key, id);

  state.uniquePositions.push(x, y, z);
  state.groups.push([originalIndex]);
  state.neighborSets.push(new Set());
  originalToUnique[originalIndex] = id;
  return id;
}

function addEdge(state: BuildState, a: number, b: number) {
  if (a === b) return;
  state.neighborSets[a].add(b);
  state.neighborSets[b].add(a);
}

function addToSpatialHash(state: BuildState, cellSize: number, id: number, x: number, y: number, z: number) {
  const ix = Math.floor(x / cellSize);
  const iy = Math.floor(y / cellSize);
  const iz = Math.floor(z / cellSize);
  const key = makeKey(ix, iy, iz);
  const bucket = state.spatialBuckets.get(key);
  if (bucket) bucket.push(id);
  else state.spatialBuckets.set(key, [id]);
}

function finalizeBuckets(spatialBuckets: Map<string, number[]>): Map<string, Uint32Array> {
  const out = new Map<string, Uint32Array>();
  for (const [k, arr] of spatialBuckets.entries()) {
    out.set(k, Uint32Array.from(arr));
  }
  return out;
}

export function getMeshTopology(geometry: THREE.BufferGeometry): MeshTopology | null {
  const existing = topologyCache.get(geometry);
  if (existing) return existing;

  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return null;

  const posArray = position.array as Float32Array;
  const indexAttr = geometry.getIndex();

  const originalToUnique = new Uint32Array(position.count);

  // Dedupe tolerance: tiny value in model units (mm).
  // This welds STL duplicated vertices while still preserving distinct features.
  const weldTolerance = 1e-4;

  // Spatial hash cell size: tuned for our brush max radius (5mm). Smaller cells reduce per-query work.
  const cellSize = 0.5;

  const state: BuildState = {
    uniquePositions: [],
    groups: [],
    neighborSets: [],
    spatialBuckets: new Map(),
  };

  const dedupe = new Map<string, number>();

  const getVertex = (originalIndex: number) => {
    const i3 = originalIndex * 3;
    return {
      x: posArray[i3 + 0],
      y: posArray[i3 + 1],
      z: posArray[i3 + 2],
    };
  };

  if (indexAttr) {
    const idx = indexAttr.array as unknown as ArrayLike<number>;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i + 0] as number;
      const b = idx[i + 1] as number;
      const c = idx[i + 2] as number;

      const pa = getVertex(a);
      const pb = getVertex(b);
      const pc = getVertex(c);

      const ua = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pa.x, pa.y, pa.z, a, originalToUnique);
      const ub = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pb.x, pb.y, pb.z, b, originalToUnique);
      const uc = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pc.x, pc.y, pc.z, c, originalToUnique);

      addEdge(state, ua, ub);
      addEdge(state, ub, uc);
      addEdge(state, uc, ua);
    }
  } else {
    // Non-indexed geometry (common for STL): triangles are consecutive triplets.
    for (let i = 0; i < position.count; i += 3) {
      const a = i + 0;
      const b = i + 1;
      const c = i + 2;

      const pa = getVertex(a);
      const pb = getVertex(b);
      const pc = getVertex(c);

      const ua = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pa.x, pa.y, pa.z, a, originalToUnique);
      const ub = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pb.x, pb.y, pb.z, b, originalToUnique);
      const uc = getOrCreateUniqueVertex(state, dedupe, weldTolerance, pc.x, pc.y, pc.z, c, originalToUnique);

      addEdge(state, ua, ub);
      addEdge(state, ub, uc);
      addEdge(state, uc, ua);
    }
  }

  // Build spatial buckets from unique positions.
  for (let id = 0; id < state.groups.length; id++) {
    const i3 = id * 3;
    addToSpatialHash(state, cellSize, id, state.uniquePositions[i3 + 0], state.uniquePositions[i3 + 1], state.uniquePositions[i3 + 2]);
  }

  const uniqueCount = state.groups.length;
  const uniquePositions = Float32Array.from(state.uniquePositions);

  const groups = state.groups.map((g) => Uint32Array.from(g));
  const neighbors = state.neighborSets.map((s) => Uint32Array.from(s));

  const topology: MeshTopology = {
    geometry,
    positionAttribute: position,
    uniquePositions,
    groups,
    originalToUnique,
    neighbors,
    spatialHash: finalizeBuckets(state.spatialBuckets),
    cellSize,
    mark: new Uint32Array(uniqueCount),
    stamp: 1,
  };

  topologyCache.set(geometry, topology);
  return topology;
}

export function invalidateMeshTopology(geometry: THREE.BufferGeometry): void {
  topologyCache.delete(geometry);
}

export function queryUniqueVerticesInSphere(
  topology: MeshTopology,
  center: THREE.Vector3,
  radius: number,
): Uint32Array {
  const r = Math.max(0.0001, radius);
  const r2 = r * r;

  let scratch = sphereQueryScratch.get(topology);
  if (!scratch) {
    scratch = [];
    sphereQueryScratch.set(topology, scratch);
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

  const cs = topology.cellSize;
  const minX = Math.floor((center.x - r) / cs);
  const maxX = Math.floor((center.x + r) / cs);
  const minY = Math.floor((center.y - r) / cs);
  const maxY = Math.floor((center.y + r) / cs);
  const minZ = Math.floor((center.z - r) / cs);
  const maxZ = Math.floor((center.z + r) / cs);

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iy = minY; iy <= maxY; iy++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const bucket = topology.spatialHash.get(makeKey(ix, iy, iz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const id = bucket[bi];
          if (mark[id] === stamp) continue;
          const i3 = id * 3;
          const dx = topology.uniquePositions[i3 + 0] - center.x;
          const dy = topology.uniquePositions[i3 + 1] - center.y;
          const dz = topology.uniquePositions[i3 + 2] - center.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          mark[id] = stamp;
          scratch.push(id);
        }
      }
    }
  }

  let typed = sphereQueryScratchTyped.get(topology);
  if (!typed || typed.length < scratch.length) {
    typed = new Uint32Array(Math.max(scratch.length, typed?.length ?? 0, 64));
    sphereQueryScratchTyped.set(topology, typed);
  }
  for (let i = 0; i < scratch.length; i++) {
    typed[i] = scratch[i];
  }
  return typed.subarray(0, scratch.length);
}
