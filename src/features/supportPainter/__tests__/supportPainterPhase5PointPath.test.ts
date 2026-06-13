import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { type ClientAdjacencyMap, findDijkstraFacePath, walkPointPathLine, walkPointPathPolygon } from '../useClientAdjacencyMap';

describe('Support Painter Phase 5 PointPath - Dijkstra Pathfinding & Watertight Polygon Flood Fills', () => {

  // Setup mock 3x3 grid ClientAdjacencyMap (centroids are 1.0mm apart)
  const mockGridMap: ClientAdjacencyMap = {
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

  const localUp = new THREE.Vector3(0, 0, -1);
  const worldScale = 1.0;

  it('findDijkstraFacePath should correctly find the shortest chain of face indices connecting two faces', () => {
    // Path from 0 to 2 should go 0 -> 1 -> 2
    const path0to2 = findDijkstraFacePath(mockGridMap, 0, 2, worldScale);
    assert.deepStrictEqual(path0to2, [0, 1, 2], 'Shortest path from 0 to 2 should be 0 -> 1 -> 2');

    // Path from 0 to 8 should go 0 -> 1 -> 4 -> 5 -> 8 or 0 -> 3 -> 4 -> 7 -> 8
    const path0to8 = findDijkstraFacePath(mockGridMap, 0, 8, worldScale);
    assert.strictEqual(path0to8[0], 0);
    assert.strictEqual(path0to8[path0to8.length - 1], 8);
    assert.ok(path0to8.length > 2, 'Path should be a multi-face chain');
  });

  it('walkPointPathLine should construct a skeleton path and expand it up to the geodesic bar width', () => {
    // Points 0 and 2. Skeleton: [0, 1, 2].
    // Geodesic width: 1.0mm (Radius = 0.5mm)
    // Neighbors at distance 1.0mm:
    // - From 0: 3 (dist 1.0)
    // - From 1: 4 (dist 1.0)
    // - From 2: 5 (dist 1.0)
    // So all of [0, 1, 2, 3, 4, 5] should be within radius.
    // Neighbors [6, 7, 8] are at distance 2.0mm and should NOT be select.
    const pathLineTriangles = walkPointPathLine(mockGridMap, [0, 2], 2.0, localUp, worldScale);
    const resultSet = new Set(pathLineTriangles);

    assert.ok(resultSet.has(0));
    assert.ok(resultSet.has(1));
    assert.ok(resultSet.has(2));
    assert.ok(resultSet.has(3));
    assert.ok(resultSet.has(4));
    assert.ok(resultSet.has(5));

    assert.ok(!resultSet.has(6));
    assert.ok(!resultSet.has(7));
    assert.ok(!resultSet.has(8));
  });

  it('walkPointPathPolygon should isolate a closed boundary loop, locate the interior center seed, and flood fill the region watertightly', () => {
    // A square loop along the outer corners of the 3x3 grid: 0 -> 2 -> 8 -> 6
    // Boundary: 0->1->2->5->8->7->6->3->0
    // Center face 4 is completely enclosed inside!
    // The flood fill should start at face 4 and fill the entire 3x3 grid (9 faces).
    const polygonTriangles = walkPointPathPolygon(mockGridMap, [0, 2, 8, 6], localUp, worldScale);
    
    assert.strictEqual(polygonTriangles.length, 9, 'A closed boundary square loop on a 3x3 grid should flood-fill all 9 faces');
    const resultSet = new Set(polygonTriangles);
    for (let f = 0; f < 9; f++) {
      assert.ok(resultSet.has(f), `Face ${f} should be selected in the flood fill`);
    }
  });

  it('walkPointPathPolygon should be geometrically watertight and not leak on complex polygons', () => {
    // 5x5 grid (25 faces)
    // Centroids are at (x, y, 0) for x, y in [0, 4]
    const faceCentroids: THREE.Vector3[] = [];
    const faceToFaces: number[][] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        faceCentroids.push(new THREE.Vector3(x, y, 0));
        
        const adj: number[] = [];
        const idx = y * 5 + x;
        if (x > 0) adj.push(idx - 1);
        if (x < 4) adj.push(idx + 1);
        if (y > 0) adj.push(idx - 5);
        if (y < 4) adj.push(idx + 5);
        faceToFaces.push(adj);
      }
    }

    const mock5x5Map: ClientAdjacencyMap = {
      faceCount: 25,
      faceNormals: Array.from({ length: 25 }, () => new THREE.Vector3(0, 0, -1)),
      faceCentroids,
      faceZBounds: Array.from({ length: 25 }, () => ({ min: -0.1, max: 0.1 })),
      faceToFaces,
      // positions for 25 faces (each triangle has 3 vertices = 9 numbers)
      // we represent them as simple flat triangles around centroids
      positions: new Float32Array(
        faceCentroids.flatMap(c => [
          c.x - 0.4, c.y - 0.4, 0,
          c.x + 0.4, c.y - 0.4, 0,
          c.x, c.y + 0.4, 0
        ])
      )
    };

    // Define control points of polygon: 6 -> 8 -> 18 -> 16
    // In local 2D space, this forms a square from (1, 1) to (3, 1) to (3, 3) to (1, 3)
    // The interior faces are: 12 (centroid at 2, 2)
    // The diagonal faces: 7 (2, 1), 13 (3, 2), 17 (2, 3), 11 (1, 2)
    // Boundary faces: 6, 8, 18, 16
    // Outside faces: 2 (2, 0), etc.
    const result = walkPointPathPolygon(mock5x5Map, [6, 8, 18, 16], new THREE.Vector3(0, 0, -1), 1.0);
    const resultSet = new Set(result);

    // Interior and boundary faces should be included
    assert.ok(resultSet.has(12), 'Interior face 12 should be included');
    assert.ok(resultSet.has(7), 'Interior face 7 should be included');
    assert.ok(resultSet.has(13), 'Interior face 13 should be included');
    assert.ok(resultSet.has(17), 'Interior face 17 should be included');
    assert.ok(resultSet.has(11), 'Interior face 11 should be included');

    // Outside faces should NOT be included
    assert.ok(!resultSet.has(2), 'Outside face 2 should NOT be included');
    assert.ok(!resultSet.has(14), 'Outside face 14 should NOT be included');
    assert.ok(!resultSet.has(22), 'Outside face 22 should NOT be included');
    assert.ok(!resultSet.has(10), 'Outside face 10 should NOT be included');
  });

  it('walkPointPathPolygon should be watertight against topological leaks (wormholes) using geometric filtering', () => {
    // 5x5 grid (25 faces)
    const faceCentroids: THREE.Vector3[] = [];
    const faceToFaces: number[][] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        faceCentroids.push(new THREE.Vector3(x, y, 0));
        
        const adj: number[] = [];
        const idx = y * 5 + x;
        if (x > 0) adj.push(idx - 1);
        if (x < 4) adj.push(idx + 1);
        if (y > 0) adj.push(idx - 5);
        if (y < 4) adj.push(idx + 5);
        faceToFaces.push(adj);
      }
    }

    // Deliberately introduce a topological "wormhole" between interior face 12 and outside face 2.
    // This simulates a non-manifold or faulty mesh connection that would leak in topological-only fills.
    faceToFaces[12].push(2);
    faceToFaces[2].push(12);

    const mockLeakyMap: ClientAdjacencyMap = {
      faceCount: 25,
      faceNormals: Array.from({ length: 25 }, () => new THREE.Vector3(0, 0, -1)),
      faceCentroids,
      faceZBounds: Array.from({ length: 25 }, () => ({ min: -0.1, max: 0.1 })),
      faceToFaces,
      positions: new Float32Array(
        faceCentroids.flatMap(c => [
          c.x - 0.4, c.y - 0.4, 0,
          c.x + 0.4, c.y - 0.4, 0,
          c.x, c.y + 0.4, 0
        ])
      )
    };

    // Square perimeter: 6 -> 8 -> 18 -> 16
    const result = walkPointPathPolygon(mockLeakyMap, [6, 8, 18, 16], new THREE.Vector3(0, 0, -1), 1.0);
    const resultSet = new Set(result);

    // Interior face must be included
    assert.ok(resultSet.has(12), 'Interior face 12 should be included');

    // Outside face 2 (connected via topological wormhole) must NOT be included because it is geometrically outside
    assert.ok(!resultSet.has(2), 'Outside face 2 should NOT be included despite topological connection');
    // Adjacent outside faces must also not be included
    assert.ok(!resultSet.has(1), 'Outside face 1 should NOT be included');
    assert.ok(!resultSet.has(3), 'Outside face 3 should NOT be included');
  });
});

