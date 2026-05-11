import * as THREE from 'three';
import { convexHull2d } from './convexHull2d';
import { delaunayTriangulate2d } from './delaunayTriangulate2d';

type EdgeKey = string;

function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function edgeLen(a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = new Array(size);
    for (let i = 0; i < size; i += 1) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }

    let cursor = x;
    while (this.parent[cursor] !== cursor) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }

    return root;
  }

  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent[rb] = ra;
    return true;
  }

  componentCount(): number {
    const roots = new Set<number>();
    for (let i = 0; i < this.parent.length; i += 1) {
      roots.add(this.find(i));
    }
    return roots.size;
  }
}

export type BuildLineRaftEdgePairsOptions = {
  hasBorderRing: boolean;
  keepFactor?: number;
  absMaxLen?: number;
  enforceConnected?: boolean;
  includeSpanningTreeBackbone?: boolean;
};

export function buildLineRaftEdgePairs(
  nodes2d: THREE.Vector2[],
  options: BuildLineRaftEdgePairsOptions,
): Array<[number, number]> {
  if (!nodes2d || nodes2d.length < 2) return [];

  const keepFactor = options.keepFactor ?? 8;
  const absMaxLen = options.absMaxLen ?? 220;
  const enforceConnected = options.enforceConnected ?? true;
  const includeSpanningTreeBackbone = options.includeSpanningTreeBackbone ?? true;

  const hull = convexHull2d(nodes2d);
  const hullIndices: number[] = hull.map((hp) => {
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < nodes2d.length; i++) {
      const p = nodes2d[i];
      const dx = p.x - hp.x;
      const dy = p.y - hp.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  });

  const hullEdges: Array<[number, number]> = [];
  if (hullIndices.length >= 2) {
    for (let i = 0; i < hullIndices.length; i++) {
      const a = hullIndices[i];
      const b = hullIndices[(i + 1) % hullIndices.length];
      if (a !== b) hullEdges.push([a, b]);
    }
  }

  const tris = delaunayTriangulate2d(nodes2d);

  const nn = new Array(nodes2d.length).fill(Infinity);
  for (let i = 0; i < nodes2d.length; i++) {
    for (let j = 0; j < nodes2d.length; j++) {
      if (i === j) continue;
      nn[i] = Math.min(nn[i], edgeLen(nodes2d[i], nodes2d[j]));
    }
    if (!Number.isFinite(nn[i])) nn[i] = 0;
  }

  const edges = new Set<EdgeKey>();
  const edgePairs: Array<[number, number]> = [];
  const candidateEdgeByKey = new Map<EdgeKey, { a: number; b: number; len: number }>();

  const recordCandidate = (a: number, b: number): void => {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (candidateEdgeByKey.has(key)) return;
    candidateEdgeByKey.set(key, { a, b, len: edgeLen(nodes2d[a], nodes2d[b]) });
  };

  for (const [a, b] of hullEdges) {
    recordCandidate(a, b);
    const key = edgeKey(a, b);
    if (!edges.has(key)) {
      edges.add(key);
      edgePairs.push([a, b]);
    }
  }

  for (const [i, j, k] of tris) {
    const triEdges: Array<[number, number]> = [
      [i, j],
      [j, k],
      [k, i],
    ];

    for (const [a, b] of triEdges) {
      const key = edgeKey(a, b);

      recordCandidate(a, b);

      if (edges.has(key)) continue;

      const len = edgeLen(nodes2d[a], nodes2d[b]);
      const localMax = keepFactor * Math.min(nn[a], nn[b]);
      if (len > absMaxLen) continue;
      if (nn[a] > 0 && nn[b] > 0 && len > localMax) continue;

      edges.add(key);
      edgePairs.push([a, b]);
    }
  }

  if (!enforceConnected || nodes2d.length < 3) {
    return edgePairs;
  }

  if (includeSpanningTreeBackbone) {
    const mst = new UnionFind(nodes2d.length);
    const candidateEdges = Array.from(candidateEdgeByKey.values());
    candidateEdges.sort((left, right) => left.len - right.len);

    for (const candidate of candidateEdges) {
      if (!mst.union(candidate.a, candidate.b)) continue;
      const key = edgeKey(candidate.a, candidate.b);
      if (edges.has(key)) continue;
      edges.add(key);
      edgePairs.push([candidate.a, candidate.b]);
    }

    if (mst.componentCount() > 1) {
      const bridgeCandidates: Array<{ a: number; b: number; len: number }> = [];
      for (let i = 0; i < nodes2d.length; i += 1) {
        for (let j = i + 1; j < nodes2d.length; j += 1) {
          const key = edgeKey(i, j);
          if (candidateEdgeByKey.has(key)) continue;
          bridgeCandidates.push({ a: i, b: j, len: edgeLen(nodes2d[i], nodes2d[j]) });
        }
      }

      bridgeCandidates.sort((left, right) => left.len - right.len);

      for (const candidate of bridgeCandidates) {
        if (mst.componentCount() <= 1) break;
        if (!mst.union(candidate.a, candidate.b)) continue;
        const key = edgeKey(candidate.a, candidate.b);
        if (edges.has(key)) continue;
        edges.add(key);
        edgePairs.push([candidate.a, candidate.b]);
      }
    }
  } else {
    const uf = new UnionFind(nodes2d.length);
    for (const [a, b] of edgePairs) {
      uf.union(a, b);
    }

    if (uf.componentCount() > 1) {
      const bridgeCandidates: Array<{ a: number; b: number; len: number }> = [];
      for (let i = 0; i < nodes2d.length; i += 1) {
        for (let j = i + 1; j < nodes2d.length; j += 1) {
          const key = edgeKey(i, j);
          if (edges.has(key)) continue;
          bridgeCandidates.push({ a: i, b: j, len: edgeLen(nodes2d[i], nodes2d[j]) });
        }
      }

      bridgeCandidates.sort((left, right) => left.len - right.len);

      for (const candidate of bridgeCandidates) {
        if (uf.componentCount() <= 1) break;
        if (!uf.union(candidate.a, candidate.b)) continue;
        const key = edgeKey(candidate.a, candidate.b);
        if (edges.has(key)) continue;
        edges.add(key);
        edgePairs.push([candidate.a, candidate.b]);
      }
    }
  }

  return edgePairs;
}
