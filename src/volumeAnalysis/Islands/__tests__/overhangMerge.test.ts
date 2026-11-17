import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { mergeOverhangRegions, mergeOverhangResults } from '../useIslands';
import { classifyIntersection, type ClassifiedIslands } from '../intersection';
import type { DetectedIsland } from '../types';

// ---------------------------------------------------------------------------
// Real-world fixtures: the xyzCalibration cube — a 20×20 flat bottom face
// (400 mm² projected) plus four tiny down-facing lettering ledges (~3 mm²).
// ---------------------------------------------------------------------------

function voxelIsland(
  id: string,
  x: number,
  y: number,
  z: number,
  areaMm2: number,
  extra?: Partial<DetectedIsland>,
): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(x, y, z),
    baseZ: z,
    areaMm2,
    ...extra,
  };
}

function minimaIsland(
  id: string,
  x: number,
  y: number,
  z: number,
  extra?: Partial<DetectedIsland>,
): DetectedIsland {
  return {
    id,
    source: 'minima',
    contact: new THREE.Vector3(x, y, z),
    baseZ: z,
    ...extra,
  };
}

function overhangIsland(
  id: string,
  minX: number, maxX: number, minY: number, maxY: number,
  areaMm2: number,
  baseZ = 6.53,
): DetectedIsland {
  // contactVoxels sampled at 0.25 mm across the footprint (matches the
  // classifier's footprint mask emission).
  const contactVoxels: { x: number; y: number; z: number }[] = [];
  for (let x = minX; x <= maxX; x += 0.25) {
    for (let y = minY; y <= maxY; y += 0.25) {
      contactVoxels.push({ x, y, z: baseZ });
    }
  }
  return {
    id,
    source: 'overhang',
    contact: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, baseZ),
    baseZ,
    areaMm2,
    contactVoxels: footprintFromPoints(contactVoxels),
  };
}

test('merge drops a voxel island covered by an overhang region (cube underside)', () => {
  // The cube: one voxel island for the whole bottom layer (400 mm²), one
  // overhang region for the bottom face (400 mm², footprint −10..10).
  const classified = [voxelIsland('v0', 0, 0, 6.53, 400)];
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400)];

  const merged = mergeOverhangRegions(classified, overhang);
  assert.equal(merged.length, 1, 'voxel duplicate dropped, overhang kept');
  assert.equal(merged[0].id, 'o0');
  assert.equal(merged[0].source, 'overhang');
});

test('merge keeps voxel islands not covered by any overhang region', () => {
  const classified = [
    voxelIsland('v0', 0, 0, 6.53, 400),
    voxelIsland('v1', 50, 50, 30, 10),
  ];
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400)];

  const merged = mergeOverhangRegions(classified, overhang);
  const ids = merged.map((i) => i.id);
  assert.ok(ids.includes('o0'), 'overhang region present');
  assert.ok(ids.includes('v1'), 'distant voxel island survives');
  assert.ok(!ids.includes('v0'), 'covered voxel island dropped');
});

test('merge drops small corner/edge voxel islands on a large same-Z overhang (NBR-05)', () => {
  const classified = [
    voxelIsland('v-corner-4', 8, 8, 6.53, 4),
    voxelIsland('v-tiny', -9.8, -9.8, 6.53, 0.05),
  ];
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400, 6.53)];

  const merged = mergeOverhangRegions(classified, overhang);
  assert.equal(merged.length, 1, 'both small corner voxel islands deduped');
  assert.equal(merged[0].id, 'o0');
});

test('merge keeps a high-Z voxel island directly above an overhang at the same XY (NBR-05)', () => {
  const classified = [voxelIsland('v-above', 0, 0, 20, 400)];
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400, 6.53)];

  const merged = mergeOverhangRegions(classified, overhang);
  const ids = merged.map((i) => i.id);
  assert.ok(ids.includes('v-above'), 'voxel at z=20 survives above z=6.53 overhang');
  assert.ok(ids.includes('o0'));
});

test('merge keeps an island sitting inside an interior-hole ring overhang (NBR-05)', () => {
  const ringPoints: { x: number; y: number; z: number }[] = [];
  for (let x = -10; x <= 10; x += 0.25) {
    for (let y = -10; y <= 10; y += 0.25) {
      if (Math.abs(x) <= 2 && Math.abs(y) <= 2) continue;
      ringPoints.push({ x, y, z: 6.53 });
    }
  }
  const ringOverhang: DetectedIsland = {
    id: 'o-ring',
    source: 'overhang',
    contact: new THREE.Vector3(-10, -10, 6.53),
    baseZ: 6.53,
    areaMm2: 384,
    contactVoxels: footprintFromPoints(ringPoints),
  };
  const holeIsland = voxelIsland('v-hole', 0, 0, 6.53, 200, {
    contactVoxels: footprintFromPoints([{ x: 0, y: 0, z: 6.53 }]),
  });

  const merged = mergeOverhangRegions([holeIsland], [ringOverhang]);
  const ids = merged.map((i) => i.id);
  assert.ok(ids.includes('v-hole'), 'hole voxel inside ring AABB must survive');
  assert.ok(ids.includes('o-ring'));
});

