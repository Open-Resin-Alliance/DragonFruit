import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  ORTHO_DEPTH_MARGIN,
  ORTHO_FAR,
  ORTHO_NEAR,
  applyOrthoFrustum,
  dollyOrthoToCursor,
  ORTHO_VIEW_TURN_RAD,
  isOrthoFitFrame,
  orthoAspectOf,
  orthoHalfHeightForRadius,
  orthoWheelRadiusScale,
  resolveOrthoNavRadius,
  syncOrthoFrustum,
} from '../orthoDolly';

function makeOrthoCamera(distance = 100, aspect = 1): {
  camera: THREE.OrthographicCamera;
  target: THREE.Vector3;
} {
  const target = new THREE.Vector3(0, 0, 0);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
  camera.position.set(0, 0, distance);
  // Not the scene's Z-up: looking down -Z with `up = +Z` is parallel, which
  // makes `Matrix4.lookAt` fall back to a nudged, almost-degenerate basis. The
  // residuals that fallback leaves are ~1e-2, far above the tolerances here.
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  syncOrthoFrustum(camera, target, aspect);
  return { camera, target };
}

test('syncOrthoFrustum derives a symmetric frustum from the radius', () => {
  const { camera, target } = makeOrthoCamera(100, 1.5);
  const radius = syncOrthoFrustum(camera, target, 1.5);

  const expectedHalfH = orthoHalfHeightForRadius(100);
  assert.ok(Math.abs(radius - 100) < 1e-6);
  assert.ok(Math.abs(camera.top - expectedHalfH) < 1e-6);
  assert.ok(Math.abs(camera.bottom + expectedHalfH) < 1e-6);
  assert.ok(Math.abs(camera.right - expectedHalfH * 1.5) < 1e-6);
  assert.ok(Math.abs(camera.left + expectedHalfH * 1.5) < 1e-6);
  assert.equal(camera.zoom, 1);
});

test('orthoWheelRadiusScale dollies in for scroll-up and out for scroll-down', () => {
  const inScale = orthoWheelRadiusScale(-1, 1);
  const outScale = orthoWheelRadiusScale(1, 1);
  assert.ok(inScale < 1);
  assert.ok(outScale > 1);
  assert.ok(Math.abs(inScale * outScale - 1) < 1e-9);
  // Higher zoom speed = bigger step.
  assert.ok(orthoWheelRadiusScale(-1, 2) < inScale);
});

test('dollyOrthoToCursor keeps the anchored point under the cursor and scales the radius', () => {
  const { camera, target } = makeOrthoCamera(100, 1);
  const ndcX = 0.5;
  const ndcY = 0.25;

  camera.updateMatrixWorld();
  const anchorBefore = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

  const nextTarget = dollyOrthoToCursor({
    camera,
    target,
    ndcX,
    ndcY,
    radiusScale: 0.5,
    aspect: 1,
  });

  assert.ok(Math.abs(camera.position.distanceTo(nextTarget) - 50) < 1e-4);
  assert.equal(camera.zoom, 1);

  // The contract: the world point the cursor was over is still under the cursor.
  // Comparing world x/y of the two unprojections would only hold while both
  // points happen to share a camera plane, which is what made the pivot drift
  // invisible; projecting the original point back is frame-independent.
  camera.updateMatrixWorld();
  const anchorNdc = anchorBefore.clone().project(camera);
  assert.ok(Math.abs(anchorNdc.x - ndcX) < 1e-4);
  assert.ok(Math.abs(anchorNdc.y - ndcY) < 1e-4);
});

test('dollyOrthoToCursor never moves the orbit pivot along the view axis', () => {
  // The regression: the anchor correction used to be built from two unprojected
  // cursor points, taken on the camera plane before and after the move. Their
  // difference includes the dolly's axial travel, so applying it cancelled the
  // dolly already made and pushed the whole displacement onto the next target.
  // The camera stayed put and the pivot walked a full dolly distance away, which
  // is exactly what the user was orbiting around.
  for (const [radiusScale, ndcX, ndcY] of [
    [2, 0, 0],
    [2, 0.5, 0.25],
    [0.5, 0.5, 0.25],
    [3, -0.9, 0.8],
  ] as const) {
    const { camera, target } = makeOrthoCamera(100, 1.5);
    const before = target.clone();

    const nextTarget = dollyOrthoToCursor({ camera, target, ndcX, ndcY, radiusScale, aspect: 1.5 });

    const viewDirection = camera.getWorldDirection(new THREE.Vector3());
    const axialDrift = nextTarget.clone().sub(before).dot(viewDirection);
    assert.ok(
      Math.abs(axialDrift) < 1e-6,
      `radiusScale ${radiusScale} @ (${ndcX}, ${ndcY}) drifted the pivot ${axialDrift} mm along the view axis`,
    );
    // The camera, not the pivot, absorbs the dolly.
    assert.ok(
      Math.abs(camera.position.distanceTo(nextTarget) - 100 * radiusScale) < 1e-4,
      'the camera should sit on the new radius from the returned pivot',
    );
  }
});

