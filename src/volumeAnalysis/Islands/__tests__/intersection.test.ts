import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { classifyIntersection } from '../intersection';
import { footprintFromPoints } from '../voxelFootprint';
import type { DetectedIsland } from '../types';

function voxel(
  id: number,
  x: number,
  y: number,
  z: number,
  contactVoxels?: Array<{ x: number; y: number; z?: number }>,
): DetectedIsland {
  return {
    id: `v${id}`,
    source: 'voxel',
    contact: new THREE.Vector3(x, y, z),
    baseZ: z,
    areaMm2: 1,
    contactVoxels: contactVoxels ? footprintFromPoints(contactVoxels) : undefined,
  };
}
function minima(id: number, x: number, y: number, z: number): DetectedIsland {
  return { id: `m${id}`, source: 'minima', contact: new THREE.Vector3(x, y, z), baseZ: z };
}

test('matches a coincident voxel + minima as intersection; leaves the rest exclusive', () => {
  const v = [voxel(0, 0, 0, 1), voxel(1, 10, 0, 2)];
  const m = [minima(0, 0.1, 0, 1.02), minima(1, 5, 5, 5)];
  const { stats, islands } = classifyIntersection(v, m, { xyToleranceMm: 0.5, zBandMm: 0.2 });

  assert.equal(stats.matched, 1);
  assert.equal(stats.voxelOnly, 1); // v1
  assert.equal(stats.minimaOnly, 1); // m1

  const v0 = islands.find((i) => i.id === 'v0')!;
  assert.equal(v0.class, 'intersection');
  assert.equal(v0.matchedWith, 'm0');
  assert.equal(v0.baseZ, 1.02, 'matched voxel baseZ snaps to matched minima baseZ');
  assert.ok(v0.contact.equals(new THREE.Vector3(0.1, 0, 1.02)));
  const v1 = islands.find((i) => i.id === 'v1')!;
  assert.equal(v1.class, 'voxelOnly');
});

test('minima-superset verdict when every voxel island matches', () => {
  const v = [voxel(0, 0, 0, 1)];
  const m = [minima(0, 0, 0, 1), minima(1, 20, 0, 1)];
  const { stats } = classifyIntersection(v, m, { xyToleranceMm: 0.5, zBandMm: 0.2 });

  assert.equal(stats.voxelOnly, 0);
  assert.equal(stats.minimaSupersetOfVoxel, true);
  assert.equal(stats.voxelSupersetOfMinima, false); // m1 unmatched
});

test('z-band excludes vertically distant pairs at the same XY', () => {
  const v = [voxel(0, 0, 0, 1)];
  const m = [minima(0, 0, 0, 5)];
  const { stats } = classifyIntersection(v, m, { xyToleranceMm: 0.5, zBandMm: 0.2 });

  assert.equal(stats.matched, 0);
  assert.equal(stats.voxelOnly, 1);
  assert.equal(stats.minimaOnly, 1);
});

test('FLD-03: U-shaped contactVoxels rejects hollow centroid minima while ridge strip matches pixel end', () => {
  // U-shaped footprint: arms at x=-1 and x=+1, bottom bar at y=-1; representative contact sits in empty center (0, 0)
  const uShape = voxel(0, 0, 0, 1, [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -1, y: 1 }, { x: 1, y: 1 },
  ]);
  // Ridge strip: representative contact at (0, 10) while footprint extends to (2, 10)
  const ridge = voxel(1, 0, 10, 1, [
    { x: 0, y: 10 }, { x: 0.5, y: 10 }, { x: 1.0, y: 10 }, { x: 1.5, y: 10 }, { x: 2.0, y: 10 },
  ]);
  const mHollow = minima(0, 0, 0, 1.01);
  const mRidgeEnd = minima(1, 2.0, 10, 1.02);

  const { stats, islands } = classifyIntersection([uShape, ridge], [mHollow, mRidgeEnd], {
    xyToleranceMm: 0.5,
    zBandMm: 0.2,
  });

  assert.equal(stats.matched, 1);
  assert.equal(stats.voxelOnly, 1);
  assert.equal(stats.minimaOnly, 1);

  const vU = islands.find((i) => i.id === 'v0')!;
  const mCenter = islands.find((i) => i.id === 'm0')!;
  assert.equal(vU.class, 'voxelOnly', 'hollow centroid must not match U-shape');
  assert.equal(mCenter.class, 'minimaOnly');

  const vRidge = islands.find((i) => i.id === 'v1')!;
  assert.equal(vRidge.class, 'intersection', 'minima on ridge pixel end matches');
  assert.equal(vRidge.matchedWith, 'm1');
  assert.equal(vRidge.baseZ, 1.02);
});