test('merge drops C-shaped voxel island whose centroid lies in empty space when >=50% of pixels are covered (NBR-05)', () => {
  const overhang = [overhangIsland('o0', 1, 10, -10, 10, 180, 6.53)];
  // C-shaped voxel island: centroid contact at (0, 0) (uncovered), >=50% pixels at x >= 1.5 (covered)
  const cVoxel = voxelIsland('v-c', 0, 0, 6.53, 1, {
    contactVoxels: footprintFromPoints([
      { x: 2, y: 2 },
      { x: 2.05, y: 2 },
      { x: 2, y: -2 },
      { x: 2.05, y: -2 },
      { x: -1, y: 0 },
    ]),
  });

  const merged = mergeOverhangRegions([cVoxel], overhang);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'o0');
});

test('merge keeps huge voxel island overlapping a small overhang ledge (NBR-05)', () => {
  const classified = [voxelIsland('v-huge', -4, -9, 6.53, 400)];
  const overhang = [overhangIsland('o-ledge', -5, -3, -10, -8, 1.6, 6.53)];

  const merged = mergeOverhangRegions(classified, overhang);
  const ids = merged.map((i) => i.id);
  assert.ok(ids.includes('v-huge'), '400 mm² voxel must survive 1.6 mm² overhang');
  assert.ok(ids.includes('o-ledge'));
});

test('C2: merge protects intersection and isDetached islands, yields only CantileverFringe, and annotates coveredByOverhangId on voxel & minima', () => {
  const classifiedResult: ClassifiedIslands = {
    islands: [
      voxelIsland('v0', 0, 0, 6.53, 10, { class: 'intersection', matchedWith: 'm0' }),
      voxelIsland('v-detached', 2, 2, 6.53, 0.5, { class: 'voxelOnly', matchedWith: null, isDetached: true }),
      voxelIsland('v-fringe', -2, -2, 6.53, 1.0, { class: 'voxelOnly', matchedWith: null, isDetached: false }),
      voxelIsland('v1', 50, 50, 12, 2, { class: 'voxelOnly', matchedWith: null }),
      minimaIsland('m0', 0, 0, 6.53, { class: 'intersection', matchedWith: 'v0' }),
      minimaIsland('m-only-cov', 4, 4, 6.53, { class: 'minimaOnly', matchedWith: null }),
      minimaIsland('m-only-far', 50, 50, 12, { class: 'minimaOnly', matchedWith: null }),
    ],
    stats: {
      voxelTotal: 4,
      minimaTotal: 3,
      matched: 1,
      voxelOnly: 3,
      minimaOnly: 2,
      minimaSupersetOfVoxel: false,
      voxelSupersetOfMinima: false,
      meanMatchOffsetMm: 0.1,
    },
  };
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400, 6.53)];

  const merged = mergeOverhangResults(classifiedResult, overhang, {
    voxelPxMm: 0.05,
    layerHeightMm: 0.05,
    overhangPxMm: 0.25,
  });

  const v0 = merged.islands.find((i) => i.id === 'v0')!;
  const vDetached = merged.islands.find((i) => i.id === 'v-detached')!;
  const m0 = merged.islands.find((i) => i.id === 'm0')!;
  const mCov = merged.islands.find((i) => i.id === 'm-only-cov')!;
  const mFar = merged.islands.find((i) => i.id === 'm-only-far')!;

  assert.equal(v0.class, 'intersection', 'intersection voxel must survive overhang merge');
  assert.equal(v0.matchedWith, 'm0');
  assert.equal(v0.coveredByOverhangId, 'o0');
  assert.equal(vDetached.coveredByOverhangId, 'o0', 'isDetached voxel survives with coveredByOverhangId');
  assert.equal(merged.islands.some((i) => i.id === 'v-fringe'), false, 'CantileverFringe yields to overhang');
  assert.equal(merged.islands.some((i) => i.id === 'v1'), true);
  assert.equal(m0.class, 'intersection', 'matched minima must NOT demote to minimaOnly');
  assert.equal(m0.matchedWith, 'v0');
  assert.equal(m0.coveredByOverhangId, 'o0', 'minima receives non-destructive coveredByOverhangId');
  assert.equal(mCov.coveredByOverhangId, 'o0', 'minimaOnly inside overhang receives coveredByOverhangId');
  assert.equal(mFar.coveredByOverhangId, undefined);
  assert.equal(merged.islands.some((i) => i.id === 'o0'), true);
  assert.deepEqual(merged.stats, {
    voxelTotal: 3,
    minimaTotal: 3,
    matched: 1,
    voxelOnly: 2,
    minimaOnly: 2,
    minimaSupersetOfVoxel: false,
    voxelSupersetOfMinima: false,
    meanMatchOffsetMm: 0.1,
  });
});

