import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { planeMeshIntersection } from '../planeMeshIntersection';
import type { CutPlane } from '../cutPlane';

function plane(normal: [number, number, number], offset: number): CutPlane {
  const n = new THREE.Vector3(...normal).normalize();
  return { normal: n, offset, point: n.clone().multiplyScalar(offset) };
}

/** Axis-aligned box centred on the origin. */
function box(width = 2, height = 2, depth = 2): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, height, depth).toNonIndexed();
}

test('a plane through the middle of a box gives one closed loop', () => {
  const curves = planeMeshIntersection(box(), plane([0, 0, 1], 0));

  assert.equal(curves.length, 1, 'one loop');
  assert.equal(curves[0].closed, true, 'the loop closes');

  // Every point sits on the plane (z == 0) and on the box's z=0 cross-section.
  const pts = curves[0].points;
  for (let i = 0; i < pts.length; i += 3) {
    assert.ok(Math.abs(pts[i + 2]) < 1e-5, `point ${i / 3} is on the plane`);
  }
});

test('the loop traces the real cross-section, not the bounding box', () => {
  // A 4x2x2 box cut across its long axis: the section is the 2x2 face.
  const curves = planeMeshIntersection(box(4, 2, 2), plane([1, 0, 0], 0));
  assert.equal(curves.length, 1);

  const pts = curves[0].points;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    maxY = Math.max(maxY, Math.abs(pts[i + 1]));
    maxZ = Math.max(maxZ, Math.abs(pts[i + 2]));
  }
  assert.ok(Math.abs(maxY - 1) < 1e-5, `half-height 1, got ${maxY}`);
  assert.ok(Math.abs(maxZ - 1) < 1e-5, `half-depth 1, got ${maxZ}`);
});

test('a plane that misses the mesh returns nothing', () => {
  assert.deepEqual(planeMeshIntersection(box(), plane([0, 0, 1], 50)), []);
});

test('a plane cutting two separate bodies returns a loop per body', () => {
  // Two boxes side by side — the "pair of legs" case.
  const left = box().translate(-5, 0, 0);
  const right = box().translate(5, 0, 0);

  const merged = new THREE.BufferGeometry();
  const a = left.getAttribute('position').array as Float32Array;
  const b = right.getAttribute('position').array as Float32Array;
  const all = new Float32Array(a.length + b.length);
  all.set(a, 0);
  all.set(b, a.length);
  merged.setAttribute('position', new THREE.BufferAttribute(all, 3));

  const curves = planeMeshIntersection(merged, plane([0, 0, 1], 0));
  assert.equal(curves.length, 2, 'one loop per body');
  assert.ok(curves.every((c) => c.closed), 'both loops close');
});

test('an offset plane still lands on the plane it was given', () => {
  const curves = planeMeshIntersection(box(2, 2, 10), plane([0, 0, 1], 3));
  assert.equal(curves.length, 1);
  const pts = curves[0].points;
  for (let i = 0; i < pts.length; i += 3) {
    assert.ok(Math.abs(pts[i + 2] - 3) < 1e-5, 'point sits at z = 3');
  }
});

test('an indexed geometry gives the same answer as a non-indexed one', () => {
  const indexed = new THREE.BoxGeometry(2, 2, 2);
  const nonIndexed = indexed.clone().toNonIndexed();

  const a = planeMeshIntersection(indexed, plane([0, 1, 0], 0));
  const b = planeMeshIntersection(nonIndexed, plane([0, 1, 0], 0));

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].points.length, b[0].points.length);
});

test('a tilted plane produces a loop whose points all satisfy the plane equation', () => {
  const p = plane([1, 1, 1], 0.25);
  const curves = planeMeshIntersection(box(4, 4, 4), p);
  assert.ok(curves.length >= 1);

  for (const curve of curves) {
    const pts = curve.points;
    for (let i = 0; i < pts.length; i += 3) {
      const d = p.normal.x * pts[i] + p.normal.y * pts[i + 1] + p.normal.z * pts[i + 2] - p.offset;
      assert.ok(Math.abs(d) < 1e-4, `point ${i / 3} off-plane by ${d}`);
    }
  }
});
