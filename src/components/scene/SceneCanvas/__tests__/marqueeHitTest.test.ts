import assert from 'node:assert/strict';
import test from 'node:test';

import {
  marqueeModeForDrag,
  marqueeRectForDrag,
  meshHitsMarquee,
  ringHitsMarquee,
  shapeHitsMarquee,
} from '../marqueeHitTest';

/** A 100x100 rectangle with its top-left corner at (100, 100). */
const rect = marqueeRectForDrag({ x: 100, y: 100 }, { x: 200, y: 200 });

test('drag direction picks the mode, whatever the vertical direction', () => {
  assert.equal(marqueeModeForDrag({ x: 10, y: 10 }, { x: 90, y: 90 }), 'window');
  assert.equal(marqueeModeForDrag({ x: 10, y: 90 }, { x: 90, y: 10 }), 'window');
  assert.equal(marqueeModeForDrag({ x: 90, y: 10 }, { x: 10, y: 90 }), 'crossing');
  assert.equal(marqueeModeForDrag({ x: 90, y: 90 }, { x: 10, y: 10 }), 'crossing');
});

test('a straight down drag counts as a window', () => {
  assert.equal(marqueeModeForDrag({ x: 50, y: 10 }, { x: 50, y: 90 }), 'window');
});

test('the rectangle is normalised whichever way the drag went', () => {
  assert.deepEqual(
    marqueeRectForDrag({ x: 200, y: 200 }, { x: 100, y: 100 }),
    { minX: 100, minY: 100, maxX: 200, maxY: 200 },
  );
});

test('a window drag takes only a shape that fits entirely', () => {
  const inside = [{ x: 120, y: 120 }, { x: 180, y: 180 }];
  const halfOut = [{ x: 120, y: 120 }, { x: 260, y: 180 }];

  assert.equal(shapeHitsMarquee(rect, inside, [[0, 1]], 'window'), true);
  assert.equal(shapeHitsMarquee(rect, halfOut, [[0, 1]], 'window'), false);
});

test('a crossing drag takes a shape it merely touches', () => {
  const halfOut = [{ x: 120, y: 120 }, { x: 260, y: 180 }];

  assert.equal(shapeHitsMarquee(rect, halfOut, [[0, 1]], 'crossing'), true);
});

test('a crossing drag catches a strut that spans the rectangle end to end', () => {
  const spanning = [{ x: 40, y: 150 }, { x: 300, y: 150 }];

  assert.equal(shapeHitsMarquee(rect, spanning, [[0, 1]], 'crossing'), true);
  assert.equal(shapeHitsMarquee(rect, spanning, [[0, 1]], 'window'), false);
});

test('a strut that passes by without touching is left alone', () => {
  const alongside = [{ x: 40, y: 400 }, { x: 300, y: 400 }];

  assert.equal(shapeHitsMarquee(rect, alongside, [[0, 1]], 'crossing'), false);
});

test('loose points still count for a crossing drag', () => {
  const single = [{ x: 150, y: 150 }];

  assert.equal(shapeHitsMarquee(rect, single, [], 'crossing'), true);
  assert.equal(shapeHitsMarquee(rect, single, [], 'window'), true);
});

test('a shape with no points is never hit', () => {
  assert.equal(shapeHitsMarquee(rect, [], [], 'crossing'), false);
  assert.equal(shapeHitsMarquee(rect, [], [], 'window'), false);
});

test('an unprojectable point sinks a window drag but not a crossing one', () => {
  const partlyProjected = [{ x: 150, y: 150 }, null];

  assert.equal(shapeHitsMarquee(rect, partlyProjected, [[0, 1]], 'window'), false);
  assert.equal(shapeHitsMarquee(rect, partlyProjected, [[0, 1]], 'crossing'), true);
});

const meshOf = (points: Array<[number, number]>, dropped = false) => ({
  xs: Float32Array.from(points.map(([x]) => x)),
  ys: Float32Array.from(points.map(([, y]) => y)),
  count: points.length,
  bounds: points.length === 0 ? null : {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  },
  dropped,
});

test('a window drag takes a mesh whose every vertex is inside', () => {
  assert.equal(meshHitsMarquee(rect, meshOf([[120, 120], [180, 180], [150, 160]]), 'window'), true);
  assert.equal(meshHitsMarquee(rect, meshOf([[120, 120], [260, 180]]), 'window'), false);
});

test('a window drag refuses a mesh with vertices off screen', () => {
  assert.equal(meshHitsMarquee(rect, meshOf([[120, 120], [180, 180]], true), 'window'), false);
});

test('a crossing drag takes a mesh with one vertex inside', () => {
  assert.equal(meshHitsMarquee(rect, meshOf([[40, 40], [150, 150], [400, 400]]), 'crossing'), true);
});

test('a crossing drag leaves a mesh that surrounds the rectangle without entering', () => {
  // The four vertices straddle the marquee: its bounds overlap, no vertex is in.
  const straddling = meshOf([[40, 40], [400, 40], [40, 400], [400, 400]]);

  assert.equal(meshHitsMarquee(rect, straddling, 'crossing'), false);
});

test('a mesh with no vertices is never hit', () => {
  assert.equal(meshHitsMarquee(rect, meshOf([]), 'crossing'), false);
  assert.equal(meshHitsMarquee(rect, meshOf([]), 'window'), false);
});

const bigRing = [
  { x: 0, y: 0 },
  { x: 900, y: 0 },
  { x: 900, y: 900 },
  { x: 0, y: 900 },
];

test('a crossing drag inside a raft outline still takes it', () => {
  assert.equal(ringHitsMarquee(rect, bigRing, 'crossing'), true);
});

test('a crossing drag outside a raft outline leaves it', () => {
  const faraway = [
    { x: 500, y: 500 },
    { x: 900, y: 500 },
    { x: 900, y: 900 },
    { x: 500, y: 900 },
  ];

  assert.equal(ringHitsMarquee(rect, faraway, 'crossing'), false);
});

test('a crossing drag over the edge of an outline takes it', () => {
  const overlapping = [
    { x: 150, y: 150 },
    { x: 900, y: 150 },
    { x: 900, y: 900 },
    { x: 150, y: 900 },
  ];

  assert.equal(ringHitsMarquee(rect, overlapping, 'crossing'), true);
});

test('a window drag needs the whole outline inside', () => {
  const small = [
    { x: 120, y: 120 },
    { x: 180, y: 120 },
    { x: 180, y: 180 },
    { x: 120, y: 180 },
  ];

  assert.equal(ringHitsMarquee(rect, small, 'window'), true);
  assert.equal(ringHitsMarquee(rect, bigRing, 'window'), false);
});

test('an outline with too few points is never hit', () => {
  assert.equal(ringHitsMarquee(rect, [{ x: 150, y: 150 }, { x: 160, y: 160 }], 'crossing'), false);
});
