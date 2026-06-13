import { test } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { buildClientAdjacencyMap, proposeRegionOnClient } from '../useClientAdjacencyMap';

function generate300kTriangleMesh(): THREE.BufferGeometry {
  const width = 300;
  const height = 500;
  // A grid of 300 x 500 cells has 150,000 cells.
  // Each cell has 2 triangles = 300,000 triangles total.
  // Number of vertices = 301 x 501 = 150,801 vertices.
  const vertexCount = (width + 1) * (height + 1);
  const positions = new Float32Array(vertexCount * 3);

  let vIdx = 0;
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      positions[vIdx * 3] = x * 0.1;
      positions[vIdx * 3 + 1] = y * 0.1;
      
      // Crease Peak in the middle column
      const distToMiddle = Math.abs(x - width / 2);
      const creaseHeight = Math.max(0, 5 - distToMiddle * 0.5);
      
      // Add high frequency noise to stimulate roughness variance
      const noise = (x % 2 === 0 ? 0.3 : 0.0) + (y % 3 === 0 ? 0.2 : 0.0);
      
      positions[vIdx * 3 + 2] = creaseHeight + noise;
      vIdx++;
    }
  }

  const faceCount = width * height * 2;
  const indices = new Uint32Array(faceCount * 3);
  let iIdx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v0 = y * (width + 1) + x;
      const v1 = y * (width + 1) + x + 1;
      const v2 = (y + 1) * (width + 1) + x;
      const v3 = (y + 1) * (width + 1) + x + 1;

      // Triangle 1 (v0, v1, v2)
      indices[iIdx * 3] = v0;
      indices[iIdx * 3 + 1] = v1;
      indices[iIdx * 3 + 2] = v2;
      iIdx++;

      // Triangle 2 (v2, v1, v3)
      indices[iIdx * 3] = v2;
      indices[iIdx * 3 + 1] = v1;
      indices[iIdx * 3 + 2] = v3;
      iIdx++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

test('Support Painter Adjacency Indexing & Smart Brush Walk Performance Benchmarks', () => {
  console.log('\n==================================================================');
  console.log('STARTING SUPPORT PAINTER PERFORMANCE BENCHMARKS (300K TRIANGLES)');
  console.log('==================================================================');

  // Force garbage collection if possible (node flag required, otherwise estimation)
  if (global.gc) {
    global.gc();
  }

  const heapStart = process.memoryUsage().heapUsed;
  const tGenStart = performance.now();
  const geometry = generate300kTriangleMesh();
  const tGenEnd = performance.now();
  
  console.log(`[GEN] Generated 300k triangle mesh in ${(tGenEnd - tGenStart).toFixed(2)} ms`);

  // Build Adjacency Map
  const tBuildStart = performance.now();
  const map = buildClientAdjacencyMap(geometry);
  const tBuildEnd = performance.now();
  const buildTime = tBuildEnd - tBuildStart;

  if (global.gc) {
    global.gc();
  }
  const heapEnd = process.memoryUsage().heapUsed;
  const heapDeltaMb = (heapEnd - heapStart) / 1024 / 1024;

  console.log(`[BUILD] buildClientAdjacencyMap:`);
  console.log(`  - Execution Time: ${buildTime.toFixed(2)} ms`);
  console.log(`  - Heap Memory Delta (Adjacency Map + Geometry): ${heapDeltaMb.toFixed(2)} MB`);
  console.log(`  - Face count: ${map.faceCount}`);

  // Warmup and measure walkMacroFace (with macroNormal filtering enabled)
  const syntheticBrush: any = {
    id: 'perf-macro-face',
    name: 'Perf Macro Face',
    selection: {
      enableNormalConeLimit: true,
      normalConeAngleMinDeg: 0,
      normalConeAngleMaxDeg: 30,
      enableSlopeLimit: true,
      overhangSlopeMinDeg: 0,
      overhangSlopeMaxDeg: 90,
      enableDihedralLimit: true,
      dihedralAngleToleranceDeg: 45,
      enableMacroNormalFiltering: true,
      useMacroNormalForCone: true,
      useMacroNormalForSlope: true,
      macroNormalSmoothingIterations: 15,
      macroNormalSmoothingLambda: 0.50,
      curvatureMin: 0,
      curvatureMax: 0,
    },
    operations: [],
  };

  const matrixWorld = new THREE.Matrix4();
  const seedFace = 150300; // Middle of the grid, on the crease

  console.log('\nRunning Smart Brush Walks...');

  // 1. walkMacroFace with macro normals (triggers smoothing computation)
  const tMacroStart = performance.now();
  const macroRes = proposeRegionOnClient(
    map,
    seedFace,
    'MacroFace',
    matrixWorld,
    8.0, // larger radius
    syntheticBrush
  );
  const tMacroEnd = performance.now();
  console.log(`[WALK] MacroFace (15 iterations smoothing + walk):`);
  console.log(`  - Execution Time: ${(tMacroEnd - tMacroStart).toFixed(2)} ms`);
  console.log(`  - Region size: ${macroRes.length} triangles`);

  // 2. walkRoughEdge (checks normal variance repeatedly)
  const roughBrush: any = {
    id: 'perf-rough-edge',
    selection: {
      roughnessThreshold: 0.05,
    }
  };
  const tRoughStart = performance.now();
  const roughRes = proposeRegionOnClient(
    map,
    seedFace,
    'RoughEdge',
    matrixWorld,
    8.0,
    roughBrush
  );
  const tRoughEnd = performance.now();
  console.log(`[WALK] RoughEdge:`);
  console.log(`  - Execution Time: ${(tRoughEnd - tRoughStart).toFixed(2)} ms`);
  console.log(`  - Region size: ${roughRes.length} triangles`);

  // 3. walkRidge (checks crease repeatedly)
  const ridgeBrush: any = {
    id: 'perf-ridge',
    selection: {
      creaseSeedAngleDeg: 12.0,
      creasePropagateAngleDeg: 4.0,
      ridgeAlignmentTolerance: 0.3,
    }
  };
  const tRidgeStart = performance.now();
  const ridgeRes = proposeRegionOnClient(
    map,
    seedFace,
    'Ridge',
    matrixWorld,
    8.0,
    ridgeBrush
  );
  const tRidgeEnd = performance.now();
  console.log(`[WALK] Ridge:`);
  console.log(`  - Execution Time: ${(tRidgeEnd - tRidgeStart).toFixed(2)} ms`);
  console.log(`  - Region size: ${ridgeRes.length} triangles`);

  console.log('==================================================================\n');

  // Simple sanity checks
  assert.ok(map.faceCount === 300000, 'Adjacency map should have 300,000 faces');
  assert.ok(buildTime > 0, 'Build time should be recorded');
});
