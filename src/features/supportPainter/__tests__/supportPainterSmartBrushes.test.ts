import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap, walkRoughEdge, walkSoftRidge } from '../useClientAdjacencyMap';

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
});
