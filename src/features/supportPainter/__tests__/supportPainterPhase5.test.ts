import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap } from '../useClientAdjacencyMap';
import { supportPainterStore } from '../supportPainterStore';

describe('Support Painter Phase 5 - Rust Minima Scanner & TypeScript batch consolidation', () => {

  // Setup mock ClientAdjacencyMap (centroids are 1.0mm apart)
  const mockAdjacencyMap: ClientAdjacencyMap = {
    faceCount: 9,
    faceNormals: Array.from({ length: 9 }, () => new THREE.Vector3(0, 0, -1)),
    faceCentroids: [
      new THREE.Vector3(0, 0, 0), // 0
      new THREE.Vector3(1, 0, 0), // 1
      new THREE.Vector3(2, 0, 0), // 2
      new THREE.Vector3(0, 1, 0), // 3
      new THREE.Vector3(1, 1, 0), // 4 (center)
      new THREE.Vector3(2, 1, 0), // 5
      new THREE.Vector3(0, 2, 0), // 6
      new THREE.Vector3(1, 2, 0), // 7
      new THREE.Vector3(2, 2, 0), // 8
    ],
    faceZBounds: Array.from({ length: 9 }, () => ({ min: -0.1, max: 0.1 })),
    faceToFaces: [
      [1, 3],       // 0
      [0, 2, 4],    // 1
      [1, 5],       // 2
      [0, 4, 6],    // 3
      [1, 3, 5, 7], // 4
      [2, 4, 8],    // 5
      [3, 7],       // 6
      [4, 6, 8],    // 7
      [5, 7],       // 8
    ],
  };

  it('should successfully commit multiple scanned minima coordinates into a single consolidated committed region', () => {
    supportPainterStore.clearAll();
    supportPainterStore.setClientAdjacencyMap(mockAdjacencyMap);

    const mockMinimaList = [
      { seedTriangleId: 4 }, // Center face
      { seedTriangleId: 0 }, // Corner face
    ];

    // Trigger batch commit
    supportPainterStore.commitMinimaIslands(mockMinimaList);

    const snapshot = supportPainterStore.getSnapshot();
    assert.strictEqual(snapshot.regions.size, 1, 'Should create exactly one consolidated region');

    const regionId = Array.from(snapshot.regions.keys())[0];
    const region = snapshot.regions.get(regionId)!;

    assert.ok(regionId.startsWith('auto-minima-'), 'Consolidated region ID should have auto-minima prefix');
    assert.strictEqual(region.brushType, 'MinimaIslands');
    assert.strictEqual(region.color, '#7ED321', 'Consolidated region should be colored green');
    assert.strictEqual(region.seedTriangleId, 4, 'Primary seed should reference first scan coordinate');

    // Centroids are 1.0mm apart, so 0.1mm radius should only select the seed faces themselves
    assert.strictEqual(region.triangleIds.size, 2, 'Consolidated region should contain exactly 2 triangles');
    assert.ok(region.triangleIds.has(4));
    assert.ok(region.triangleIds.has(0));
    assert.ok(!region.triangleIds.has(1));
  });
});
