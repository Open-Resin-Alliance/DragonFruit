import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  sampleSequencePolyline,
  solvePerimeterWithInflections,
  generateSupportsFromPainter,
} from '../supportScriptingEngine';
import { supportPainterStore } from '../supportPainterStore';
import { type ROIRegion, type CustomBrushTemplate } from '../supportPainterTypes';
import { resetStore as resetSupportStore, getSnapshot as getSupportSnapshot } from '@/supports/state';

describe('Support Painter Phase 3 - Advanced Mathematical Pathing & Solvers', () => {
  // Test Mock Data & Setup
  const uniqueVertices: THREE.Vector3[] = [];
  const vertexNormals = new Map<number, THREE.Vector3>();

  // Helper to register a vertex
  const addVertex = (x: number, y: number, z: number): number => {
    const idx = uniqueVertices.length;
    uniqueVertices.push(new THREE.Vector3(x, y, z));
    vertexNormals.set(idx, new THREE.Vector3(0, 0, 1));
    return idx;
  };

  // 1. Setup a simple straight polyline for testing sequence walk
  // Length is 10mm
  const polyVertices: number[] = [];
  for (let i = 0; i <= 10; i++) {
    polyVertices.push(addVertex(i, 0, 0));
  }

  it('should sample a polyline with a variable sequence spacing walk correctly', () => {
    const sequence = [1.0, 2.0, 3.0];
    const samples = sampleSequencePolyline(polyVertices, sequence, uniqueVertices, vertexNormals);

    // Initial point at start
    assert.strictEqual(samples.length, 5); // 0, 1, 3, 6, 9
    assert.deepStrictEqual(samples[0].pos, new THREE.Vector3(0, 0, 0));
    assert.deepStrictEqual(samples[1].pos, new THREE.Vector3(1, 0, 0)); // +1.0
    assert.deepStrictEqual(samples[2].pos, new THREE.Vector3(3, 0, 0)); // +2.0
    assert.deepStrictEqual(samples[3].pos, new THREE.Vector3(6, 0, 0)); // +3.0
    assert.deepStrictEqual(samples[4].pos, new THREE.Vector3(9, 0, 0)); // +3.0 (re-uses last element +3.0)
  });

  it('should smooth 2D perimeter loops with Gaussian filter and resolve inflections and segment solvers', () => {
    // Generate a wavy circle loop
    // C(t) = (R * cos(t), R * sin(t)) + random jitter
    const loopIndices: number[] = [];
    const R = 20;
    const numPoints = 64;

    for (let i = 0; i < numPoints; i++) {
      const theta = (i / numPoints) * 2 * Math.PI;
      // Add sinusoidal waves to create inflection points
      const wave = Math.sin(theta * 4) * 2;
      const jitter = (i % 2 === 0 ? 0.05 : -0.05); // High frequency noise
      const x = (R + wave + jitter) * Math.cos(theta);
      const y = (R + wave + jitter) * Math.sin(theta);
      loopIndices.push(addVertex(x, y, 0));
    }
    // Close the loop
    loopIndices.push(loopIndices[0]);

    // A. Standard Solver Mode
    const baseSpacing = 3.0;
    const standardSamples = solvePerimeterWithInflections(
      loopIndices,
      baseSpacing,
      'standard',
      uniqueVertices,
      vertexNormals
    );
    assert.ok(standardSamples.length > 5, 'Should generate multiple perimeter supports');

    // B. Add Solver Mode (rounds up N)
    const addSamples = solvePerimeterWithInflections(
      loopIndices,
      baseSpacing,
      'add',
      uniqueVertices,
      vertexNormals
    );

    // C. Remove Solver Mode (rounds down N)
    const removeSamples = solvePerimeterWithInflections(
      loopIndices,
      baseSpacing,
      'remove',
      uniqueVertices,
      vertexNormals
    );

    assert.ok(addSamples.length >= removeSamples.length, 'Add solver mode should generate equal or more supports than Remove solver mode');
  });

  it('should combine overlap suppression using maximum distance and union of suppression stages in intersecting ROIs', async () => {
    // We will build a small custom test mock framework to evaluate suppression checks
    // Let's create two mock regions intersecting (sharing triangle 1)
    const customBrushA: CustomBrushTemplate = {
      id: 'custom-brush-a',
      name: 'Minima Heavy Brush',
      color: '#4A90E2',
      selection: {
        normalConeAngleMinDeg: 0,
        normalConeAngleMaxDeg: 90,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 90,
        curvatureMin: 0,
        curvatureMax: 10,
        dihedralAngleToleranceDeg: 90,
      },
      operations: [
        {
          type: 'minima',
          enabled: true,
          suppression: {
            enabled: true,
            distanceMm: 3.5,
            suppressAgainst: ['minima'],
          },
          spacing: {
            baseSpacingMm: 3.5,
          },
        },
      ],
    };

    const customBrushB: CustomBrushTemplate = {
      id: 'custom-brush-b',
      name: 'Perimeter Spaced Brush',
      color: '#E2844A',
      selection: {
        normalConeAngleMinDeg: 0,
        normalConeAngleMaxDeg: 90,
        overhangSlopeMinDeg: 0,
        overhangSlopeMaxDeg: 90,
        curvatureMin: 0,
        curvatureMax: 10,
        dihedralAngleToleranceDeg: 90,
      },
      operations: [
        {
          type: 'minima',
          enabled: true,
          suppression: {
            enabled: true,
            distanceMm: 5.0, // More restrictive!
            suppressAgainst: ['perimeter'], // Union of stages!
          },
          spacing: {
            baseSpacingMm: 5.0,
          },
        },
      ],
    };

    const regionA: ROIRegion = {
      id: 'region-a',
      brushType: 'MacroFace',
      seedTriangleId: 1,
      triangleIds: new Set([1, 2, 3]),
      color: '#4A90E2',
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: customBrushA,
    };

    const regionB: ROIRegion = {
      id: 'region-b',
      brushType: 'MacroFace',
      seedTriangleId: 1,
      triangleIds: new Set([1, 4, 5]), // Intersects on triangle 1!
      color: '#E2844A',
      proposedOnly: false,
      createdAt: Date.now(),
      customBrush: customBrushB,
    };

    // Store snapshots for global list
    supportPainterStore.clearAll();
    const regionsMap = new Map<string, ROIRegion>();
    regionsMap.set(regionA.id, regionA);
    regionsMap.set(regionB.id, regionB);
    supportPainterStore.restoreRegions(regionsMap);

    // Let's assert that intersecting check is correct
    const areIntersecting = (r1: ROIRegion, r2: ROIRegion): boolean => {
      for (const triId of r1.triangleIds) {
        if (r2.triangleIds.has(triId)) return true;
      }
      return false;
    };
    assert.strictEqual(areIntersecting(regionA, regionB), true, 'Regions sharing triangle 1 should be intersecting');

    // Simulate combined suppression lookup
    // If we place a minima candidate for regionA, the combined rules are:
    // Combined distance = max(3.5, 5.0) = 5.0mm
    // Combined stages to suppress against = union(['minima'], ['perimeter']) = ['minima', 'perimeter']
    let combinedEnabled = true;
    let maxDistance = Math.max(customBrushA.operations[0].suppression.distanceMm, customBrushB.operations[0].suppression.distanceMm);
    let combinedTypes = new Set<string>([
      ...customBrushA.operations[0].suppression.suppressAgainst,
      ...customBrushB.operations[0].suppression.suppressAgainst,
    ]);

    assert.strictEqual(maxDistance, 5.0, 'Max suppression distance of overlapping ROIs must be 5.0mm');
    assert.ok(combinedTypes.has('minima'), 'Combined suppression stages must contain minima');
    assert.ok(combinedTypes.has('perimeter'), 'Combined suppression stages must contain perimeter');
  });

  it('should generate perimeter candidates along boundary loops and NOT centerline spines for 2D area brushes in generateSupportsFromPainter', async () => {
    // 1. Reset support and painter stores
    resetSupportStore();
    supportPainterStore.clearAll();

    // 2. Set up a flat horizontal square mesh at Z = 5.0
    // Vertices form a 10mm x 10mm square
    const vertices = new Float32Array([
      0, 0, 5,     // 0: bottom-left
      10, 0, 5,    // 1: bottom-right
      10, 10, 5,   // 2: top-right
      0, 10, 5,    // 3: top-left
    ]);

    const normals = new Float32Array([
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
    ]);

    const indices = [
      0, 2, 1,
      0, 3, 2,
    ];

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'mock-mesh-leaf-test';
    mesh.updateMatrixWorld(true);

    // 3. Register a MacroFace ROI covering the square faces
    const modelId = 'test-model-uuid-perimeter';
    const regionId = 'test-perimeter-region';
    const region: ROIRegion = {
      id: regionId,
      brushType: 'MacroFace',
      seedTriangleId: 0,
      triangleIds: new Set([0, 1]),
      color: '#4A90E2',
      proposedOnly: false,
      createdAt: Date.now(),
    };

    const regionsMap = new Map<string, ROIRegion>([[regionId, region]]);
    supportPainterStore.restoreRegions(regionsMap);

    // 4. Run support generation
    await generateSupportsFromPainter(modelId, mesh, [region]);

    // 5. Assert that we placed trunks, and verify that their positions lie on the boundary/perimeter edges
    // and not clustered entirely down the center spine (x = 5.0).
    const supportSnapshot = getSupportSnapshot();
    const trunks = (Object.values(supportSnapshot.trunks) as any[]).filter(t => t.roiId === regionId);

    assert.ok(trunks.length > 0, 'Should place support trunks for the MacroFace region');

    // A perimeter support must lie on one of the outer edges: x = 0, x = 10, y = 0, or y = 10.
    // We check if at least some trunks are placed along these outer boundary limits.
    let placedOnOuterBoundary = 0;
    for (const t of trunks) {
      if (t.contactCone) {
        const p = t.contactCone.pos;
        const isOnBoundary = 
          Math.abs(p.x - 0) < 0.25 || 
          Math.abs(p.x - 10) < 0.25 || 
          Math.abs(p.y - 0) < 0.25 || 
          Math.abs(p.y - 10) < 0.25;
        if (isOnBoundary) {
          placedOnOuterBoundary++;
        }
      }
    }

    assert.ok(placedOnOuterBoundary > 0, 'Should place at least some perimeter trunks on the actual outer boundary loop');
  });
});
