import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { mergeOverhangRegions } from '../useIslands';
import type { DetectedIsland } from '../types';

// ---------------------------------------------------------------------------
// Real-world fixtures: the xyzCalibration cube — a 20×20 flat bottom face
// (400 mm² projected) plus four tiny down-facing lettering ledges (~3 mm²).
// ---------------------------------------------------------------------------

function voxelIsland(id: string, x: number, y: number, z: number, areaMm2: number): DetectedIsland {
  return {
    id,
    source: 'voxel',
    contact: new THREE.Vector3(x, y, z),
    baseZ: z,
    areaMm2,
  };
}

function overhangIsland(
  id: string,
  minX: number, maxX: number, minY: number, maxY: number,
  areaMm2: number,
): DetectedIsland {
  // contactVoxels sampled at 0.25 mm across the footprint (matches the
  // classifier's footprint mask emission).
  const contactVoxels: { x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x += 0.25) {
    for (let y = minY; y <= maxY; y += 0.25) {
      contactVoxels.push({ x, y });
    }
  }
  return {
    id,
    source: 'overhang',
    contact: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, minY),
    baseZ: minY,
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

test('merge keeps a voxel island whose area does not match the region', () => {
  // A voxel island that only overlaps a corner of a large region (area ratio
  // far below 0.5) is a genuinely different region — conservative: keep it.
  const classified = [voxelIsland('v0', 8, 8, 6.53, 4)];
  const overhang = [overhangIsland('o0', -10, 10, -10, 10, 400)];

  const merged = mergeOverhangRegions(classified, overhang);
  assert.equal(merged.length, 2, 'mismatched-area voxel island survives');
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
