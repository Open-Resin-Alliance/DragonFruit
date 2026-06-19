import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { snapPointsToFeatureEdges } from '../snapToEdges';
import type { OrganicCutLoopPoint } from '../types';

const N: [number, number, number] = [0, 0, 1];
const pt = (x: number, y: number, z: number): OrganicCutLoopPoint => ({
  position: [x, y, z],
  normal: N,
});
const dist = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// A 100mm cube: every box corner is a degree-3 feature corner, every edge is a
// single 100mm segment between two of them. Centered at the origin → corners at
// (±50, ±50, ±50). bbox diag ≈ 173mm.
const cube = () => {
  const g = new THREE.BoxGeometry(100, 100, 100);
  g.computeBoundingBox();
  return g;
};
const CORNER = [50, 50, 50];

test('ridge tip: a point beside an edge near a corner snaps to the corner', () => {
  // On the top edge that varies in x at y=z=50. The point sits ~0.5mm off the
  // edge and ~8mm short of the (50,50,50) corner. The geodesic walk reaches the
  // corner along the edge (arc ≈ 8mm < 6% diag ≈ 10.4mm) and snaps to it.
  const { points, cornerSnapCount } = snapPointsToFeatureEdges([pt(42, 50, 49.5)], cube());
  assert.equal(cornerSnapCount, 1, 'should have snapped to a corner');
  assert.ok(
    dist(points[0].position, CORNER) < 1e-3,
    `expected snap to ${CORNER}, got ${points[0].position}`,
  );
});

test('a point clamped past the edge end lands on the corner', () => {
  // Projection clamps to the segment endpoint; result is the tip either way.
  const { points } = snapPointsToFeatureEdges([pt(60, 50, 49.5)], cube());
  assert.ok(dist(points[0].position, CORNER) < 1e-3);
});

test('no over-grab: a point beside the middle of an edge stays on the edge', () => {
  // Slide to either corner is ~50mm, far beyond the endpoint grab radius, so it
  // snaps to the crease (x≈0, y=z=50), not to a corner.
  const { points, cornerSnapCount } = snapPointsToFeatureEdges([pt(0, 50, 49.5)], cube());
  assert.equal(cornerSnapCount, 0, 'mid-edge point must not be yanked to a corner');
  assert.ok(Math.abs(points[0].position[0]) < 1e-3, 'x should stay ~0');
  assert.ok(dist(points[0].position, [0, 50, 50]) < 1e-3);
});