test('merge respects 0.30 mm overhang-grid edge tolerance and high-coordinate bucket fallback (NBR-05)', () => {
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400, 6.53)];
  const boundaryVoxel = voxelIsland('v-edge', 10.25, 10.0, 6.53, 0.5);
  const outsideVoxel = voxelIsland('v-out', 10.5, 10.0, 6.53, 0.5);

  const merged = mergeOverhangRegions([boundaryVoxel, outsideVoxel], overhang, {
    voxelPxMm: 0.05,
    layerHeightMm: 0.05,
    overhangPxMm: 0.25,
  });
  const ids = merged.map((i) => i.id);
  assert.ok(!ids.includes('v-edge'), '0.25 mm outside edge <= 0.30 mm margin is dropped');
  assert.ok(ids.includes('v-out'), '0.50 mm outside edge > 0.30 mm margin survives');

  // High-coordinate (> 30000 buckets at 0.30 mm) fallback check
  const farOverhang = [overhangIsland('o-far', 12000, 12002, 12000, 12002, 4, 6.53)];
  const farVoxel = voxelIsland('v-far', 12001, 12001, 6.53, 1);
  const farMerged = mergeOverhangRegions([farVoxel], farOverhang);
  assert.equal(farMerged.length, 1);
  assert.equal(farMerged[0].id, 'o-far');
});

test('merge appends overhang regions without a voxel counterpart', () => {
  // The four lettering ledges have no voxel island (growth below the buffer).
  const classified = [voxelIsland('v0', 0, 0, 6.53, 400)];
  const overhang = [
    overhangIsland('o0', -10, 10, -10, 10, 400),
    overhangIsland('o1', -5, -3, -10, -8, 1.6),
    overhangIsland('o2', 2, 4, -10, -8, 1.6),
    overhangIsland('o3', 8, 10, -5, -3.5, 1.7),
    overhangIsland('o4', 8, 10, 2.5, 4.3, 1.7),
  ];

  const merged = mergeOverhangRegions(classified, overhang);
  assert.equal(merged.length, 5, 'big region replaces voxel, ledges appended');
  assert.equal(merged.filter((i) => i.source === 'overhang').length, 5);
  assert.equal(merged.filter((i) => i.source === 'voxel').length, 0);
});

test('merge is a no-op without overhang regions', () => {
  const classified = [voxelIsland('v0', 0, 0, 6.53, 400)];
  assert.equal(mergeOverhangRegions(classified, []), classified, 'same array reference');
});

test('mergeOverhangResults preserves covered intersections with exact meanMatchOffsetMm and keeps <50%-covered C-shape', () => {
  const vCoveredInter = voxelIsland('v-inter', 0, 0, 6.53, 10);
  const vKept = voxelIsland('v-kept', 50, 50, 12.0, 2);
  const mCoveredInter = minimaIsland('m-inter', 0.02, 0, 6.53);
  const mKept = minimaIsland('m-kept', 50.4, 50.0, 12.0);
  const classifiedResult = classifyIntersection([vCoveredInter, vKept], [mCoveredInter, mKept], {
    xyToleranceMm: 0.5,
    zBandMm: 0.2,
  });
  assert.equal(classifiedResult.stats.matched, 2);
  assert.ok(Math.abs(classifiedResult.stats.meanMatchOffsetMm - 0.21) < 1e-5);

  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400, 6.53)];
  const merged = mergeOverhangResults(classifiedResult, overhang, {
    voxelPxMm: 0.05,
    layerHeightMm: 0.05,
    overhangPxMm: 0.25,
  });
  assert.equal(merged.stats.matched, 2);
  assert.ok(
    Math.abs(merged.stats.meanMatchOffsetMm - 0.21) < 1e-5,
    `expected preserved match offset 0.21 mm, got ${merged.stats.meanMatchOffsetMm}`,
  );
  assert.equal(merged.islands.find((i) => i.id === 'v-inter')?.coveredByOverhangId, 'o0');
  assert.equal(merged.islands.find((i) => i.id === 'm-inter')?.coveredByOverhangId, 'o0');
  assert.equal(merged.islands.find((i) => i.id === 'v-kept')?.coveredByOverhangId, undefined);
  assert.equal(merged.islands.find((i) => i.id === 'm-kept')?.coveredByOverhangId, undefined);

  // C-shape with centroid outside overhang and only 1/5 pixels overlapping (<50%) must survive
  const cPartial: DetectedIsland = {
    ...voxelIsland('v-c-partial', 20, 0, 6.53, 0.5),
    contactVoxels: footprintFromPoints([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20.1, y: 0 },
      { x: 20.2, y: 0 },
      { x: 20.3, y: 0 },
    ]),
  };
  const partialMerged = mergeOverhangRegions([cPartial], overhang);
  assert.ok(partialMerged.some((i) => i.id === 'v-c-partial'), '<50%-covered C-shape must survive');

  // Extreme coordinates past cellKey +-1,048,576 safe integer band
  const extremeOverhang = [overhangIsland('o-extreme', 12_000_000, 12_000_002, -12_000_002, -12_000_000, 4, 6.53)];
  const extremeVoxel = voxelIsland('v-extreme', 12_000_001, -12_000_001, 6.53, 1);
  const extremeMerged = mergeOverhangRegions([extremeVoxel], extremeOverhang);
  assert.equal(extremeMerged.length, 1);
  assert.equal(extremeMerged[0].id, 'o-extreme');
});
