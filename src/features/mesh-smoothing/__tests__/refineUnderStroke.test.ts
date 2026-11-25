import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { refineUnderStroke } from '../refineUnderStroke';
import { smoothStrokeOnGeometry } from '../meshSmoothingEngine';
import { DEFAULT_MESH_SMOOTHING_SETTINGS } from '../settings';

/** A closed 12-triangle cube of side `s`, as a soup wound outward. */
function cube(s: number): THREE.BufferGeometry {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const soup = new Float32Array(faces.flatMap((face) => face.flatMap((i) => v[i].map((c) => c * s))));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  return geometry;
}

function corner(geometry: THREE.BufferGeometry, t: number, k: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), t * 3 + k);
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position').count / 3;
}

/** How many faces use each edge, keyed on its rounded endpoints. */
function edgeUses(geometry: THREE.BufferGeometry): Map<string, number> {
  const key = (p: THREE.Vector3) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  const uses = new Map<string, number>();
  for (let t = 0; t < triangleCount(geometry); t++) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [key(corner(geometry, t, k)), key(corner(geometry, t, (k + 1) % 3))].sort();
      uses.set(`${a}|${b}`, (uses.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  return uses;
}

function area(geometry: THREE.BufferGeometry): number {
  let total = 0;
  for (let t = 0; t < triangleCount(geometry); t++) {
    total += new THREE.Triangle(corner(geometry, t, 0), corner(geometry, t, 1), corner(geometry, t, 2)).getArea();
  }
  return total;
}

const topCorner = [10, 10, 10];

test('a stroke over a coarse corner splits the faces there and nowhere else', () => {
  const coarse = cube(10);
  const refined = refineUnderStroke(coarse, topCorner, 0.5, 0.5);
  assert.ok(refined, 'the cube is far coarser than the brush');

  // Only near the stroke: a brush-wide patch, not the whole cube at brush scale.
  const triangles = triangleCount(refined);
  assert.ok(triangles > 12 && triangles < 3000, `${triangles} triangles`);

  // Within the brush, nothing is longer than the brush.
  const brush = new THREE.Vector3(...topCorner);
  for (let t = 0; t < triangles; t++) {
    const face = new THREE.Triangle(corner(refined, t, 0), corner(refined, t, 1), corner(refined, t, 2));
    if (face.closestPointToPoint(brush, new THREE.Vector3()).distanceTo(brush) > 0.5) continue;
    for (let k = 0; k < 3; k++) {
      const edge = corner(refined, t, k).distanceTo(corner(refined, t, (k + 1) % 3));
      assert.ok(edge <= 0.5 + 1e-6, `an edge of ${edge.toFixed(3)} under the brush`);
    }
  }
});

test('the split mesh is the same closed surface', () => {
  const refined = refineUnderStroke(cube(10), topCorner, 0.5, 0.5);
  assert.ok(refined);
  assert.ok(Math.abs(area(refined) - 600) < 1e-3, 'no area gained or lost');
  for (const [edge, uses] of edgeUses(refined)) {
    assert.equal(uses, 2, `edge ${edge} has ${uses} faces: the split left a crack`);
  }
  const box = refined.boundingBox;
  assert.ok(box);
  assert.deepEqual([box.min.toArray(), box.max.toArray()], [[0, 0, 0], [10, 10, 10]]);
});

test('a face the stroke never reaches keeps its triangle id', () => {
  const coarse = cube(10);
  const refined = refineUnderStroke(coarse, topCorner, 0.5, 0.5);
  assert.ok(refined);
  // Triangles 0 and 1 are the bottom face, the far side of the cube from the stroke.
  for (const t of [0, 1]) {
    for (let k = 0; k < 3; k++) assert.deepEqual(corner(refined, t, k), corner(coarse, t, k));
  }
});

test('a mesh already finer than the brush is left alone', () => {
  assert.equal(refineUnderStroke(cube(10), topCorner, 0.5, 20), null);
  // A stroke that misses the mesh entirely.
  assert.equal(refineUnderStroke(cube(10), [30, 30, 30], 0.5, 0.5), null);
});

test('per-vertex data the split would have to invent is left alone', () => {
  const coloured = cube(10);
  coloured.setAttribute('color', new THREE.BufferAttribute(new Float32Array(36 * 3).fill(1), 3));
  assert.equal(refineUnderStroke(coloured, topCorner, 0.5, 0.5), null);
});

test('one material over the whole mesh carries over; several are left alone', () => {
  const single = cube(10);
  single.addGroup(0, 36, 0);
  const refined = refineUnderStroke(single, topCorner, 0.5, 0.5);
  assert.ok(refined, 'the importers give every mesh one group');
  assert.deepEqual(refined.groups, [{ start: 0, count: refined.getAttribute('position').count, materialIndex: 0 }]);

  const several = cube(10);
  several.addGroup(0, 18, 0);
  several.addGroup(18, 18, 1);
  assert.equal(refineUnderStroke(several, topCorner, 0.5, 0.5), null);
});

test('an indexed mesh is split too, and comes back as a soup', () => {
  const indexed = cube(10);
  indexed.setIndex([...Array(36).keys()]);
  const refined = refineUnderStroke(indexed, topCorner, 0.5, 0.5);
  assert.ok(refined);
  assert.equal(refined.getIndex(), null);
});

test('smoothing the split corner rounds it locally, where the coarse cube could only tilt faces', () => {
  const settings = { ...DEFAULT_MESH_SMOOTHING_SETTINGS, brushSizeMm: 0.5, strength: 1, iterations: 3 };
  const tip = new THREE.Vector3(...topCorner);
  const movedFrom = (before: THREE.BufferGeometry, after: THREE.BufferGeometry) => {
    let farthest = 0;
    let tipMoved = 0;
    for (let i = 0; i < before.getAttribute('position').count; i++) {
      const was = new THREE.Vector3().fromBufferAttribute(before.getAttribute('position'), i);
      const now = new THREE.Vector3().fromBufferAttribute(after.getAttribute('position'), i);
      if (was.distanceTo(now) < 1e-6) continue;
      farthest = Math.max(farthest, was.distanceTo(tip));
      if (was.distanceTo(tip) < 1e-6) tipMoved = was.distanceTo(now);
    }
    return { farthest, tipMoved };
  };

  // The coarse cube: the brush reaches only the tip, so the tip moves alone and drags
  // three 10mm faces with it — nothing within the brush is shaped, the faces are tilted.
  const coarse = cube(10);
  const coarseBefore = coarse.clone();
  smoothStrokeOnGeometry(coarse, topCorner, settings, 8000);
  const onCoarse = movedFrom(coarseBefore, coarse);

  // Split under the brush: the vertices that move are the brush's own.
  const refined = refineUnderStroke(cube(10), topCorner, 0.5, 0.5);
  assert.ok(refined);
  const refinedBefore = refined.clone();
  smoothStrokeOnGeometry(refined, topCorner, settings, 8000);
  const onRefined = movedFrom(refinedBefore, refined);

  assert.ok(onRefined.tipMoved > 0, 'the corner is rounded');
  assert.ok(onRefined.farthest <= 0.5 + 1e-6, `a vertex ${onRefined.farthest.toFixed(2)}mm from the brush moved`);
  assert.ok(onRefined.tipMoved < onCoarse.tipMoved, 'a local rounding, not the tip pulled to its far neighbours');
});

test('on a model scaled up on the plate, the brush covers the millimetres it shows', () => {
  // A 0.2-unit cube printed at 50×: 10mm across, like the cube above. A 0.5mm brush is
  // 0.01 of its own units, and only what lies within that may move.
  const settings = { ...DEFAULT_MESH_SMOOTHING_SETTINGS, brushSizeMm: 0.5, strength: 1, iterations: 3 };
  const mmPerUnit = 50;
  const tip = [0.2, 0.2, 0.2];
  const radius = settings.brushSizeMm / mmPerUnit;
  const refined = refineUnderStroke(cube(0.2), tip, radius, radius);
  assert.ok(refined, 'faces of 0.2 units are far longer than a 0.01-unit brush');
  const before = refined.clone();
  const moved = smoothStrokeOnGeometry(refined, tip, settings, 8000, mmPerUnit);
  assert.ok(moved > 0, 'the corner is rounded');
  const corner = new THREE.Vector3(...tip);
  for (let i = 0; i < before.getAttribute('position').count; i++) {
    const was = new THREE.Vector3().fromBufferAttribute(before.getAttribute('position'), i);
    const now = new THREE.Vector3().fromBufferAttribute(refined.getAttribute('position'), i);
    if (was.distanceTo(now) < 1e-9) continue;
    assert.ok(was.distanceTo(corner) <= radius + 1e-9, `a vertex ${(was.distanceTo(corner) * mmPerUnit).toFixed(2)}mm from the brush moved`);
  }
});
