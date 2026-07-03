import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clusterWalkOrder } from '../ordering';
import type { DetectedIsland } from '../types';

function island(id: string, x: number, y: number, z: number): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(x, y, z),
    baseZ: z,
    areaMm2: 1,
  };
}

test('clusters islands by Euclidean distance', () => {
  const islands = [
    island('a', 0, 0, 1),
    island('b', 1, 0, 2),
    island('c', 20, 20, 1),
    island('d', 21, 20, 2),
  ];

  const ordered = clusterWalkOrder(islands, { epsilonMm: 5 });

  // A and B should be in one cluster, C and D in another.
  // Cluster with lowest member Z starts first. Both have Z=1.
  assert.equal(ordered.length, 4);
  assert.equal(ordered[0].clusterId, ordered[1].clusterId);
  assert.equal(ordered[2].clusterId, ordered[3].clusterId);
  assert.notEqual(ordered[0].clusterId, ordered[2].clusterId);
});

test('honors co-visibility predicate', () => {
  const islands = [
    island('a', 0, 0, 1),
    island('b', 1, 0, 2),
  ];

  // If we require they are coVisible, but set coVisible to return false, they shouldn't cluster.
  const ordered = clusterWalkOrder(islands, {
    epsilonMm: 5,
    coVisible: () => false,
  });

  assert.equal(ordered.length, 2);
  assert.notEqual(ordered[0].clusterId, ordered[1].clusterId);
});

test('nearest neighbor chain sorting within a cluster', () => {
  const islands = [
    island('a', 0, 0, 1),   // lowest Z, start of cluster
    island('c', 10, 0, 3),  // far
    island('b', 2, 0, 2),   // near to a
  ];

  const ordered = clusterWalkOrder(islands, { epsilonMm: 15 });

  assert.equal(ordered.length, 3);
  // Start should be 'a' (lowest Z)
  assert.equal(ordered[0].id, 'a');
  // Next should be 'b' (distance to a = 2) instead of 'c' (distance to a = 10)
  assert.equal(ordered[1].id, 'b');
  assert.equal(ordered[2].id, 'c');
});
