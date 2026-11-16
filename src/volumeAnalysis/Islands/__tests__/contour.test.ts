import { footprintFromPoints, footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  determineContourThreshold,
  consolidateVoxelIslands,
  resolveVoxelVisualType,
} from '../useIslands';
import { buildIslandInstances } from '../islandInstances';
import type { DetectedIsland } from '../types';

function mockVoxelIsland(
  id: string,
  areaMm2: number,
  contactVoxels?: { x: number; y: number; z?: number }[],
  contactPos: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 },
): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(contactPos.x, contactPos.y, contactPos.z),
    baseZ: contactPos.z,
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

test('FLD-03: resolveVoxelVisualType gates type 3 to consolidated/contoured voxel islands only', () => {
  const contouredIds = new Set(['v-contoured', 'v-inter', 'o0']);
  const singleton = mockVoxelIsland('v-solo', 0.02, [{ x: 0, y: 0 }]);
  const contoured = mockVoxelIsland('v-contoured', 0.5, [{ x: 0, y: 0 }]);
  const intersection: DetectedIsland = {
    ...mockVoxelIsland('v-inter', 0.5, [{ x: 0, y: 0 }]),
    class: 'intersection',
    matchedWith: 'm0',
  };
  const multiMember: DetectedIsland = {
    ...mockVoxelIsland('v-multi', 0.5, [{ x: 0, y: 0 }]),
    members: [singleton, contoured],
  };
  const overhang: DetectedIsland = {
    id: 'o0',
    source: 'overhang',
    contact: new THREE.Vector3(0, 0, 1),
    baseZ: 1,
    areaMm2: 10,
  };

  assert.equal(resolveVoxelVisualType(intersection, false, contouredIds), 0, 'false when consolidateVoxel is off');
  assert.equal(resolveVoxelVisualType(singleton, true, contouredIds), 0, 'non-contoured singleton stays type 0');
  assert.equal(resolveVoxelVisualType(contoured, true, contouredIds), 3, 'contoured voxel becomes type 3');
  assert.equal(resolveVoxelVisualType(intersection, true, contouredIds), 3, 'contoured intersection becomes type 3');
  assert.equal(resolveVoxelVisualType(multiMember, true, new Set()), 3, 'multi-member consolidated becomes type 3');
  assert.equal(resolveVoxelVisualType(overhang, true, contouredIds), 0, 'overhang stays type 0');
  assert.equal(resolveVoxelVisualType(undefined, true, contouredIds), 0, 'undefined stays type 0');
});

test('FLD-04: singletons (>= 0.06 mm²) are never dilated whether alone or unmerged in a multi-island scan', () => {
  const pts = [{ x: 0, y: 0 }, { x: 0.05, y: 0 }];
  const solo = mockVoxelIsland('v0', 0.1, pts, { x: 0, y: 0, z: 1 });
  const far = mockVoxelIsland('v1', 0.1, [{ x: 10, y: 10 }], { x: 10, y: 10, z: 1 });

  const singleResult = consolidateVoxelIslands([solo], 0.3, 0.05, 0.05);
  assert.equal(singleResult.length, 1);
  assert.equal(singleResult[0].areaMm2, 0.1);
  assert.equal(singleResult[0].contactVoxels?.count, 2);

  const multiResult = consolidateVoxelIslands([solo, far], 0.3, 0.05, 0.05);
  assert.equal(multiResult.length, 2);
  assert.equal(multiResult[0].areaMm2, 0.1);
  assert.equal(multiResult[0].contactVoxels?.count, 2);
  assert.equal(multiResult[1].areaMm2, 0.1);
  assert.equal(multiResult[1].contactVoxels?.count, 1);
});

test('FLD-04: off-origin grid anchor keeps exact 0.013 + k * 0.05 coordinates with zero drift', () => {
  const v0 = mockVoxelIsland('v0', 0.08, [{ x: 0.013, y: 0.027 }], { x: 0.013, y: 0.027, z: 1 });
  const v1 = mockVoxelIsland('v1', 0.01, [{ x: 0.163, y: 0.027 }], { x: 0.163, y: 0.027, z: 1 });

  const consolidated = consolidateVoxelIslands([v0, v1], 0.3, 0.05, 0.05);
  assert.equal(consolidated.length, 1);
  const fp = consolidated[0].contactVoxels!;
  assert.ok(fp.count > 2);

  const anchorX = Math.fround(0.013);
  const anchorY = Math.fround(0.027);
  for (let i = 0; i < fp.count; i++) {
    const xSteps = (footprintX(fp, i) - anchorX) / 0.05;
    const ySteps = (footprintY(fp, i) - anchorY) / 0.05;
    assert.ok(Math.abs(xSteps - Math.round(xSteps)) < 1e-4, `X drift at i=${i}: ${footprintX(fp, i)}`);
    assert.ok(Math.abs(ySteps - Math.round(ySteps)) < 1e-4, `Y drift at i=${i}: ${footprintY(fp, i)}`);
  }
});

