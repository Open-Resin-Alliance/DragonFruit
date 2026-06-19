import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { snapPointsToFeatureEdges, extractFeatureEdges } from '../snapToEdges';
import type { OrganicCutLoopPoint } from '../types';

const pt = (x: number, y: number, z: number): OrganicCutLoopPoint => ({
  position: [x, y, z],
  normal: [0, 1, 0],
});

const near = (a: readonly number[], b: readonly number[], eps = 1e-4) =>
  a.every((v, i) => Math.abs(v - b[i]) <= eps);

/** A unit-ish cube spanning [-1,1] on every axis: 12 sharp edges, 8 corners. */
function cube(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(2, 2, 2);
  g.computeBoundingBox();
  return g;
}

test('a point off a feature edge snaps onto the edge', () => {
  const r = snapPointsToFeatureEdges([pt(0, 0.9, 0.9)], cube());
  assert.equal(r.edgeCount, 12);
  assert.equal(r.cornerCount, 8);
  assert.equal(r.movedCount, 1);
  assert.equal(r.cornerSnapCount, 0);
  // Nearest edge is the top-front edge {(x,1,1)}; foot is directly above/across.
  assert.ok(near(r.points[0].position, [0, 1, 1]), `got ${r.points[0].position}`);
});

test('a point near a corner snaps to the corner, not just an edge', () => {
  const r = snapPointsToFeatureEdges([pt(0.9, 0.9, 0.9)], cube());
  assert.equal(r.cornerSnapCount, 1);
  assert.ok(near(r.points[0].position, [1, 1, 1]), `got ${r.points[0].position}`);
});

test('the normal is preserved through a snap', () => {
  const p = pt(0, 0.9, 0.9);
  p.normal = [0.1, 0.2, 0.9];
  const r = snapPointsToFeatureEdges([p], cube());
  assert.deepEqual(r.points[0].normal, [0.1, 0.2, 0.9]);
});

test('a model with no creases above threshold is a no-op (same array reference)', () => {
  const sphere = new THREE.SphereGeometry(1, 64, 48); // facets < 30° everywhere
  sphere.computeBoundingBox();
  const pts = [pt(0, 0, 1)];
  const r = snapPointsToFeatureEdges(pts, sphere);
  assert.equal(r.edgeCount, 0);
  assert.equal(r.movedCount, 0);
  assert.equal(r.points, pts); // unchanged reference → no recompute downstream
});

test('empty loop is a no-op', () => {
  const r = snapPointsToFeatureEdges([], cube());
  assert.equal(r.movedCount, 0);
  assert.deepEqual(r.points, []);
});

test('BVH nearest-edge matches a brute-force segment projection', () => {
  // Points chosen to sit in plain-edge range (far from any corner) so the snap
  // result is purely the nearest-edge foot — directly comparable to a manual
  // segment scan. Guards the degenerate-triangle BVH encoding inside the helper.
  const geo = cube();
  const seg = extractFeatureEdges(geo);
  const brute = (px: number, py: number, pz: number): [number, number, number] => {
    let best = Infinity;
    let out: [number, number, number] = [px, py, pz];
    for (let i = 0; i < seg.length; i += 6) {
      const ax = seg[i], ay = seg[i + 1], az = seg[i + 2];
      const abx = seg[i + 3] - ax, aby = seg[i + 4] - ay, abz = seg[i + 5] - az;
      const l = abx * abx + aby * aby + abz * abz;
      let t = l > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
      const d = (cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2;
      if (d < best) { best = d; out = [cx, cy, cz]; }
    }
    return out;
  };

  const probes: Array<[number, number, number]> = [
    [0, 0.8, 0.8],
    [0.3, 1.1, 0.85],
    [-0.5, 0.9, -0.9],
    [0.9, 0.2, 1.05],
  ];
  for (const p of probes) {
    const r = snapPointsToFeatureEdges([pt(...p)], geo);
    assert.equal(r.cornerSnapCount, 0, `${p} unexpectedly hit a corner`);
    assert.ok(near(r.points[0].position, brute(...p)), `${p}: ${r.points[0].position} vs ${brute(...p)}`);
  }
});
