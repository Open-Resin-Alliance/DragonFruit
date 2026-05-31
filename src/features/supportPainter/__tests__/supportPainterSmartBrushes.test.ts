import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap, walkRoughEdge, walkSoftRidge } from '../useClientAdjacencyMap';
import { simplifyLoopEuclidean, applyAlphaShapeToLoops } from '../supportScriptingEngine';

describe('Support Painter - New Smart Brushes Unit Tests', () => {

  describe('RoughEdge Brush Walk', () => {
    it('should propagate along high-entropy edge faces and stop on flat coplanar faces', () => {
      // 1x7 grid representing a tattered boundary edge flanked by smooth flat sides
      // 0: smooth side left (normal: [0,0,-1])
      // 1: smooth side left (normal: [0,0,-1])
      // 2: smooth side left (normal: [0,0,-1])
      // 3: rough edge seed (normal: [0.2,0.4,-0.9].normalize())
      // 4: rough edge (normal: [-0.2,-0.4,-0.9].normalize())
      // 5: smooth side right (normal: [0,0,-1])
      // 6: smooth side right (normal: [0,0,-1])
      const mockEdgeMap: ClientAdjacencyMap = {
        faceCount: 7,
        faceNormals: [
          new THREE.Vector3(0, 0, -1), // 0: smooth
          new THREE.Vector3(0, 0, -1), // 1: smooth
          new THREE.Vector3(0, 0, -1), // 2: smooth
          new THREE.Vector3(0.2, 0.4, -0.9).normalize(), // 3: rough (seed)
          new THREE.Vector3(-0.2, -0.4, -0.9).normalize(), // 4: rough
          new THREE.Vector3(0, 0, -1), // 5: smooth
          new THREE.Vector3(0, 0, -1), // 6: smooth
        ],
        faceCentroids: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(2, 0, 0),
          new THREE.Vector3(3, 0, 0), // 3 (seed)
          new THREE.Vector3(4, 0, 0),
          new THREE.Vector3(5, 0, 0),
          new THREE.Vector3(6, 0, 0),
        ],
        faceZBounds: Array.from({ length: 7 }, () => ({ min: -0.1, max: 0.1 })),
        faceToFaces: [
          [1],       // 0
          [0, 2],    // 1
          [1, 3],    // 2
          [2, 4],    // 3 (seed)
          [3, 5],    // 4
          [4, 6],    // 5
          [5],       // 6
        ],
      };

      const localUp = new THREE.Vector3(0, 0, 1);
      const selected = walkRoughEdge(mockEdgeMap, 3, localUp);
      const resultSet = new Set(selected);

      // Verify seed and rough faces are selected
      assert.ok(resultSet.has(3), 'Seed face 3 should be selected');
      assert.ok(resultSet.has(4), 'Rough face 4 should be selected');

      // Verify smooth side faces further away are rejected due to low entropy boundary check
      assert.ok(!resultSet.has(0), 'Smooth face 0 should be rejected');
      assert.ok(!resultSet.has(1), 'Smooth face 1 should be rejected');
      assert.ok(!resultSet.has(6), 'Smooth face 6 should be rejected');
    });
  });

  describe('SoftRidge Brush Walk', () => {
    it('should successfully walk a gentle crease protrusion using a low dihedral threshold', () => {
      // 1x5 grid representing a soft fold
      // Dihedral angle between adjacent faces is very low (~1 degree)
      // 2: seed crest (angle to neighbors is gentle)
      const mockRidgeMap: ClientAdjacencyMap = {
        faceCount: 5,
        faceNormals: [
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0.01, 0, -1).normalize(), // 1
          new THREE.Vector3(0, 0.02, -1).normalize(), // 2 (seed)
          new THREE.Vector3(-0.01, 0, -1).normalize(), // 3
          new THREE.Vector3(0, 0, -1),
        ],
        faceCentroids: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(2, 0, 0), // 2 (seed)
          new THREE.Vector3(3, 0, 0),
          new THREE.Vector3(4, 0, 0),
        ],
        faceZBounds: Array.from({ length: 5 }, () => ({ min: -0.1, max: 0.1 })),
        faceToFaces: [
          [1],       // 0
          [0, 2],    // 1
          [1, 3],    // 2 (seed)
          [2, 4],    // 3
          [3],       // 4
        ],
      };

      const mockCustomBrush: any = {
        selection: {
          creaseSeedAngleDeg: 1.0,
          creasePropagateAngleDeg: 0.5,
        }
      };

      const localUp = new THREE.Vector3(0, 0, 1);
      const selected = walkSoftRidge(mockRidgeMap, 2, localUp, mockCustomBrush);
      assert.ok(selected.length >= 1, 'Walk should successfully select seed');
    });
  });

  describe('Advanced Walk Constraints & Simplifications (Phase A-E)', () => {
    it('should simplify boundary loops using O(N) Euclidean decimation', () => {
      const uniqueVertices = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.1, 0, 0), // redundant
        new THREE.Vector3(1.0, 0, 0),
        new THREE.Vector3(1.0, 1.0, 0),
        new THREE.Vector3(0, 1.0, 0),
        new THREE.Vector3(0, 0, 0), // loop closed
      ];

      const rawLoop = [0, 1, 2, 3, 4, 5];
      // Tolerance = 0.5 mm. Vertex 1 (distance 0.1 from 0) should be decimated.
      const simplified = simplifyLoopEuclidean(rawLoop, uniqueVertices, 0.5);

      assert.strictEqual(simplified.length, 5); // 0, 2, 3, 4, 5
      assert.ok(simplified.includes(0));
      assert.ok(!simplified.includes(1), 'Vertex 1 should be decimated');
      assert.ok(simplified.includes(2));
      assert.ok(simplified.includes(5));
    });

    it('should bridge nearby disjointed islands using 2D Alpha-Shape solver', () => {
      // Setup disjointed loops representing two nearby islands
      // Island A: 0, 1, 2, 0
      // Island B: 3, 4, 5, 3
      const uniqueVertices = [
        new THREE.Vector3(0, 0, 0),     // 0
        new THREE.Vector3(1.0, 0, 0),   // 1
        new THREE.Vector3(0, 1.0, 0),   // 2
        new THREE.Vector3(1.5, 0, 0),   // 3 (close to 1)
        new THREE.Vector3(2.5, 0, 0),   // 4
        new THREE.Vector3(1.5, 1.0, 0), // 5
      ];

      const loops = [
        { type: 'outer' as const, vertexIds: [0, 1, 2, 0] },
        { type: 'outer' as const, vertexIds: [3, 4, 5, 3] },
      ];

      const vertexNormals = new Map<number, THREE.Vector3>([
        [0, new THREE.Vector3(0, 0, 1)],
        [1, new THREE.Vector3(0, 0, 1)],
        [2, new THREE.Vector3(0, 0, 1)],
        [3, new THREE.Vector3(0, 0, 1)],
        [4, new THREE.Vector3(0, 0, 1)],
        [5, new THREE.Vector3(0, 0, 1)],
      ]);

      // Alpha radius = 1.0 mm (should bridge 1 and 3 since distance is 0.5 <= 2.0)
      const alpha = 1.0;
      const bridged = applyAlphaShapeToLoops(loops, uniqueVertices, vertexNormals, alpha);

      assert.ok(bridged.length > 0);
      assert.strictEqual(bridged.length, 1, 'Should bridge nearby islands into a single cohesive boundary loop');
    });

    it('should reject neighbor if Soft Ridge walk deviates significantly from primary crease axis', () => {
      // 1x5 grid representing a soft fold that has a lateral detour
      // Face 2: seed crease
      // Face 3: aligns perfectly along ridge axis
      // Face 4: lateral detour (deviates significantly from primary ridge axis)
      const mockRidgeMap: ClientAdjacencyMap = {
        faceCount: 5,
        faceNormals: [
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0.01, 0, -1).normalize(), // 1
          new THREE.Vector3(0, 0.02, -1).normalize(), // 2 (seed)
          new THREE.Vector3(-0.01, 0, -1).normalize(), // 3 (aligned crease neighbor)
          new THREE.Vector3(1.0, 1.0, 0.0).normalize(), // 4 (lateral detour)
        ],
        faceCentroids: [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(2, 0, 0), // 2 (seed)
          new THREE.Vector3(3, 0, 0), // 3 (displacement [1,0,0] aligned with crease [1,0,0])
          new THREE.Vector3(2, 1, 0), // 4 (displacement [0,1,0] perpendicular to crease [1,0,0])
        ],
        faceZBounds: Array.from({ length: 5 }, () => ({ min: -0.1, max: 0.1 })),
        faceToFaces: [
          [1],       // 0
          [0, 2],    // 1
          [1, 3, 4], // 2 (seed connected to 1, 3, and 4)
          [2],       // 3
          [2],       // 4
        ],
      };

      const mockCustomBrush: any = {
        selection: {
          creaseSeedAngleDeg: 1.0,
          creasePropagateAngleDeg: 0.5,
          ridgeAlignmentTolerance: 0.3,
        }
      };

      const localUp = new THREE.Vector3(0, 0, 1);
      const selected = walkSoftRidge(mockRidgeMap, 2, localUp, mockCustomBrush);
      
      // Face 4 deviates significantly (displacement [0,1,0] is perpendicular to crease axis [1,0,0], dot product = 0)
      // So face 4 must be rejected, and only face 3 should be traversed!
      assert.ok(selected.includes(2), 'Should contain seed 2');
      assert.ok(selected.includes(3), 'Should contain aligned neighbor 3');
      assert.ok(!selected.includes(4), 'Should reject lateral detour neighbor 4 due to crease vector clamp constraint');
    });

    it('should terminate propagation in Rough Edge walk if high-entropy neighbors count exceeds 3', () => {
      // Seed 0 (high-roughness) has 4 neighbors: 1, 2, 3, 4, which are all rough (variance > 0.06).
      // Since neighbor count is 4 (> 3), seed 0 behaves as a junction and walk should terminate immediately.
      const mockJunctionMap: ClientAdjacencyMap = {
        faceCount: 5,
        faceNormals: [
          new THREE.Vector3(0.2, 0.4, -0.9).normalize(), // 0 (seed)
          new THREE.Vector3(-0.2, -0.4, -0.9).normalize(), // 1
          new THREE.Vector3(0.2, -0.4, -0.9).normalize(), // 2
          new THREE.Vector3(-0.2, 0.4, -0.9).normalize(), // 3
          new THREE.Vector3(0.2, 0.4, 0.9).normalize(), // 4
        ],
        faceCentroids: [
          new THREE.Vector3(0, 0, 0), // 0 (seed)
          new THREE.Vector3(1, 0, 0), // 1
          new THREE.Vector3(0, 1, 0), // 2
          new THREE.Vector3(-1, 0, 0), // 3
          new THREE.Vector3(0, -1, 0), // 4
        ],
        faceZBounds: Array.from({ length: 5 }, () => ({ min: -0.1, max: 0.1 })),
        faceToFaces: [
          [1, 2, 3, 4], // 0 (seed connected to 4 rough neighbors)
          [0],
          [0],
          [0],
          [0],
        ],
      };

      const mockCustomBrush: any = {
        selection: {
          roughnessThreshold: 0.06,
        }
      };

      const localUp = new THREE.Vector3(0, 0, 1);
      const selected = walkRoughEdge(mockJunctionMap, 0, localUp, mockCustomBrush);

      // Seed 0 is rough (variance > 0.06), neighbors are rough (> 0.045).
      // However, seed 0 has 4 rough neighbors, which triggers the branch-valence check (> 3).
      // Propagation should terminate immediately, selecting only the seed face!
      assert.strictEqual(selected.length, 1, 'Should terminate propagation at junction and select only the seed face');
      assert.strictEqual(selected[0], 0);
    });
  });
});
