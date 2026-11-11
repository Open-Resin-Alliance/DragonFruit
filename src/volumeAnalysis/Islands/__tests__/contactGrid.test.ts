import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { annotateAndCountSupports, buildIslandContactGrid, scanNeedsCoverage } from '../contactGrid';
import type { DetectedIsland, PoseStabilityWire, TipInfo } from '../types';
import { footprintFromPoints } from '../voxelFootprint';
import { dispatchScanlineWorkerMessage } from '@/volumeAnalysis/IslandScan/scanlineScan.worker';

/** Build non-indexed world-space triangles (9 floats/tri) for an axis-aligned box. */
function buildBoxPositions(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): Float32Array {
  const geom = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
  geom.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const nonIndexed = geom.toNonIndexed();
  return new Float32Array(nonIndexed.getAttribute('position').array as Float32Array);
}

test('MED-05: sloped 30° overhang stamps per-voxel Z so supports higher up the slope are counted', () => {
  // 30° slope rising from Z = 10 mm to Z = 20 mm along +X (tan 30° = 1 / √3).
  const slope = Math.tan((30 * Math.PI) / 180);
  const maxRunX = 10 / slope; // ≈ 17.3205 mm
  const voxels: Array<{ x: number; y: number; z: number }> = [];
  for (let x = 0; x <= maxRunX + 1e-6; x += 0.25) {
    const z = Math.min(20, 10 + x * slope);
    for (let y = -1; y <= 1 + 1e-6; y += 0.25) {
      voxels.push({ x, y, z });
    }
  }

  // Ensure exact voxel centres at Z ∈ {10, 13, 16, 19} mm so XY distance is 0
  // and only the Z-band tolerance distinguishes per-voxel Z from constant contact.z.
  const targetZs = [10, 13, 16, 19];
  const supportTips: TipInfo[] = targetZs.map((z) => {
    const x = (z - 10) / slope;
    voxels.push({ x, y: 0, z });
    return {
      pos: new THREE.Vector3(x, 0, z),
      diameterMm: 0.4,
    };
  });

  const slopedIsland: DetectedIsland = {
    id: 'o-slope-30',
    source: 'overhang',
    contact: new THREE.Vector3(0, 0, 10),
    baseZ: 10,
    maxZ: 20,
    areaMm2: 16,
    overhangAngleDeg: 30,
    contactVoxels: footprintFromPoints(voxels),
  };

  const grid = buildIslandContactGrid([slopedIsland]);
  const [annotated] = annotateAndCountSupports(
    [slopedIsland],
    grid,
    supportTips,
    0,    // plateZ
    4,    // areaPerSupport -> requiredSupports = 4
    0.05, // layerHeightMm -> zTolerance = 0.10 mm
  );

  assert.equal(annotated.supportCount, 4, 'all 4 tips along the 30° slope match their local footprint Z');
  assert.equal(annotated.supported, true);
  assert.equal(annotated.fullySupported, true);
});

test('MED-05: falls back to island.contact.z when contactVoxels omit per-voxel Z or are empty', () => {
  const flatVoxelIsland: DetectedIsland = {
    id: 'v0',
    source: 'voxel',
    contact: new THREE.Vector3(2, 3, 12.5),
    baseZ: 12.5,
    areaMm2: 4,
    contactVoxels: footprintFromPoints([
      { x: 2, y: 3 },
      { x: 4, y: 3 },
    ]),
  };
  const minimaIsland: DetectedIsland = {
    id: 'm0',
    source: 'minima',
    contact: new THREE.Vector3(-5, 1, 8.0),
    baseZ: 8.0,
    areaMm2: 1,
  };

  const grid = buildIslandContactGrid([flatVoxelIsland, minimaIsland]);
  const tips: TipInfo[] = [
    { pos: new THREE.Vector3(4, 3, 12.52), diameterMm: 0.4 },
    { pos: new THREE.Vector3(-5, 1, 8.04), diameterMm: 0.4 },
  ];

  const [vAnnotated, mAnnotated] = annotateAndCountSupports(
    [flatVoxelIsland, minimaIsland],
    grid,
    tips,
    0,
    4,
    0.05,
  );

  assert.equal(vAnnotated.supportCount, 1);
  assert.equal(mAnnotated.supportCount, 1);
});