// Build a non-indexed mesh from a flat list of triangles (each = 3 xyz points).
const meshFromTris = (tris: number[][][]) => {
  const pos = new Float32Array(tris.length * 9);
  let o = 0;
  for (const [a, b, c] of tris) {
    pos.set(a, o);
    pos.set(b, o + 3);
    pos.set(c, o + 6);
    o += 9;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeBoundingBox();
  return g;
};

test('disconnected crease: a point on one crease does not jump to a closer corner across a gap', () => {
  // Crease A: a long tent ridge from (0,0,0)→(100,0,0) (two wings folding down).
  // Crease B: a separate little tetra whose tip P=(50,5,0) is NOT joined to A.
  const R0 = [0, 0, 0];
  const R1 = [100, 0, 0];
  const L0 = [0, -10, -10];
  const L1 = [100, -10, -10];
  const T0 = [0, 10, -10];
  const T1 = [100, 10, -10];
  const P = [50, 5, 0];
  const Q = [56, 12, 2];
  const S = [44, 12, 2];
  const U = [50, 11, -7];
  const geom = meshFromTris([
    [R0, L0, L1],
    [R0, L1, R1], // left wing (holds ridge R0–R1)
    [R0, R1, T1],
    [R0, T1, T0], // right wing (holds ridge R0–R1)
    [P, Q, S],
    [P, S, U],
    [P, U, Q],
    [Q, U, S], // tetra B — every edge sharp, P is degree 3
  ]);

  // The waypoint sits on A's ridge mid-span (0.5mm off). B's corner P is only
  // 4.5mm away — Euclidean-closer than A's own corners (~50mm) — but B is a
  // disconnected network, so the geodesic walk from A's ridge never reaches it.
  const { points, cornerSnapCount } = snapPointsToFeatureEdges([pt(50, 0.5, 0)], geom);
  assert.equal(cornerSnapCount, 0, 'must not grab the disconnected crease B corner');
  assert.ok(
    dist(points[0].position, [50, 0, 0]) < 1e-3,
    `expected to stay on ridge A at [50,0,0], got ${points[0].position}`,
  );
  assert.ok(dist(points[0].position, P) > 4, 'must not have jumped to crease B');
});

// Build a folded "ridge strip" along a polyline: every consecutive ridge pair is
// a sharp crease (two wings tent down to z-drop on either side), so EdgesGeometry
// emits the polyline as a connected feature-edge chain with end corners.
const ridgeStripTris = (ridge: number[][], halfWidth: number, drop: number) => {
  const tris: number[][][] = [];
  for (let i = 0; i + 1 < ridge.length; i++) {
    const a = ridge[i];
    const b = ridge[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len; // perpendicular in XY
    const off = (p: number[], s: number) => [p[0] + nx * halfWidth * s, p[1] + ny * halfWidth * s, p[2] - drop];
    const aL = off(a, +1);
    const bL = off(b, +1);
    const aR = off(a, -1);
    const bR = off(b, -1);
    tris.push([a, b, bL], [a, bL, aL]); // left wing (shares ridge edge a–b)
    tris.push([a, b, bR], [a, bR, aR]); // right wing
  }
  return tris;
};

test('geodesic: a point does not jump to a Euclidean-close corner that is far along the crease', () => {
  // A long, narrow hairpin channel: arm1 up (x=0), across the top, arm2 back down
  // (x=3). The far end corner P3=(3,50,5) sits just 3mm (straight line) from a
  // point in the middle of arm1 — it's the EUCLIDEAN-CLOSEST corner — but ~153mm
  // away ALONG the crease (up arm1, across, down arm2). Straight-line snapping
  // would jump the channel to it; geodesic distance must keep the point on arm1.
  const ridge = [
    [0, 0, 5],
    [0, 100, 5],
    [3, 100, 5],
    [3, 50, 5],
  ];
  const geom = meshFromTris(ridgeStripTris(ridge, 1, 5));

  const { points, cornerSnapCount } = snapPointsToFeatureEdges([pt(0, 50, 5)], geom);
  assert.equal(cornerSnapCount, 0, 'must not grab the across-the-channel corner');
  assert.ok(
    dist(points[0].position, [0, 50, 5]) < 1e-3,
    `expected to stay on arm1 at [0,50,5], got ${points[0].position}`,
  );
  assert.ok(dist(points[0].position, [3, 50, 5]) > 2, 'must not have jumped the channel to P3');
});

const arcPolyline = (cx: number, cy: number, r: number, startDeg: number, endDeg: number, steps: number, z: number) => {
  const pts: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return pts;
};

// Continuous ("smooth") folded strip along a ridge polyline: mitered wing offsets
// are SHARED between adjacent segments, so interior vertices stay degree-2 (no cap
// edges) — modelling a real curved crease between two continuous surfaces, where
// only sharp kinks and the ends are corners (unlike ridgeStripTris, which caps
// every segment and so makes every vertex a corner).
const smoothRidgeStrip = (ridge: number[][], hw: number, drop: number) => {
  const n = ridge.length;
  const perp = (i: number) => {
    let tx = 0;
    let ty = 0;
    if (i > 0) {
      const a = ridge[i - 1];
      const b = ridge[i];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      tx += (b[0] - a[0]) / l;
      ty += (b[1] - a[1]) / l;
    }
    if (i < n - 1) {
      const a = ridge[i];
      const b = ridge[i + 1];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      tx += (b[0] - a[0]) / l;
      ty += (b[1] - a[1]) / l;
    }
    const tl = Math.hypot(tx, ty) || 1;
    return [-ty / tl, tx / tl];
  };
  const L = ridge.map((p, i) => [p[0] + perp(i)[0] * hw, p[1] + perp(i)[1] * hw, p[2] - drop]);
  const R = ridge.map((p, i) => [p[0] - perp(i)[0] * hw, p[1] - perp(i)[1] * hw, p[2] - drop]);
  const tris: number[][][] = [];
  for (let i = 0; i + 1 < n; i++) {
    tris.push([ridge[i], ridge[i + 1], L[i + 1]], [ridge[i], L[i + 1], L[i]]);
    tris.push([ridge[i], ridge[i + 1], R[i + 1]], [ridge[i], R[i + 1], R[i]]);
  }
  return tris;
};

test('detour gate: a point does not curl around a feature to a corner that is straight-line close', () => {
  // A crease that runs straight in (S→J), then curls 225° around to its far end F.
  // F (and the corners along the tightening curl) are reachable within the
  // arc-length reach, but getting there means wrapping around the curl — the
  // along-edge arc far exceeds the straight line to them (ratio well over 1.3).
  // The detour gate rejects them, so the point stays on the straight crease
  // rather than jumping around the curl.
  const S = [-50, 0, 1];
  const ridge = [S, ...arcPolyline(0, 8, 8, -90, 135, 15, 1)]; // J=(0,0,1) is the first arc point
  const tris = smoothRidgeStrip(ridge, 1, 1);
  tris.push([[460, 460, 0], [461, 460, 0], [460, 461, 0]]); // inflate bbox so the reach can span the curl
  const geom = meshFromTris(tris);

  const { points, cornerSnapCount } = snapPointsToFeatureEdges([pt(-2, 0, 1)], geom);
  assert.equal(cornerSnapCount, 0, 'must not curl around the feature to a corner');
  assert.ok(
    dist(points[0].position, [-2, 0, 1]) < 1e-3,
    `expected to stay on the straight crease at [-2,0,1], got ${points[0].position}`,
  );
});

test('smooth model with no sharp edges is a no-op', () => {
  const sphere = new THREE.SphereGeometry(50, 64, 64);
  sphere.computeBoundingBox();
  const input = [pt(10, 10, 10)];
  const { points, movedCount, edgeCount } = snapPointsToFeatureEdges(input, sphere);
  assert.equal(edgeCount, 0);
  assert.equal(movedCount, 0);
  assert.equal(points, input, 'same array reference returned unchanged');
});