test('FLD-04: Z-band guard separates islands > 2 * layerHeightMm apart and prevents transitive Z drift', () => {
  const a = mockVoxelIsland('va', 0.1, [{ x: 0, y: 0 }], { x: 0, y: 0, z: 1.0 });
  const b = mockVoxelIsland('vb', 0.1, [{ x: 0, y: 0 }], { x: 0, y: 0, z: 1.15 });
  const separate = consolidateVoxelIslands([a, b], 0.3, 0.05, 0.05);
  assert.equal(separate.length, 2, '0.15 mm Z gap > 2 * 0.05 mm must not merge');

  // Transitive chain check: 1.00 -> 1.08 -> 1.15 (pairwise <= 0.10, total 0.15 > 0.10)
  const mid = mockVoxelIsland('vm', 0.1, [{ x: 0, y: 0 }], { x: 0, y: 0, z: 1.08 });
  const chainZ = consolidateVoxelIslands([a, mid, b], 0.3, 0.05, 0.05);
  assert.ok(chainZ.length >= 2, 'transitive Z span must not exceed 2 * layerHeightMm');
  for (const isl of chainZ) {
    if (isl.members && isl.members.length > 1) {
      const zs = isl.members.map((m) => m.baseZ);
      assert.ok(Math.max(...zs) - Math.min(...zs) <= 0.1 + 1e-6);
    }
  }

  // Non-default layerHeightMm = 0.10 (zTol = 0.20): 0.15 mm merges, 0.25 mm separates
  const d0 = mockVoxelIsland('vd0', 0.1, [{ x: 0, y: 0 }], { x: 0, y: 0, z: 1.0 });
  const d1 = mockVoxelIsland('vd1', 0.05, [{ x: 0.1, y: 0 }], { x: 0.1, y: 0, z: 1.15 });
  const d2 = mockVoxelIsland('vd2', 0.05, [{ x: 0.1, y: 0 }], { x: 0.1, y: 0, z: 1.25 });
  const customMerged = consolidateVoxelIslands([d0, d1, d2], 0.3, 0.05, 0.10);
  assert.equal(customMerged.length, 2, '0.15 mm merges at layerHeight=0.10 while 0.25 mm stays separate');
});

test('FLD-04: cluster span is capped at 3 * epsilonMm to prevent runaway chaining', () => {
  const eps = 0.3;
  const islands = [0, 0.25, 0.5, 0.75, 1.0].map((x, idx) =>
    mockVoxelIsland(`v${idx}`, idx === 0 ? 0.1 : 0.02, [{ x, y: 0 }], { x, y: 0, z: 1.0 }),
  );
  const consolidated = consolidateVoxelIslands(islands, eps, 0.05, 0.05);
  assert.ok(consolidated.length >= 2, 'chain spanning 1.0 mm > 3 * 0.30 mm must split');
  for (const isl of consolidated) {
    const members = isl.members ?? [isl];
    const xs = members.map((m) => m.contact.x);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 3 * eps + 1e-6);
  }
});

test('FLD-04: consolidated footprint carries per-voxel Z through buildIslandInstances', () => {
  const v0 = mockVoxelIsland('v0', 0.1, [{ x: 0, y: 0 }], { x: 0, y: 0, z: 1.0 });
  const v1 = mockVoxelIsland('v1', 0.05, [{ x: 0.2, y: 0 }], { x: 0.2, y: 0, z: 1.08 });

  const consolidated = consolidateVoxelIslands([v0, v1], 0.3, 0.05, 0.05);
  assert.equal(consolidated.length, 1);
  const fp = consolidated[0].contactVoxels!;
  assert.ok(fp.z !== null, 'dilated consolidated footprint preserves per-voxel Z');

  let hasLowZ = false;
  let hasHighZ = false;
  for (let i = 0; i < fp.count; i++) {
    const pz = footprintZ(fp, i)!;
    if (Math.abs(pz - 1.0) < 1e-5) hasLowZ = true;
    if (Math.abs(pz - 1.08) < 1e-5) hasHighZ = true;
  }
  assert.ok(hasLowZ && hasHighZ, 'footprint Z retains both 1.00 and 1.08 member elevations');

  const instances = buildIslandInstances(
    [
      {
        markerId: 1,
        type: 3,
        centerX: consolidated[0].contact.x,
        centerY: consolidated[0].contact.y,
        baseZ: consolidated[0].baseZ,
        radius: 0.1,
        footprint: fp,
      },
    ],
    0.0375,
  );
  const instanceZs = Array.from(instances.centerRadius).filter((_, idx) => idx % 4 === 2);
  assert.ok(instanceZs.some((z) => Math.abs(z - 1.0) < 1e-5));
  assert.ok(instanceZs.some((z) => Math.abs(z - 1.08) < 1e-5));
});
