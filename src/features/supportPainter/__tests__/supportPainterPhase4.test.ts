import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap, proposeRegionOnClient } from '../useClientAdjacencyMap';
import { supportPainterStore } from '../supportPainterStore';
import { type ROIRegion } from '../supportPainterTypes';

describe('Support Painter Phase 4 - Manual Geodesic Brushes & Boolean Operations', () => {

  // ─── Setup Flat 3x3 Grid Mesh for Dijkstra Walks ───────────────────────────
  // Coordinates are spaced 1.0mm apart:
  // 6: (0,2,0)   7: (1,2,0)   8: (2,2,0)
  // 3: (0,1,0)   4: (1,1,0)   5: (2,1,0)
  // 0: (0,0,0)   1: (1,0,0)   2: (2,0,0)
  const mockAdjacencyMap: ClientAdjacencyMap = {
    faceCount: 9,
    faceNormals: Array.from({ length: 9 }, () => new THREE.Vector3(0, 0, -1)), // Pointing downward (supportable overhang)
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

  const identityMatrix = new THREE.Matrix4();

  describe('Dijkstra Surface Walks & Clamping', () => {
    it('should select circular geodesic candidate faces within Dijkstra distance R', () => {
      // Circular walk with R = 1.5 from center (face 4).
      // Faces 1, 3, 5, 7 are at Dijkstra cost 1.0 (<= 1.5).
      // Faces 0, 2, 6, 8 are at Dijkstra cost 2.0 (> 1.5).
      const result = proposeRegionOnClient(
        mockAdjacencyMap,
        4, // Seed face 4
        'ManualCircle',
        identityMatrix,
        1.5 // Radius
      );

      assert.strictEqual(result.length, 5);
      assert.ok(result.includes(4));
      assert.ok(result.includes(1));
      assert.ok(result.includes(3));
      assert.ok(result.includes(5));
      assert.ok(result.includes(7));
      
      // Diagonals must be excluded because Dijkstra walk cost is 2.0
      assert.ok(!result.includes(0));
      assert.ok(!result.includes(2));
      assert.ok(!result.includes(6));
      assert.ok(!result.includes(8));
    });

    it('should select square geodesic candidate faces using local tangent projection clamping', () => {
      // Square walk with R = 1.5 from center (face 4).
      // tangent projection allows |du| <= 1.5 and |dv| <= 1.5
      // Max diagonal Dijkstra cost is 2.0 <= R * 1.414 = 2.121
      // Therefore, all 9 faces should be included.
      const result = proposeRegionOnClient(
        mockAdjacencyMap,
        4, // Seed face 4
        'ManualSquare',
        identityMatrix,
        1.5 // Radius
      );

      assert.strictEqual(result.length, 9);
      for (let i = 0; i < 9; i++) {
        assert.ok(result.includes(i), `Should contain face ${i}`);
      }
    });
  });

  describe('Connected-Component Graph BFS Orphan Pruner', () => {
    it('should silently prune disconnected painted triangle clusters starting from seed triangle', () => {
      // Setup a region with a main component and a disconnected orphan
      const regionId = 'test-prune-roi';
      const region: ROIRegion = {
        id: regionId,
        brushType: 'ManualCircle',
        seedTriangleId: 0, // Seed is 0
        triangleIds: new Set([0, 1, 3, 8]), // 0, 1, 3 are connected; 8 is an orphan
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      supportPainterStore.clearAll();
      supportPainterStore.setClientAdjacencyMap(mockAdjacencyMap);
      
      const regionsMap = new Map<string, ROIRegion>();
      regionsMap.set(regionId, region);
      supportPainterStore.restoreRegions(regionsMap);

      // Prune
      supportPainterStore.pruneOrphans(regionId);

      const updated = supportPainterStore.getSnapshot().regions.get(regionId);
      assert.ok(updated);
      assert.strictEqual(updated.triangleIds.size, 3);
      assert.ok(updated.triangleIds.has(0));
      assert.ok(updated.triangleIds.has(1));
      assert.ok(updated.triangleIds.has(3));
      assert.ok(!updated.triangleIds.has(8), 'Orphan face 8 should be pruned');
    });

    it('should isolate and keep the largest connected component if the seed has been erased', () => {
      // Setup a region where seed is face 4, but face 4 is not in triangleIds (erased)
      // Component A: {0, 1, 3} (size 3)
      // Component B: {7, 8} (size 2)
      const regionId = 'test-erased-seed-roi';
      const region: ROIRegion = {
        id: regionId,
        brushType: 'ManualCircle',
        seedTriangleId: 4, // Seed 4 is missing from triangleIds
        triangleIds: new Set([0, 1, 3, 7, 8]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      supportPainterStore.clearAll();
      supportPainterStore.setClientAdjacencyMap(mockAdjacencyMap);

      const regionsMap = new Map<string, ROIRegion>();
      regionsMap.set(regionId, region);
      supportPainterStore.restoreRegions(regionsMap);

      // Prune
      supportPainterStore.pruneOrphans(regionId);

      const updated = supportPainterStore.getSnapshot().regions.get(regionId);
      assert.ok(updated);
      // Largest component is {0, 1, 3} (size 3), while {7, 8} (size 2) is pruned
      assert.strictEqual(updated.triangleIds.size, 3);
      assert.ok(updated.triangleIds.has(0));
      assert.ok(updated.triangleIds.has(1));
      assert.ok(updated.triangleIds.has(3));
      assert.ok(!updated.triangleIds.has(7), 'Orphan component face 7 should be pruned');
      assert.ok(!updated.triangleIds.has(8), 'Orphan component face 8 should be pruned');
    });
  });

  describe('Set Boolean Operations & History Transactions', () => {
    it('should correctly perform union set operation on regions and clean up input states', () => {
      const rA: ROIRegion = {
        id: 'roi-a',
        brushType: 'ManualCircle',
        seedTriangleId: 0,
        triangleIds: new Set([0, 1, 2]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      const rB: ROIRegion = {
        id: 'roi-b',
        brushType: 'ManualCircle',
        seedTriangleId: 4,
        triangleIds: new Set([2, 3, 4]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      supportPainterStore.clearAll();
      const regionsMap = new Map<string, ROIRegion>();
      regionsMap.set(rA.id, rA);
      regionsMap.set(rB.id, rB);
      supportPainterStore.restoreRegions(regionsMap);

      // Perform Union (rA U rB)
      supportPainterStore.booleanOperate('union', 'roi-a', 'roi-b');

      const snapshot = supportPainterStore.getSnapshot();
      assert.ok(snapshot.regions.has('roi-a'));
      assert.ok(!snapshot.regions.has('roi-b'), 'Region B should be deleted after union');
      
      const unionRA = snapshot.regions.get('roi-a')!;
      assert.strictEqual(unionRA.triangleIds.size, 5);
      for (const id of [0, 1, 2, 3, 4]) {
        assert.ok(unionRA.triangleIds.has(id));
      }
    });

    it('should correctly perform subtract set operation on regions', () => {
      const rA: ROIRegion = {
        id: 'roi-a',
        brushType: 'ManualCircle',
        seedTriangleId: 0,
        triangleIds: new Set([0, 1, 2]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      const rB: ROIRegion = {
        id: 'roi-b',
        brushType: 'ManualCircle',
        seedTriangleId: 4,
        triangleIds: new Set([2, 3, 4]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      supportPainterStore.clearAll();
      const regionsMap = new Map<string, ROIRegion>();
      regionsMap.set(rA.id, rA);
      regionsMap.set(rB.id, rB);
      supportPainterStore.restoreRegions(regionsMap);

      // Perform Subtract (rA \ rB)
      supportPainterStore.booleanOperate('subtract', 'roi-a', 'roi-b');

      const snapshot = supportPainterStore.getSnapshot();
      assert.ok(snapshot.regions.has('roi-a'));
      assert.ok(snapshot.regions.has('roi-b'));

      const subRA = snapshot.regions.get('roi-a')!;
      assert.strictEqual(subRA.triangleIds.size, 2);
      assert.ok(subRA.triangleIds.has(0));
      assert.ok(subRA.triangleIds.has(1));
      assert.ok(!subRA.triangleIds.has(2), 'Intersection point should be subtracted');
    });

    it('should correctly perform intersect set operation on regions', () => {
      const rA: ROIRegion = {
        id: 'roi-a',
        brushType: 'ManualCircle',
        seedTriangleId: 0,
        triangleIds: new Set([0, 1, 2]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      const rB: ROIRegion = {
        id: 'roi-b',
        brushType: 'ManualCircle',
        seedTriangleId: 4,
        triangleIds: new Set([2, 3, 4]),
        color: '#06B6D4',
        proposedOnly: false,
        createdAt: Date.now(),
      };

      supportPainterStore.clearAll();
      const regionsMap = new Map<string, ROIRegion>();
      regionsMap.set(rA.id, rA);
      regionsMap.set(rB.id, rB);
      supportPainterStore.restoreRegions(regionsMap);

      // Perform Intersect (rA ∩ rB)
      supportPainterStore.booleanOperate('intersect', 'roi-a', 'roi-b');

      const snapshot = supportPainterStore.getSnapshot();
      assert.ok(snapshot.regions.has('roi-a'));
      
      const interRA = snapshot.regions.get('roi-a')!;
      assert.strictEqual(interRA.triangleIds.size, 1);
      assert.ok(interRA.triangleIds.has(2), 'Only the intersection face 2 should remain');
    });
  });
});
