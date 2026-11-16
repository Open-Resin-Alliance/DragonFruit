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