test('dollyOrthoToCursor pins a centred cursor to a stationary pivot', () => {
  const { camera, target } = makeOrthoCamera(100, 1);
  const before = target.clone();

  const nextTarget = dollyOrthoToCursor({ camera, target, ndcX: 0, ndcY: 0, radiusScale: 2, aspect: 1 });

  assert.ok(nextTarget.distanceTo(before) < 1e-6, 'a centred dolly must not move the pivot at all');
  assert.ok(Math.abs(camera.position.z - 200) < 1e-4, 'the camera takes the full dolly');
});

test('dollyOrthoToCursor clamps the radius to the configured bounds', () => {
  const { camera, target } = makeOrthoCamera(100, 1);
  const nextTarget = dollyOrthoToCursor({
    camera,
    target,
    ndcX: 0,
    ndcY: 0,
    radiusScale: 0.0001,
    minRadius: 10,
    maxRadius: 1000,
    aspect: 1,
  });
  assert.ok(Math.abs(camera.position.distanceTo(nextTarget) - 10) < 1e-4);
});

test('applyOrthoFrustum sizes the depth range from the scene radius', () => {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);

  applyOrthoFrustum(camera, 100, 1, { sceneRadius: 300 });
  const expectedDepth = 100 + 300 + ORTHO_DEPTH_MARGIN;
  assert.ok(Math.abs(camera.near + expectedDepth) < 1e-6);
  assert.ok(Math.abs(camera.far - expectedDepth) < 1e-6);

  applyOrthoFrustum(camera, 100, 1);
  assert.equal(camera.near, ORTHO_NEAR);
  assert.equal(camera.far, ORTHO_FAR);
});

test('orthoAspectOf reports the frustum aspect', () => {
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, -50000, 50000);
  assert.ok(Math.abs(orthoAspectOf(camera) - 2) < 1e-9);
});

test('resolveOrthoNavRadius integrates a normal dolly frame', () => {
  const next = resolveOrthoNavRadius({
    currentRadius: 100,
    prevAxial: -100,
    axial: -95, // dollied in by 5
    hasPrevious: true,
    turn: 0,
    eyeJump: 5,
  });
  assert.ok(Math.abs(next - 95) < 1e-9);
});

test('resolveOrthoNavRadius keeps the zoom on a reorientation preset', () => {
  const next = resolveOrthoNavRadius({
    currentRadius: 100,
    prevAxial: -100,
    axial: -20, // navlib would have moved the eye much closer
    hasPrevious: true,
    turn: ORTHO_VIEW_TURN_RAD + 0.1,
    eyeJump: 80,
  });
  assert.equal(next, 100);
});

test('resolveOrthoNavRadius keeps the zoom on a pure distance jump (fit)', () => {
  const next = resolveOrthoNavRadius({
    currentRadius: 100,
    prevAxial: -100,
    axial: -20,
    hasPrevious: true,
    turn: 0,
    eyeJump: 80,
  });
  assert.equal(next, 100);
});

test('resolveOrthoNavRadius passes the first frame through', () => {
  const next = resolveOrthoNavRadius({
    currentRadius: 100,
    prevAxial: 0,
    axial: -100,
    hasPrevious: false,
    turn: 0,
    eyeJump: 0,
  });
  assert.equal(next, 100);
});

test('isOrthoFitFrame flags a rotationless distance jump only', () => {
  const base = { currentRadius: 100, prevAxial: -100, axial: -20, hasPrevious: true, turn: 0, eyeJump: 80 };
  assert.equal(isOrthoFitFrame(base), true);
  assert.equal(isOrthoFitFrame({ ...base, turn: ORTHO_VIEW_TURN_RAD + 0.01 }), false);
  assert.equal(isOrthoFitFrame({ ...base, eyeJump: 5 }), false);
  assert.equal(isOrthoFitFrame({ ...base, turn: 0, hasPrevious: false }), false);
});


