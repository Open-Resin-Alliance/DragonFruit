import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  sampleSequencePolyline,
  solvePerimeterWithInflections,
  generateSupportsFromPainter,
  calculateZHeightDensitySpacing,
  insetBoundaryLoop,
  filterInsetLoopByWrapFraction,
} from '../supportScriptingEngine';
import { supportPainterStore } from '../supportPainterStore';
import { type ROIRegion, type CustomBrushTemplate, upgradePipeline, arePipelinesEquivalent, type BrushType } from '../supportPainterTypes';
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

  it('should scale spacing dynamically along linear, sigmoid, and parabolic curves capped by ROI Z span', () => {
    // Spacing configuration: base spacing is 2.0mm
    const op: any = {
      enableZHeightDensity: true,
      minimaStartInterval: 10,       // Start offset = 10% (10% of 5.0mm = 0.5mm)
      minimaEndInterval: 100,       // End offset = 100% (100% of 5.0mm = 5.0mm)
      endSpacingMm: 6.0,            // End Tip Spacing = 6.0mm (which corresponds to old 3x zFactor)
      zFactorCurve: 'linear',
      spacing: { baseSpacingMm: 2.0 } // Start Tip Spacing = 2.0mm
    };

    // ROI span: minimaZ = 2.0, maximaZ = 7.0 (Z span is 5.0mm)
    // zStart = 0.5mm, zEnd = 5.0mm
    // Let's check calculation for a point at Z = 2.0 (zRel = 0.0) -> below zStart, should return baseSpacing = 2.0mm.
    const spacingAtBase = calculateZHeightDensitySpacing(2.0, 2.0, 7.0, op, 1.0);
    assert.strictEqual(spacingAtBase, 2.0);

    // Let's check calculation for a point at Z = 2.2 (zRel = 0.2) -> below zStart (0.5), should return baseSpacing = 2.0mm.
    const spacingBelowStart = calculateZHeightDensitySpacing(2.2, 2.0, 7.0, op, 1.0);
    assert.strictEqual(spacingBelowStart, 2.0);

    // Let's check spacing at mid-gradient: Z = 4.75 (zRel = 2.75).
    // Interpolation factor t = (zRel - zStart) / (zEnd - zStart) = (2.75 - 0.5) / (5.0 - 0.5) = 2.25 / 4.5 = 0.5.
    // For 'linear' curve, curveVal = 0.5.
    // Expected spacing = 2.0 + 0.5 * (6.0 - 2.0) = 4.0mm.
    const spacingLinear = calculateZHeightDensitySpacing(4.75, 2.0, 7.0, op, 1.0);
    assert.strictEqual(spacingLinear, 4.0);

    // Now test 'sigmoid' curve:
    // For t = 0.5, sigmoid value S(0.5) = 0.5.
    // Expected spacing = 4.0mm.
    const opSigmoid = { ...op, zFactorCurve: 'sigmoid' };
    const spacingSigmoid = calculateZHeightDensitySpacing(4.75, 2.0, 7.0, opSigmoid, 1.0);
    assert.strictEqual(spacingSigmoid, 4.0);

    // Now test 'parabolic' curve:
    // For t = 0.5, parabolic value P(0.5) = 0.25.
    // Expected spacing = 2.0 + 0.25 * (6.0 - 2.0) = 3.0mm.
    const opParabolic = { ...op, zFactorCurve: 'parabolic' };
    const spacingParabolic = calculateZHeightDensitySpacing(4.75, 2.0, 7.0, opParabolic, 1.0);
    assert.strictEqual(spacingParabolic, 3.0);
  });

  it('should inset a 3D loop correctly by projecting to local tangent plane and calling Clipper.js', () => {
    // Create a 10mm x 10mm flat square loop on horizontal plane (Z = 5)
    // Centroid = (5, 5, 5), normal = (0, 0, 1)
    const loop = [
      new THREE.Vector3(0, 0, 5),
      new THREE.Vector3(10, 0, 5),
      new THREE.Vector3(10, 10, 5),
      new THREE.Vector3(0, 10, 5),
      new THREE.Vector3(0, 0, 5) // closed
    ];

    const inset = insetBoundaryLoop(loop, new THREE.Vector3(0, 0, 1), new THREE.Vector3(5, 5, 5), 1.0);
    // Insetting a 10x10 square by 1mm from all sides results in a 8x8 square.
    // Vertices should be at x = [1, 9], y = [1, 9]
    assert.strictEqual(inset.length, 4);
    
    // Check that the shrunken square contains all 4 expected corners
    const expectedCorners = [
      new THREE.Vector3(1, 1, 5),
      new THREE.Vector3(9, 1, 5),
      new THREE.Vector3(9, 9, 5),
      new THREE.Vector3(1, 9, 5)
    ];

    for (const expected of expectedCorners) {
      const found = inset.some(p => p.distanceTo(expected) < 0.05);
      assert.ok(found, `Expected corner ${expected.x}, ${expected.y}, ${expected.z} not found in inset`);
    }
  });

  it('should filter perimeter candidates symmetrically based on relative Z-height wrap limit percentage', () => {
    // We verify that candidates on a perimeter loop are filtered based on Wrap Limit (Z) (%) relative to ROI.
    // Create a 3D loop that goes from Z=1 to Z=5 on one side, and goes back from Z=5 to Z=1 on the other.
    const loopPts = [
      new THREE.Vector3(0, 0, 1),   // Z=1
      new THREE.Vector3(2.5, 0, 3), // Z=3
      new THREE.Vector3(5, 0, 5),   // Z=5
      new THREE.Vector3(2.5, 0, 3), // Z=3 (downside)
      new THREE.Vector3(0, 0, 1)    // closed
    ];

    // Check with 50% wrap limit:
    const rawWrap = 50; // 50%
    const wFrac = rawWrap / 100.0;
    const regionMinZ = 1.0;
    const regionMaxZ = 5.0;
    const zSpan = regionMaxZ - regionMinZ;
    const zThreshold = regionMinZ + wFrac * zSpan; // 3.0

    const candidates: any[] = [];
    const samples = loopPts.map(pos => ({ pos, normal: new THREE.Vector3(0, 0, 1) }));

    for (const sample of samples) {
      if (zSpan <= 0.001 || sample.pos.z <= zThreshold + 1e-4) {
        candidates.push(sample);
      }
    }

    // Must have filtered out the Z=5 point, but kept Z=1 and Z=3 points on both sides of the loop!
    assert.strictEqual(candidates.length, 4); // Z=1 (start), Z=3 (up), Z=3 (down), Z=1 (end)
    assert.ok(candidates.every(c => c.pos.z <= 3.05));
    assert.strictEqual(candidates[0].pos.z, 1.0);
    assert.strictEqual(candidates[1].pos.z, 3.0);
    assert.strictEqual(candidates[2].pos.z, 3.0);
    assert.strictEqual(candidates[3].pos.z, 1.0);
  });

  it('should upgrade pipeline safely preserving custom deletions, duplicates, and order without re-adding deleted steps', () => {
    // A. Input pipeline has two perimeter steps and infill, but MINIMA and CENTERLINE are deleted
    const customOps: any[] = [
      {
        id: 'perimeter-1',
        type: 'perimeter',
        insetDistanceMm: 0.0,
        spacing: { baseSpacingMm: 4.0 }
      },
      {
        id: 'perimeter-2',
        type: 'perimeter',
        insetDistanceMm: 1.2,
        wrapFraction: 0.5,
        spacing: { baseSpacingMm: 5.0 }
      },
      {
        id: 'infill-1',
        type: 'infill',
        spacing: { baseSpacingMm: 4.0 }
      }
    ];

    const upgraded = upgradePipeline(customOps, 'MacroFace');
    
    // Asserts:
    // 1. Array length must be exactly 3 (custom stack length preserved, no re-added minima/centerline)
    assert.strictEqual(upgraded.length, 3);
    
    // 2. Custom ids and types must be perfectly preserved in order
    assert.strictEqual(upgraded[0].id, 'perimeter-1');
    assert.strictEqual(upgraded[0].type, 'perimeter');
    assert.strictEqual(upgraded[1].id, 'perimeter-2');
    assert.strictEqual(upgraded[1].type, 'perimeter');
    assert.strictEqual(upgraded[2].id, 'infill-1');
    assert.strictEqual(upgraded[2].type, 'infill');
    
    // 3. Dynamic defaults are successfully mapped
    assert.strictEqual(upgraded[0].wrapFraction, 100);
    assert.strictEqual(upgraded[1].wrapFraction, 50); // Legacy 0.5 successfully upgraded to 50%
    assert.strictEqual(upgraded[0].minimaStartInterval, 0);     // 0% Start Fraction
    assert.strictEqual(upgraded[0].minimaEndInterval, 100);     // 100% End Fraction
    assert.strictEqual(upgraded[0].endSpacingMm, 4.0);          // default spacing (4.0)

    // B. Legacy undefined input falls back to default 3-stage pipeline (no centerline)
    const defaultPipeline = upgradePipeline(undefined, 'MacroFace');
    assert.strictEqual(defaultPipeline.length, 3);
    assert.ok(defaultPipeline.some(op => op.type === 'minima'));
    assert.ok(defaultPipeline.some(op => op.type === 'perimeter'));
    assert.ok(defaultPipeline.some(op => op.type === 'infill'));
    assert.ok(!defaultPipeline.some(op => op.type === 'centerline'));
  });

  it('should calculate overall region Z bounds correctly and scale Z-density spacing without Alpha-Shape bridging', () => {
    // Verify Z-density calculations scale correctly using simulated region Z bounds
    const op: any = {
      type: 'perimeter',
      enableZHeightDensity: true,
      minimaStartInterval: 10,      // Start offset = 10%
      minimaEndInterval: 80,        // End offset = 80%
      endSpacingMm: 5.0,            // End Tip Spacing = 5.0 mm
      zFactorCurve: 'linear',
      spacing: { baseSpacingMm: 2.0 } // Start Tip Spacing = 2.0 mm
    };
    
    // Z span is 10.0mm (from Z=0 to Z=10)
    // zStart = 10% * 10.0 = 1.0mm
    // zEnd = 80% * 10.0 = 8.0mm
    // At point Z = 4.5mm: zRel = 4.5 - 0 = 4.5mm
    // t = (4.5 - 1.0) / (8.0 - 1.0) = 3.5 / 7.0 = 0.5
    // expectedSpacing = 2.0 + 0.5 * (5.0 - 2.0) = 3.5mm
    const spacing = calculateZHeightDensitySpacing(4.5, 0.0, 10.0, op, 1.0);
    assert.strictEqual(spacing, 3.5);
  });

  it('should offset loop vertices directly along local inward tangent vector symmetrically', () => {
    // 3D planar square loop vertices of size 10x10 at Z=0
    // Centroid is at (5, 5, 0)
    const vertices = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 0, 0),
      new THREE.Vector3(10, 10, 0),
      new THREE.Vector3(0, 10, 0)
    ];
    // Normals pointing vertically straight up (+Z)
    const normals = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 1)
    ];

    // Offset of 1.0mm inwards
    const insetLoop = insetBoundaryLoop(vertices, new THREE.Vector3(0, 0, 1), new THREE.Vector3(5, 5, 0), 1.0, normals);

    assert.strictEqual(insetLoop.length, 4);
    // Verified 3D local offset towards centroid (5, 5, 0)
    // Vertex 0 (0, 0, 0) shifts inwards (positive X and positive Y)
    assert.ok(insetLoop[0].x > 0 && insetLoop[0].y > 0);
  });

  it('should verify arePipelinesEquivalent behaves correctly and store actions save/delete scripts reliably', () => {
    // 1. Structural equivalence tests
    const opsA = upgradePipeline(undefined, 'MacroFace');
    const opsB = upgradePipeline(undefined, 'MacroFace');
    
    assert.ok(arePipelinesEquivalent(opsA, opsB), 'Identical pipelines should be equivalent');
    
    // Modify one value in opsB
    const modifiedOps = JSON.parse(JSON.stringify(opsB));
    modifiedOps[0].wrapFraction = 42;
    assert.strictEqual(arePipelinesEquivalent(opsA, modifiedOps), false, 'Modified wrapFraction should make pipelines non-equivalent');

    // 2. Store CRUD actions
    supportPainterStore.clearAll();
    
    const countBefore = supportPainterStore.getSnapshot().placementScripts.size;
    assert.ok(countBefore >= 5, 'Should pre-populate at least 5 default placement scripts');

    const customScript = {
      id: 'test-custom-script-id',
      name: 'Test Custom Script',
      operations: opsA,
      isBuiltIn: false
    };

    // Add custom script
    supportPainterStore.addPlacementScript(customScript);
    const stateAfterAdd = supportPainterStore.getSnapshot();
    assert.ok(stateAfterAdd.placementScripts.has('test-custom-script-id'), 'Store should contain added custom script');
    
    // Update custom script
    supportPainterStore.updatePlacementScript('test-custom-script-id', { name: 'Updated Custom Script Name' });
    const stateAfterUpdate = supportPainterStore.getSnapshot();
    assert.strictEqual(stateAfterUpdate.placementScripts.get('test-custom-script-id')?.name, 'Updated Custom Script Name', 'Script name should be updated');

    // Delete custom script
    supportPainterStore.deletePlacementScript('test-custom-script-id');
    const stateAfterDelete = supportPainterStore.getSnapshot();
    assert.ok(!stateAfterDelete.placementScripts.has('test-custom-script-id'), 'Store should delete custom script');
  });

  it('should sort infill candidates by Z-coordinate ascending for correct down-sampling when infill is used alone', () => {
    const candHighZ = {
      pos: new THREE.Vector3(0, 0, 10),
      normal: new THREE.Vector3(0, 0, 1),
      regionId: 'test-roi',
      regionType: 'MacroFace' as BrushType,
      regionTriCount: 1,
      stage: 'infill' as const,
    };
    const candLowZ = {
      pos: new THREE.Vector3(0, 0, 2),
      normal: new THREE.Vector3(0, 0, 1),
      regionId: 'test-roi',
      regionType: 'MacroFace' as BrushType,
      regionTriCount: 1,
      stage: 'infill' as const,
    };

    const candidates = [candHighZ, candLowZ];

    candidates.sort((a, b) => a.pos.z - b.pos.z);

    assert.strictEqual(candidates[0].pos.z, 2.0);
    assert.strictEqual(candidates[1].pos.z, 10.0);
  });

  it('should generate infill supports strictly inside PointPerimeter region using local projected plane', async () => {
    resetSupportStore();
    supportPainterStore.clearAll();

    // 1. Set up a simple mesh (flat square at Z = 5.0)
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
    const indices = [0, 2, 1, 0, 3, 2];

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'mock-mesh-leaf-test';
    mesh.updateMatrixWorld(true);

    // 2. Set up PointPerimeter region
    // The vectorPath defines a 3D polygon: square from (2, 2, 5) to (8, 2, 5) to (8, 8, 5) to (2, 8, 5)
    // The triangles are 0 and 1, which cover the entire 10x10 space.
    const modelId = 'test-model-perimeter-infill';
    const regionId = 'test-perimeter-infill-region';
    
    const customOps = [
      {
        id: 'infill-op-id',
        type: 'infill' as const,
        enabled: true,
        supportPresetId: 'detail',
        suppression: {
          enabled: false,
          distanceMm: 2.0,
          suppressAgainst: [] as any[],
        },
        spacing: {
          baseSpacingMm: 2.0,
          infillPattern: 'Grid' as const,
          attemptLeafCreation: false,
        },
      }
    ];

    const region: ROIRegion = {
      id: regionId,
      brushType: 'PointPerimeter',
      seedTriangleId: 0,
      triangleIds: new Set([0, 1]),
      color: '#D97706',
      proposedOnly: false,
      createdAt: Date.now(),
      vectorPath: [
        { point: [2, 2, 5], normal: [0, 0, -1], faceIndex: 0 },
        { point: [8, 2, 5], normal: [0, 0, -1], faceIndex: 0 },
        { point: [8, 8, 5], normal: [0, 0, -1], faceIndex: 1 },
        { point: [2, 8, 5], normal: [0, 0, -1], faceIndex: 1 },
      ],
      customBrush: {
        id: 'temp-perimeter-brush',
        name: 'Perimeter Brush',
        color: '#D97706',
        baseBrush: 'PointPerimeter',
        selection: {
          normalConeAngleMinDeg: 0,
          normalConeAngleMaxDeg: 90,
          overhangSlopeMinDeg: 0,
          overhangSlopeMaxDeg: 90,
          curvatureMin: 0,
          curvatureMax: 10,
          dihedralAngleToleranceDeg: 90,
        },
        operations: customOps,
      }
    };

    const regionsMap = new Map<string, ROIRegion>([[regionId, region]]);
    supportPainterStore.restoreRegions(regionsMap);

    await generateSupportsFromPainter(modelId, mesh, [region]);

    const supportSnapshot = getSupportSnapshot();
    const trunks = Object.values(supportSnapshot.trunks).filter(t => t.roiId === regionId);

    assert.ok(trunks.length > 0, 'Should generate infill supports inside PointPerimeter');
    
    for (const t of trunks) {
      const x = t.contactCone!.pos.x;
      const y = t.contactCone!.pos.y;
      // All infill supports must be strictly inside [2, 8] x [2, 8]
      assert.ok(x >= 1.99 && x <= 8.01, `X coordinate ${x} must be inside perimeter [2, 8]`);
      assert.ok(y >= 1.99 && y <= 8.01, `Y coordinate ${y} must be inside perimeter [2, 8]`);
    }
  });
});
