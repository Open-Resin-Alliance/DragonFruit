import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { determineContourThreshold, generateContourMarkers, consolidateVoxelIslands } from '../useIslands';
import type { DetectedIsland } from '../types';

function mockVoxelIsland(id: string, areaMm2: number, contactVoxels?: { x: number; y: number }[]): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(0, 0, 1),
    baseZ: 1,
    areaMm2,
    class: 'voxelOnly',
    contactVoxels,
  };
}

test('generateContourMarkers: returns empty for empty voxels', () => {
  const markers = generateContourMarkers([], 0.05, 1, 1.0, 3);
  assert.equal(markers.length, 0);
});

test('generateContourMarkers: returns 1 marker for a single voxel', () => {
  const voxels = [{ x: 0, y: 0 }];
  const markers = generateContourMarkers(voxels, 0.05, 1, 1.0, 3);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].centerX, 0);
  assert.equal(markers[0].centerY, 0);
  assert.equal(markers[0].radius, 0.12); // Math.max(0.12, 0.05 * 1.5)
});

test('generateContourMarkers: covers multiple close voxels with 1 marker', () => {
  const voxels = [
    { x: 0, y: 0 },
    { x: 0.02, y: 0.02 },
    { x: -0.02, y: -0.02 },
  ];
  const markers = generateContourMarkers(voxels, 0.05, 1, 1.0, 3);
  assert.equal(markers.length, 1);
});

test('generateContourMarkers: covers distant voxels with multiple markers', () => {
  const voxels = [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ];
  const markers = generateContourMarkers(voxels, 0.05, 1, 1.0, 3);
  assert.equal(markers.length, 2);
});

test('generateContourMarkers: uses large radius for interior core and small radius for boundaries', () => {
  // Create a 7x7 grid of voxels, centered at 0,0 with spacing 0.05 mm
  const voxels = [];
  const px = 0.05;
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      voxels.push({ x: x * px, y: y * px });
    }
  }

  const markers = generateContourMarkers(voxels, px, 1, 1.0, 3);
  // There should be a mix of R_large and R_small markers
  assert.ok(markers.length > 0);
  const hasLarge = markers.some(m => m.radius === px * 3.5);
  const hasSmall = markers.some(m => m.radius === Math.max(0.12, px * 1.5));
  assert.ok(hasLarge, 'Should place large circles in the interior core');
  assert.ok(hasSmall, 'Should place small circles on the boundaries');
});

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
  assert.ok(island.contactVoxels.length > 2);
  assert.equal(island.areaMm2, island.contactVoxels.length * 0.05 * 0.05);
});

