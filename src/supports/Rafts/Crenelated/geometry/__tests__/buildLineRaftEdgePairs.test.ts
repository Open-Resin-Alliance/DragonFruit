import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildLineRaftEdgePairs } from '../buildLineRaftEdgePairs';

function countComponents(nodeCount: number, edges: Array<[number, number]>): number {
  const parent = new Array<number>(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cursor = x;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const [a, b] of edges) {
    union(a, b);
  }

  const roots = new Set<number>();
  for (let i = 0; i < nodeCount; i += 1) roots.add(find(i));
  return roots.size;
}

const twoFarClusters = [
  new THREE.Vector2(0, 0),
  new THREE.Vector2(10, 0),
  new THREE.Vector2(5, 8),
  new THREE.Vector2(320, 0),
  new THREE.Vector2(330, 0),
  new THREE.Vector2(325, 8),
];

test('line raft edge builder keeps outer-most hull links even under strict pruning', () => {
  const edges = buildLineRaftEdgePairs(twoFarClusters, {
    hasBorderRing: true,
    keepFactor: 1,
    absMaxLen: 50,
    enforceConnected: false,
  });

  const hasLongHullBridge = edges.some(([a, b]) => {
    const start = twoFarClusters[a];
    const end = twoFarClusters[b];
    return start.distanceTo(end) > 50;
  });

  assert.equal(hasLongHullBridge, true);
});

test('line raft edge builder bridges disconnected components when connectivity enforcement is enabled', () => {
  const edges = buildLineRaftEdgePairs(twoFarClusters, {
    hasBorderRing: true,
    keepFactor: 3.2,
    absMaxLen: 120,
    enforceConnected: true,
  });

  const components = countComponents(twoFarClusters.length, edges);
  assert.equal(components, 1);
});
