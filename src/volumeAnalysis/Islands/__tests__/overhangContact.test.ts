import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { overhangRegionToIsland } from '../useIslands';
import type { OverhangRegion } from '../types';

// ---------------------------------------------------------------------------
// Issue #591: the contact used to combine the footprint bbox-centre XY with
// region.minZ, which floats mid-air below sloped/concave surfaces. The contact
// must be sampled from the mask's real per-pixel surface Z instead.
// ---------------------------------------------------------------------------

/** 30° underside ramp spanning z = 0 → 5 mm across x = 0..10 mm. */
function rampRegion(): OverhangRegion {
  const pxMm = 0.25;
  const width = 40; // 10 mm
  const height = 4; // 1 mm
  const data: number[] = [];
  const surfaceZ: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      data.push(1);
      // Surface rises with x: z = x * tan(30°)
      const x = (col + 0.5) * pxMm;
      surfaceZ.push(x * Math.tan((30 * Math.PI) / 180));
    }
  }
  return {
    triangleIds: [0],
    areaMm2: 10,
    projectedAreaMm2: 10,
    angleDeg: 30,
    normal: [0, 0, -1],
    xyMin: [0, 0],
    xyMax: [10, 1],
    minZ: 0,
    maxZ: 5,
    footprint: { width, height, originX: 0, originY: 0, pxMm, data, surfaceZ },
  };
}

test('contact lies on the surface at the lowest sample, not mid-air (issue #591)', () => {
  const island = overhangRegionToIsland(rampRegion(), 0);
  assert.equal(island.source, 'overhang');
  // Old behaviour: bbox-centre X (5 mm) paired with minZ (0) — mid-air.
  assert.ok(island.contact.z > 0, `contact.z must sit on the slope, got ${island.contact.z}`);
  // On-surface: lowest sampled pixel is the first column centre.
  assert.ok(Math.abs(island.contact.z - island.baseZ) === 0, 'baseZ tracks contact.z');
});

test('contact XY matches the footprint pixel that attains the lowest surface Z', () => {
  const island = overhangRegionToIsland(rampRegion(), 3);
  const pxMm = 0.25;
  assert.ok(
    Math.abs(island.contact.x - (0 + 0.5) * pxMm) < 1e-9,
    `expected lowest-Z pixel X ${(0.5) * pxMm}, got ${island.contact.x}`,
  );
  assert.equal(island.id, 'o3');
});

test('empty/unusable mask falls back to bbox centre at region.minZ', () => {
  const region = rampRegion();
  region.footprint.data = new Array(region.footprint.data.length).fill(0);
  const island = overhangRegionToIsland(region, 0);
  const f = region.footprint;
  assert.ok(island.contact.equals(new THREE.Vector3((f.width * f.pxMm) / 2, (f.height * f.pxMm) / 2, region.minZ)));
});
