import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  isBoundsDisjointFromVolume,
  isBoundsOutsideVolume,
  computePreciseModelWorldBounds,
  type TransformLike,
} from '../modelBounds';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

const VOLUME = new THREE.Box3(
  new THREE.Vector3(-10, -10, 0),
  new THREE.Vector3(10, 10, 20),
);
const EPS = 0.01;

function box(min: [number, number, number], max: [number, number, number]): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
}

test('a model fully inside the volume is neither outside nor disjoint', () => {
  const bounds = box([-5, -5, 1], [5, 5, 10]);

  assert.equal(isBoundsOutsideVolume(bounds, VOLUME, EPS), false);
  assert.equal(isBoundsDisjointFromVolume(bounds, VOLUME, EPS), false);
});

test('a model that only straddles an edge is outside but not disjoint', () => {
  const bounds = box([8, -2, 0], [16, 2, 5]);

  assert.equal(isBoundsOutsideVolume(bounds, VOLUME, EPS), true, 'containment test rejects it');
  assert.equal(
    isBoundsDisjointFromVolume(bounds, VOLUME, EPS),
    false,
    'the overlapping part is still printable, so slicing must keep the model',
  );
});

test('a model clear of the volume on any axis is disjoint', () => {
  const beyondX = box([12, -2, 0], [20, 2, 5]);
  const beyondY = box([-2, 11, 0], [2, 20, 5]);
  const aboveZ = box([-2, -2, 25], [2, 2, 40]);

  assert.equal(isBoundsDisjointFromVolume(beyondX, VOLUME, EPS), true);
  assert.equal(isBoundsDisjointFromVolume(beyondY, VOLUME, EPS), true);
  assert.equal(isBoundsDisjointFromVolume(aboveZ, VOLUME, EPS), true);
});

test('touching the boundary counts as overlapping', () => {
  const touching = box([10, -2, 0], [20, 2, 5]);

  assert.equal(
    isBoundsDisjointFromVolume(touching, VOLUME, EPS),
    false,
    'a shared face is not a gap; the model is not dismissed on it',
  );
});

test('a gap smaller than the tolerance counts as overlapping', () => {
  const hairlineGap = box([10.005, -2, 0], [20, 2, 5]);

  assert.equal(isBoundsDisjointFromVolume(hairlineGap, VOLUME, EPS), false);
  assert.equal(
    isBoundsDisjointFromVolume(hairlineGap, VOLUME, 0.001),
    true,
    'a tighter tolerance resolves the same gap as disjoint',
  );
});

test('an off-origin volume is handled on each axis independently', () => {
  const leftAligned = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 20, 20));

  assert.equal(isBoundsDisjointFromVolume(box([-5, 5, 5], [-1, 10, 10]), leftAligned, EPS), true);
  assert.equal(isBoundsDisjointFromVolume(box([-1, 5, 5], [5, 10, 10]), leftAligned, EPS), false);
});

/** Off-axis vertices, so a rotated box is not the same as the axis-aligned one. */
const VERTICES = [
  0, 0, 0,
  3, 1, 0,
  0, 2, 1,
  1, 1, 4,
];

function geometryData(): GeometryData {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...VERTICES], 3));
  const bbox = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  return { geometry, bbox, center: bbox.getCenter(new THREE.Vector3()) };
}

/** What `computePreciseModelWorldBounds` reads off a geometry. */
type GeometryData = {
  geometry: THREE.BufferGeometry;
  bbox: THREE.Box3;
  center: THREE.Vector3;
};

/** The world box of the vertices, walked independently of the code under test. */
function oracle(data: GeometryData, transform: TransformLike): THREE.Box3 {
  const matrix = new THREE.Matrix4().compose(
    transform.position,
    quaternionFromGlobalEuler(transform.rotation),
    transform.scale,
  );
  const point = new THREE.Vector3();
  const result = new THREE.Box3();
  // The transform places the geometry relative to its own centre, so the walk
  // starts from the centred vertices - the same thing the implementation walks.
  for (let i = 0; i < VERTICES.length; i += 3) {
    point
      .set(VERTICES[i] - data.center.x, VERTICES[i + 1] - data.center.y, VERTICES[i + 2] - data.center.z)
      .applyMatrix4(matrix);
    result.expandByPoint(point);
  }
  return result;
}

function transformAt(position: THREE.Vector3, rotation: THREE.Euler, scale = new THREE.Vector3(1, 1, 1)): TransformLike {
  return { position, rotation, scale };
}

function assertBoxEqual(actual: THREE.Box3, expected: THREE.Box3, message: string) {
  assert.ok(actual.min.distanceTo(expected.min) < 1e-5, `${message}: min ${actual.min.toArray()} vs ${expected.min.toArray()}`);
  assert.ok(actual.max.distanceTo(expected.max) < 1e-5, `${message}: max ${actual.max.toArray()} vs ${expected.max.toArray()}`);
}

test('precise bounds match a walk of the transformed vertices', () => {
  const data = geometryData();
  const rotated = transformAt(
    new THREE.Vector3(5, -2, 1),
    new THREE.Euler(0.4, -0.9, 0.25),
    new THREE.Vector3(1.5, 2, 0.75),
  );

  assertBoxEqual(computePreciseModelWorldBounds(data, rotated), oracle(data, rotated), 'rotated and scaled');
});

test('moving a model translates its precise bounds rather than changing them', () => {
  const data = geometryData();
  const rotation = new THREE.Euler(0.4, -0.9, 0.25);
  const scale = new THREE.Vector3(1.5, 2, 0.75);
  const from = transformAt(new THREE.Vector3(5, -2, 1), rotation, scale);
  const to = transformAt(new THREE.Vector3(-3, 7, 0.5), rotation, scale);

  const first = computePreciseModelWorldBounds(data, from);
  const second = computePreciseModelWorldBounds(data, to);

  // The box is derived from the orientation and then placed, so a move has to
  // land exactly where a fresh walk of the moved vertices would. Getting the
  // placement wrong - applying it twice, or storing the placed box as if it were
  // the orientation's - is what this catches.
  assertBoxEqual(second, first.clone().translate(new THREE.Vector3(-8, 9, -0.5)), 'translated');
  assertBoxEqual(second, oracle(data, to), 'still exact');
});