test('FLD-03: empty contactVoxels falls back cleanly to vi.contact proximity', () => {
  const vEmpty = voxel(0, 3, 4, 1, []);
  const mHit = minima(0, 3.1, 4.1, 1.01);
  const { stats, islands } = classifyIntersection([vEmpty], [mHit], {
    xyToleranceMm: 0.5,
    zBandMm: 0.2,
  });
  assert.equal(stats.matched, 1);
  const matchedVoxel = islands.find((i) => i.id === 'v0')!;
  assert.equal(matchedVoxel.class, 'intersection');
  assert.equal(matchedVoxel.baseZ, 1.01);
  assert.ok(matchedVoxel.contact.equals(new THREE.Vector3(3.1, 4.1, 1.01)));
});

test('C2: global shortest-distance matching avoids greedy stealing and breaks ties by (distSq, rank, vIdx, mIdx)', () => {
  // Greedy index order lets v0=(0,0) steal m0=(0.25,0) [0.25 < 0.35], leaving v1=(0.3,0) unmatched
  // because m1=(-0.35,0) is out of range (0.65 > 0.5). Global sort matches (v1,m0) [0.05] + (v0,m1) [0.35].
  const v = [voxel(0, 0, 0, 1), voxel(1, 0.3, 0, 1)];
  const m = [minima(0, 0.25, 0, 1), minima(1, -0.35, 0, 1)];
  const { stats, islands } = classifyIntersection(v, m, { xyToleranceMm: 0.5, zBandMm: 0.2 });

  assert.equal(stats.matched, 2);
  assert.equal(stats.voxelOnly, 0);
  assert.equal(stats.minimaOnly, 0);
  const v0 = islands.find((i) => i.id === 'v0')!;
  const v1 = islands.find((i) => i.id === 'v1')!;
  assert.equal(v1.matchedWith, 'm0');
  assert.equal(v0.matchedWith, 'm1');

  // Exact distSq tie: isDetached (rank 0) wins before non-detached (rank 1).
  const vFringe: DetectedIsland = { ...voxel(0, 0, 0, 1), isDetached: false };
  const vDetached: DetectedIsland = { ...voxel(1, 0.4, 0, 1), isDetached: true };
  const tie = classifyIntersection([vFringe, vDetached], [minima(0, 0.2, 0, 1)], {
    xyToleranceMm: 0.5,
    zBandMm: 0.2,
  });
  assert.equal(tie.islands.find((i) => i.id === 'v1')!.class, 'intersection');
  assert.equal(tie.islands.find((i) => i.id === 'v0')!.class, 'voxelOnly');
});

test('C2: many-to-one coincident grouping attaches subApexes as plain {x,y,z}[] and computes minimaOnly directly', () => {
  const wideVoxel = voxel(0, 0.1, 0, 1, [
    { x: 0.0, y: 0 }, { x: 0.5, y: 0 }, { x: 1.0, y: 0 }, { x: 1.5, y: 0 }, { x: 2.0, y: 0 },
  ]);
  const mPrimary = minima(0, 0.1, 0, 1.01);
  const mSub = minima(1, 1.8, 0, 1.02);
  const mFar = minima(2, 20, 20, 1);

  const result = classifyIntersection([wideVoxel], [mPrimary, mSub, mFar], {
    xyToleranceMm: 0.5,
    zBandMm: 0.2,
  });
  assert.equal('matchOffsetsMm' in result, false, 'matchOffsetsMm must be removed');
  assert.equal(result.stats.matched, 1);
  assert.equal(result.stats.minimaOnly, 1, 'sub-apex m1 must not inflate minimaOnly');
  assert.equal(result.stats.voxelOnly, 0);

  const matchedV = result.islands.find((i) => i.id === 'v0')!;
  assert.equal(matchedV.matchedWith, 'm0');
  assert.deepEqual(matchedV.subApexes, [{ x: 1.8, y: 0, z: 1.02 }]);
  assert.equal(matchedV.subApexes![0] instanceof THREE.Vector3, false);

  const subM = result.islands.find((i) => i.id === 'm1')!;
  assert.equal(subM.class, 'intersection');
  assert.equal(subM.matchedWith, 'v0');
  const farM = result.islands.find((i) => i.id === 'm2')!;
  assert.equal(farM.class, 'minimaOnly');
  assert.equal(farM.matchedWith, null);
});