test('MED-07b: scanlineScan.worker honours candidatesOnly for detect.ts and full RLE result for ScanOrchestrator', () => {
  // Floating 4×4×2 mm box from Z = 5 to Z = 7 mm; slicing at Z = 5.05 mm has no
  // geometry at Z = 4.95 mm, so the entire 4×4 bottom cross-section is an unsupported island.
  const positions = buildBoxPositions(0, 4, 0, 4, 5, 7);
  dispatchScanlineWorkerMessage({ type: 'init', positions }, () => {});

  const gridRef = { originX: -1, originZ: -5, width: 12, height: 12, px_mm: 0.5 };
  const opts = { px_mm: 0.5, support_buffer_mm: 0.5, connectivity: 4 as const };

  // 1. detect.ts contract (`candidatesOnly: true`): lean `candidatePairs` only + zero-copy Transferable buffer.
  const candidateResponses: Array<{ payload: { type: 'done'; result: Record<string, unknown> }; transfer?: Transferable[] }> = [];
  dispatchScanlineWorkerMessage(
    { type: 'layer', z: 5.05, layerHeightMm: 0.1, gridRef, opts, candidatesOnly: true },
    (payload, transfer) => candidateResponses.push({ payload, transfer }),
  );
  assert.equal(candidateResponses.length, 1);
  const candResult = candidateResponses[0].payload.result;
  assert.ok(candResult.candidatePairs instanceof Int32Array, 'candidatePairs is an Int32Array');
  assert.ok((candResult.candidatePairs as Int32Array).length > 0, 'unsupported bottom layer produces candidate pairs');
  assert.deepEqual(
    candidateResponses[0].transfer,
    [(candResult.candidatePairs as Int32Array).buffer],
    'transfers candidatePairs ArrayBuffer zero-copy',
  );
  assert.equal('solidMaskRle' in candResult, false, 'omits solidMaskRle on candidatesOnly fast path');
  assert.equal('islandLabelsRle' in candResult, false, 'omits islandLabelsRle on candidatesOnly fast path');
  assert.equal('components' in candResult, false, 'omits components on candidatesOnly fast path');

  // 2. ScanOrchestrator.runScanlineScan contract (`candidatesOnly` omitted): full RLE masks + components.
  const fullResponses: Array<{ type: 'done'; result: Record<string, unknown> }> = [];
  dispatchScanlineWorkerMessage(
    { type: 'layer', z: 5.05, layerHeightMm: 0.1, gridRef, opts },
    (payload) => fullResponses.push(payload),
  );
  assert.equal(fullResponses.length, 1);
  const fullResult = fullResponses[0].result as {
    solidMaskRle?: { rows: Int32Array[]; width: number; height: number };
    islandLabelsRle?: { rows: Int32Array[]; width: number; height: number };
    islandCount?: number;
    components?: Array<{ id: number; pixelCount: number }>;
  };
  assert.ok(fullResult.solidMaskRle, 'solidMaskRle is populated for ScanOrchestrator');
  assert.equal(fullResult.solidMaskRle.width, gridRef.width);
  assert.equal(fullResult.solidMaskRle.height, gridRef.height);
  assert.ok(fullResult.solidMaskRle.rows.some((r) => r.length > 0), 'solidMaskRle contains solid spans');
  assert.ok(fullResult.islandLabelsRle, 'islandLabelsRle is populated for ScanOrchestrator');
  assert.equal(fullResult.islandCount, 1, 'bottom box layer forms 1 unsupported component');
  assert.ok(Array.isArray(fullResult.components) && fullResult.components.length === 1, 'components array matches islandCount');
});

test('HIGH-06: scanNeedsCoverage handles point/edge drag and serde_json null adhesionRatio on flat-base poses', () => {
  const baseWire: PoseStabilityWire = {
    bearingAreaMm2: 100,
    bearingEdges: 4,
    centroidDepthMm: 5,
    contactDepthMm: 5,
    dragMomentMm3: 0,
    marginMm: 0,
    adhesionRatio: 1.0,
    pushDirDeg: 0,
    dragTopMm: 0,
    bearingIsRaft: false,
  };

  assert.equal(scanNeedsCoverage(null), true);
  assert.equal(scanNeedsCoverage(undefined), true);

  // Point / 1D knife-edge with positive peel drag (even if wire adhesionRatio serialized as null): needs coverage!
  assert.equal(
    scanNeedsCoverage({
      ...baseWire,
      bearingAreaMm2: 0,
      bearingEdges: 0,
      dragMomentMm3: 500,
      adhesionRatio: null as unknown as number,
    }),
    true,
  );

  // Zero-drag degenerate point/edge: no drag to topple it.
  assert.equal(
    scanNeedsCoverage({
      ...baseWire,
      bearingAreaMm2: 0,
      bearingEdges: 0,
      dragMomentMm3: 0,
      adhesionRatio: null as unknown as number,
    }),
    false,
  );

  // Stable flat-base part where Rust f64::INFINITY serialized across Tauri JSON as `null`:
  // previously `null < 0.05` evaluated to `true` in JS! Must return `false`.
  assert.equal(
    scanNeedsCoverage({
      ...baseWire,
      bearingEdges: 4,
      dragMomentMm3: 0,
      adhesionRatio: null as unknown as number,
    }),
    false,
  );

  // Polygon stance with marginal adhesion ratio (< 0.05) -> true; comfortable (>= 0.05) -> false.
  assert.equal(scanNeedsCoverage({ ...baseWire, bearingEdges: 4, dragMomentMm3: 500, adhesionRatio: 0.02 }), true);
  assert.equal(scanNeedsCoverage({ ...baseWire, bearingEdges: 4, dragMomentMm3: 500, adhesionRatio: 0.2 }), false);
});
