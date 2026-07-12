import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { classifyIntersection } from '../intersection';
import type { DetectedIsland } from '../types';

function voxel(id: number, x: number, y: number, z: number): DetectedIsland {
  return { id: `v${id}`, source: 'voxel', contact: new THREE.Vector3(x, y, z), baseZ: z, areaMm2: 1 };
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