test('C2: matches against vi.rawBaseZ when snapped baseZ moved beyond zBandMm and immutably shifts contactVoxels Z', () => {
  const vi: DetectedIsland = {
    ...voxel(0, 0, 0, 1.25, [
      { x: 0, y: 0, z: 1.25 },
      { x: 0.1, y: 0, z: 1.30 },
    ]),
    rawBaseZ: 1.00,
  };
  const mj = minima(0, 0, 0, 1.03);
  const origZ = Array.from(vi.contactVoxels!.z!);

  const { stats, islands } = classifyIntersection([vi], [mj], {
    xyToleranceMm: 0.5,
    zBandMm: 0.10,
  });

  assert.equal(stats.matched, 1, 'rawBaseZ 1.00 within 0.10 mm of mj.baseZ 1.03 must match');
  const outV = islands.find((i) => i.id === 'v0')!;
  assert.equal(outV.baseZ, 1.03);
  assert.ok(outV.contactVoxels?.z);
  assert.ok(Math.abs(outV.contactVoxels!.z![0] - 1.03) < 1e-5);
  assert.ok(Math.abs(outV.contactVoxels!.z![1] - 1.08) < 1e-5);

  // Immutability guard: input vi and its Float32Array must be untouched
  assert.equal(vi.baseZ, 1.25);
  assert.equal(vi.contact.z, 1.25);
  assert.deepEqual(Array.from(vi.contactVoxels!.z!), origZ);
});

test('C2: non-finite (NaN) baseZ or contact neither matches nor corrupts valid matches in pairs.sort', () => {
  const v: DetectedIsland[] = [
    voxel(0, 0, 0, 1),
    voxel(1, 5, 0, 1),
    { ...voxel(2, 10, 0, 1), rawBaseZ: Number.NaN },
    voxel(3, 20, 0, Number.NaN),
    voxel(4, 30, 0, 1, [{ x: 30, y: 0 }]),
  ];
  const m = [
    minima(0, Number.NaN, 0, 1),
    minima(1, 0, 0, Number.NaN),
    minima(2, 0.05, 0, 1),
    minima(3, 5.05, 0, 1),
    minima(4, 10.05, 0, 1),
    minima(5, 20, 0, 1),
    minima(6, 30, 0, Number.NaN),
    minima(7, 30.05, 0, 1),
  ];

  const { stats, islands } = classifyIntersection(v, m, { xyToleranceMm: 0.5, zBandMm: 0.2 });

  assert.equal(stats.matched, 4);
  assert.equal(stats.voxelOnly, 1);
  assert.equal(stats.minimaOnly, 4);
  assert.equal(islands.find((i) => i.id === 'v0')!.matchedWith, 'm2');
  assert.equal(islands.find((i) => i.id === 'v1')!.matchedWith, 'm3');
  assert.equal(islands.find((i) => i.id === 'v2')!.matchedWith, 'm4');
  assert.equal(islands.find((i) => i.id === 'v3')!.class, 'voxelOnly');
  assert.equal(islands.find((i) => i.id === 'v4')!.matchedWith, 'm7');
  assert.equal(islands.find((i) => i.id === 'm0')!.class, 'minimaOnly');
  assert.equal(islands.find((i) => i.id === 'm1')!.class, 'minimaOnly');
  assert.equal(islands.find((i) => i.id === 'm5')!.class, 'minimaOnly');
  assert.equal(islands.find((i) => i.id === 'm6')!.class, 'minimaOnly');
});
