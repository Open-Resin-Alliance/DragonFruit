import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap } from '../useClientAdjacencyMap';
import { supportPainterStore } from '../supportPainterStore';
import { upgradePipeline } from '../supportPainterTypes';

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

  it('should configure MinimaIslands default pipeline with only minima enabled and suppression disabled', () => {
    const pipeline = upgradePipeline(undefined, 'MinimaIslands', 4.0);

    const minimaOp = pipeline.find(op => op.type === 'minima');
    assert.ok(minimaOp, 'Minima stage operation must exist');
    assert.strictEqual(minimaOp.enabled, true, 'Minima stage must be enabled');
    assert.strictEqual(minimaOp.suppression.enabled, false, 'Suppression must be disabled for MinimaIslands minima stage');

    const perimeterOp = pipeline.find(op => op.type === 'perimeter');
    assert.ok(perimeterOp, 'Perimeter stage operation must exist');
    assert.strictEqual(perimeterOp.enabled, false, 'Perimeter stage must be disabled for MinimaIslands');

    const infillOp = pipeline.find(op => op.type === 'infill');
    assert.ok(infillOp, 'Infill stage operation must exist');
    assert.strictEqual(infillOp.enabled, false, 'Infill stage must be disabled for MinimaIslands');

    const centerlineOp = pipeline.find(op => op.type === 'centerline');
    assert.ok(centerlineOp, 'Centerline stage operation must exist');
    assert.strictEqual(centerlineOp.enabled, false, 'Centerline stage must be disabled for MinimaIslands');
  });

  it('should configure other standard brushes with typical pipeline enabled states for safety and no regression', () => {
    // E.g., ManualCircle brush (standard area brush) should have minima, perimeter, and infill enabled
    const areaPipeline = upgradePipeline(undefined, 'ManualCircle', 4.0);

    const minimaOp = areaPipeline.find(op => op.type === 'minima');
    assert.strictEqual(minimaOp?.enabled, true, 'Minima stage must be enabled for area brushes');
    assert.strictEqual(minimaOp?.suppression.enabled, true, 'Minima stage suppression must be enabled for area brushes');

    const perimeterOp = areaPipeline.find(op => op.type === 'perimeter');
    assert.strictEqual(perimeterOp?.enabled, true, 'Perimeter stage must be enabled for area brushes');

    const infillOp = areaPipeline.find(op => op.type === 'infill');
    assert.strictEqual(infillOp?.enabled, true, 'Infill stage must be enabled for area brushes');

    const centerlineOp = areaPipeline.find(op => op.type === 'centerline');
    assert.strictEqual(centerlineOp?.enabled, false, 'Centerline stage must be disabled for area brushes');
  });

  it('should not prune disjointed triangle IDs for MinimaIslands regions in pruneOrphans', () => {
    supportPainterStore.clearAll();
    supportPainterStore.setClientAdjacencyMap(mockAdjacencyMap);

    const mockMinimaList = [
      { seedTriangleId: 4 }, // Center face
      { seedTriangleId: 0 }, // Corner face (disjointed from 4)
    ];

    supportPainterStore.commitMinimaIslands(mockMinimaList);

    const snapshotBefore = supportPainterStore.getSnapshot();
    const regionId = Array.from(snapshotBefore.regions.keys())[0];
    const regionBefore = snapshotBefore.regions.get(regionId)!;

    assert.strictEqual(regionBefore.triangleIds.size, 2, 'Should initially contain 2 disjointed triangles');

    // Run pruneOrphans (normally, since triangles 0 and 4 are disconnected, one would be pruned)
    supportPainterStore.pruneOrphans(regionId);

    const snapshotAfter = supportPainterStore.getSnapshot();
    const regionAfter = snapshotAfter.regions.get(regionId)!;

    assert.strictEqual(regionAfter.triangleIds.size, 2, 'Should still contain 2 disjointed triangles because MinimaIslands is exempt from pruneOrphans');
  });
});

