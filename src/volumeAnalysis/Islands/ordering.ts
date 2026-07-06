import type { DetectedIsland } from './types';
import { SpatialHashGrid2D } from './spatialHashGrid2D';

/**
 * Cluster-walk ordering for the island list and ←/→ step-through.
 *
 * Goal: consecutive entries are spatially coherent — stepping walks a local
 * cluster of nearby (and optionally co-visible) islands before advancing — while
 * the overall sweep still progresses by height. Island count `n` is small, so the
 * O(n^2) single-linkage clustering is negligible.
 *
 * Decision (2026-06-13): Euclidean clustering of contact points, optionally gated
 * by a co-visibility predicate (Part C, reuses the fly-to BVH). Geodesic
 * (mesh-walk) is deferred.
 */

export interface ClusterWalkOptions {
  /** 3D Euclidean radius (mm) below which two islands join a cluster. */
  epsilonMm: number;
  /**
   * Optional co-visibility predicate. When provided, two islands cluster only if
   * they are within `epsilonMm` AND `coVisible(a, b)` — i.e. one worm's-eye pose
   * can see both unobstructed. Omitted ⇒ pure Euclidean.
   */
  coVisible?: (a: DetectedIsland, b: DetectedIsland) => boolean;
}

interface Cluster {
  id: number;
  members: DetectedIsland[];
  minZ: number;
}

/**
 * Group islands by proximity, then return them in walk order: clusters sorted by
 * their lowest member Z; within a cluster, a nearest-neighbour chain starting
 * from the lowest-Z member. Mutates each island's `clusterId`.
 */
export function clusterWalkOrder(
  islands: DetectedIsland[],
  opts: ClusterWalkOptions,
): DetectedIsland[] {
  const n = islands.length;
  if (n === 0) return [];
  if (n === 1) {
    islands[0].clusterId = 0;
    return [...islands];
  }

  const eps2 = opts.epsilonMm * opts.epsilonMm;
  const near = (a: DetectedIsland, b: DetectedIsland): boolean => {
    if (a.contact.distanceToSquared(b.contact) > eps2) return false;
    return opts.coVisible ? opts.coVisible(a, b) : true;
  };

  // --- single-linkage clustering via union-find ---
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression.
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  const cellSize = opts.epsilonMm <= 0 ? 1.0 : opts.epsilonMm;
  const grid = new SpatialHashGrid2D<number>(cellSize);
  for (let i = 0; i < n; i++) {
    grid.insert(islands[i].contact.x, islands[i].contact.y, i);
  }

  for (let i = 0; i < n; i++) {
    const neighbors = grid.query(islands[i].contact.x, islands[i].contact.y, opts.epsilonMm);
    for (const j of neighbors) {
      if (j > i && near(islands[i], islands[j])) {
        union(i, j);
      }
    }
  }

  // --- collect clusters ---
  const byRoot = new Map<number, DetectedIsland[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = [];
      byRoot.set(root, bucket);
    }
    bucket.push(islands[i]);
  }

  const clusters: Cluster[] = [];
  let cid = 0;
  for (const members of byRoot.values()) {
    let minZ = Infinity;
    for (const m of members) if (m.baseZ < minZ) minZ = m.baseZ;
    const id = cid++;
    for (const m of members) m.clusterId = id;
    clusters.push({ id, members, minZ });
  }

  // --- order clusters by ascending lowest-Z, walk within each ---
  clusters.sort((a, b) => a.minZ - b.minZ);

  const order: DetectedIsland[] = [];
  for (const cluster of clusters) {
    order.push(...nearestNeighbourChain(cluster.members));
  }
  return order;
}

/** Greedy nearest-neighbour path through a cluster, starting at its lowest-Z member. */
function nearestNeighbourChain(members: DetectedIsland[]): DetectedIsland[] {
  if (members.length <= 2) {
    return [...members].sort((a, b) => a.baseZ - b.baseZ);
  }
  const remaining = [...members].sort((a, b) => a.baseZ - b.baseZ);
  const chain: DetectedIsland[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = chain[chain.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = last.contact.distanceToSquared(remaining[i].contact);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    chain.push(remaining.splice(bestIdx, 1)[0]);
  }
  return chain;
}
