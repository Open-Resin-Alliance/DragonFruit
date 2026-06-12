import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { walkSharpCorner, type ClientAdjacencyMap } from '../useClientAdjacencyMap';
import { serializeROIsForVoxl, deserializeROIsFromVoxl, isVoxlROIExtension } from '../voxlCodec';
import { type ROIRegion } from '../supportPainterTypes';

describe('Support Painter Option 1B - Direct Coordinate Binding, Crease Walks & Serialization', () => {

  // 1. Test VOXL Serialization & Deserialization
  it('should serialize and deserialize vectorPath coordinates correctly via VOXL extension payload', () => {
    const mockRegion: ROIRegion = {
      id: 'test-roi-uuid',
      brushType: 'PointPath',
      seedTriangleId: 42,
      triangleIds: new Set(),
      color: '#10B981',
      proposedOnly: false,
      createdAt: Date.now(),
      modelId: 'test-model-uuid',
      vectorPath: [
        { point: [1.2, 3.4, 5.6], normal: [0, 0, 1], faceIndex: 10 },
        { point: [7.8, 9.0, 12.3], normal: [1, 0, 0], faceIndex: 11 }
      ]
    };

    const regionsByModel = new Map<string, Map<string, ROIRegion>>();
    const modelRegions = new Map<string, ROIRegion>();
    modelRegions.set(mockRegion.id, mockRegion);
    regionsByModel.set('test-model-uuid', modelRegions);

    // Serialize
    const ext = serializeROIsForVoxl(regionsByModel, 'test-model-uuid');
    assert.ok(isVoxlROIExtension(ext));
    assert.strictEqual(ext.version, 4);

    const serializedRegion = ext.regions[0];
    assert.ok(serializedRegion.vectorPath);
    assert.strictEqual(serializedRegion.vectorPath.length, 2);
    assert.deepStrictEqual(serializedRegion.vectorPath[0].point, [1.2, 3.4, 5.6]);

    // Deserialize
    const deserializedMap = deserializeROIsFromVoxl(ext);
    const deserializedModelRegions = deserializedMap.get('test-model-uuid');
    assert.ok(deserializedModelRegions);
    const deserializedRegion = deserializedModelRegions.get(mockRegion.id);
    assert.ok(deserializedRegion);
    assert.ok(deserializedRegion.vectorPath);
    assert.strictEqual(deserializedRegion.vectorPath.length, 2);
    assert.deepStrictEqual(deserializedRegion.vectorPath[0].point, [1.2, 3.4, 5.6]);
    assert.deepStrictEqual(deserializedRegion.vectorPath[1].normal, [1, 0, 0]);
  });

  // 2. Test walkSharpCorner Walk Crease Edge Propagation
  it('should propagate along a 90 degree crease edge and stop at corners/boundaries', () => {
    // Construct a simple geometry: two quad faces meeting at 90 degrees along the X-axis
    // Crease line is along y = 0, z = 0 from x = -1 to x = 1.
    // Quad 1: y in [0, 1], z = 0 (horizontal) -> normals = [0, 0, 1]
    // Quad 2: y = 0, z in [0, 1] (vertical) -> normals = [0, -1, 0]
    // We represent them as 4 triangles.
    // Vertices:
    // 0: [-1,  0, 0] (crease start)
    // 1: [ 1,  0, 0] (crease end)
    // 2: [-1,  1, 0] (horizontal outer)
    // 3: [ 1,  1, 0] (horizontal outer)
    // 4: [-1,  0, 1] (vertical outer)
    // 5: [ 1,  0, 1] (vertical outer)
    const positions = new Float32Array([
      // Tri 0 (Quad 1): 0, 1, 3
      -1, 0, 0,
       1, 0, 0,
       1, 1, 0,
      // Tri 1 (Quad 1): 0, 3, 2
      -1, 0, 0,
       1, 1, 0,
      -1, 1, 0,
      // Tri 2 (Quad 2): 0, 4, 5
      -1, 0, 0,
      -1, 0, 1,
       1, 0, 1,
      // Tri 3 (Quad 2): 0, 5, 1
      -1, 0, 0,
       1, 0, 1,
       1, 0, 0,
    ]);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Construct adjacency map
    const mockMap: ClientAdjacencyMap = {
      faceCount: 4,
      faceNormals: [
        new THREE.Vector3(0, 0, 1), // Tri 0
        new THREE.Vector3(0, 0, 1), // Tri 1
        new THREE.Vector3(0, -1, 0), // Tri 2
        new THREE.Vector3(0, -1, 0), // Tri 3
      ],
      faceCentroids: [
        new THREE.Vector3(1/3, 1/3, 0),
        new THREE.Vector3(-1/3, 2/3, 0),
        new THREE.Vector3(-1/3, 0, 1/3),
        new THREE.Vector3(1/3, 0, 2/3)
      ],
      faceZBounds: [
        { min: 0, max: 0 },
        { min: 0, max: 0 },
        { min: 0, max: 1 },
        { min: 0, max: 1 },
      ],
      faceToFaces: [
        [1, 3], // Tri 0 neighbors Tri 1 (horizontal) and Tri 3 (crease neighbor)
        [0, 2], // Tri 1 neighbors Tri 0 (horizontal) and Tri 2 (crease neighbor)
        [3, 1], // Tri 2 neighbors Tri 3 (vertical) and Tri 1 (crease neighbor)
        [2, 0], // Tri 3 neighbors Tri 2 (vertical) and Tri 0 (crease neighbor)
      ]
    };

    const matrixWorld = new THREE.Matrix4(); // identity
    const seedPoint = new THREE.Vector3(0, 0, 0); // on the crease
    const dihedralThresholdDeg = 35; // 90 deg crease is > 35

    const path = walkSharpCorner(
      mockMap,
      geom,
      0, // seedFaceIndex
      seedPoint,
      matrixWorld,
      dihedralThresholdDeg,
      true // wrapCurves
    );

    assert.ok(path.length >= 2, 'Should find crease path vertices');
    
    // The points in the path should correspond to the welded crease vertices [-1, 0, 0] and [1, 0, 0]
    const hasStart = path.some(pt => Math.abs(pt.point[0] - (-1)) < 1e-4);
    const hasEnd = path.some(pt => Math.abs(pt.point[0] - 1) < 1e-4);
    assert.ok(hasStart, 'Crease path should include start vertex x=-1');
    assert.ok(hasEnd, 'Crease path should include end vertex x=1');
  });
});
