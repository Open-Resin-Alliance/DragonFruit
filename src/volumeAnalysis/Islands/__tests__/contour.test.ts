import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { determineContourThreshold, consolidateVoxelIslands } from '../useIslands';
import type { DetectedIsland } from '../types';

function mockVoxelIsland(id: string, areaMm2: number, contactVoxels?: { x: number; y: number }[]): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(0, 0, 1),
    baseZ: 1,
    areaMm2,
    class: 'voxelOnly',
    contactVoxels: contactVoxels ? footprintFromPoints(contactVoxels) : undefined,
  };
}

test('determineContourThreshold: returns empty for no candidate islands', () => {
  const contoured = determineContourThreshold([], 0.05, 20);
  assert.equal(contoured.size, 0);
});

test('determineContourThreshold: contours all qualified if count <= maxContourRegions', () => {
  const voxels = [{ x: 0, y: 0 }];
  const islands = [
    mockVoxelIsland('v0', 1.0, voxels),
    mockVoxelIsland('v1', 0.5, voxels),
  ];
  const contoured = determineContourThreshold(islands, 0.05, 20);
  assert.equal(contoured.size, 2);
  assert.ok(contoured.has('v0'));
  assert.ok(contoured.has('v1'));
});

test('determineContourThreshold: filters out islands below minAreaForContour', () => {
  const voxels = [{ x: 0, y: 0 }];
  const islands = [
    mockVoxelIsland('v0', 1.0, voxels),
    mockVoxelIsland('v1', 0.05, voxels), // Area is below 0.06 mm²
  ];
  const contoured = determineContourThreshold(islands, 0.05, 20);
  assert.equal(contoured.size, 1);
  assert.ok(contoured.has('v0'));
  assert.ok(!contoured.has('v1'));
});

test('determineContourThreshold: limits to top K <= maxContourRegions based on breakpoints', () => {
  const voxels = [{ x: 0, y: 0 }];
  // Generate 25 qualified islands
  const islands: DetectedIsland[] = [];
  for (let i = 0; i < 25; i++) {
    // Large areas for first 6 (5 to 10), then very small areas (0.07)
    const area = i < 6 ? 10 - i : 0.07;
    islands.push(mockVoxelIsland(`v${i}`, area, voxels));
  }
  const contoured = determineContourThreshold(islands, 0.05, 20);
  // It should detect a breakpoint/elbow drop-off after the first 6 large areas
  assert.ok(contoured.size >= 5 && contoured.size <= 20);
  assert.ok(contoured.has('v0'));
  assert.ok(contoured.has('v5'));
  assert.ok(!contoured.has('v6')); // Should drop v6 because of the breakpoint gap (4.0 -> 0.07)
});

test('consolidateVoxelIslands: does not consolidate a group containing only solo dots', () => {
  const v0 = mockVoxelIsland('v0', 0.0025, [{ x: 0.0, y: 0.0 }]);
  const v1 = mockVoxelIsland('v1', 0.0025, [{ x: 0.2, y: 0.0 }]);
  
  const consolidated = consolidateVoxelIslands([v0, v1], 0.3, 0.05);
  
  assert.equal(consolidated.length, 2);
  assert.equal(consolidated[0].id, 'v0');
  assert.equal(consolidated[1].id, 'v1');
});

test('consolidateVoxelIslands: dilates and bridges adjacent footprints if at least one is a cluster', () => {
  // pxMm = 0.05. minAreaForContour = 0.06.
  // v0 is a cluster (0.08 area)
  const v0 = mockVoxelIsland('v0', 0.08, [{ x: 0.0, y: 0.0 }]);
  // v1 is a solo dot (0.0025 area)
  const v1 = mockVoxelIsland('v1', 0.0025, [{ x: 0.2, y: 0.0 }]);
  
  const consolidated = consolidateVoxelIslands([v0, v1], 0.3, 0.05);
  
  assert.equal(consolidated.length, 1);
  const island = consolidated[0];
  assert.ok(island.contactVoxels);
  assert.ok(island.contactVoxels.count > 2);
  assert.equal(island.areaMm2, island.contactVoxels.count * 0.05 * 0.05);
});

