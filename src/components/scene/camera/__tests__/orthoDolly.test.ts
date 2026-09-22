import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  ORTHO_REFERENCE_FOV_DEG,
  bakeOrthoZoomIntoRadius,
  dollyOrthoToCursor,
  orthoHalfHeightForRadius,
  orthoRadiusForPerspectiveFraming,
  orthoWheelRadiusScale,
  syncOrthoFrustum,
} from '../orthoDolly';

const degToRad = THREE.MathUtils.degToRad;

function makeOrthoCamera(distance = 100, aspect = 1): {
  camera: THREE.OrthographicCamera;
  target: THREE.Vector3;
} {
  const target = new THREE.Vector3(0, 0, 0);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
  camera.position.set(0, 0, distance);
  camera.up.set(0, 0, 1);
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

  camera.updateMatrixWorld();
  const anchorAfter = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
  assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1e-4);
  assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 1e-4);
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

test('orthoRadiusForPerspectiveFraming preserves apparent size and round-trips', () => {
  // At the reference FOV the radius is unchanged.
  assert.ok(Math.abs(orthoRadiusForPerspectiveFraming(100, ORTHO_REFERENCE_FOV_DEG) - 100) < 1e-9);

  const perspectiveFov = 80;
  const orthoRadius = orthoRadiusForPerspectiveFraming(100, perspectiveFov);
  assert.ok(
    Math.abs(orthoRadius - (100 * Math.tan(degToRad(perspectiveFov) / 2)) / Math.tan(degToRad(ORTHO_REFERENCE_FOV_DEG) / 2)) < 1e-6,
  );

  // perspective -> ortho -> perspective returns to the original distance.
  const backToPerspective = (orthoRadius * Math.tan(degToRad(ORTHO_REFERENCE_FOV_DEG) / 2)) / Math.tan(degToRad(perspectiveFov) / 2);
  assert.ok(Math.abs(backToPerspective - 100) < 1e-6);
});

test('bakeOrthoZoomIntoRadius uses the frozen base radius when the camera drifted', () => {
  const { camera, target } = makeOrthoCamera(100, 1);
  // Simulate a SpaceMouse gesture: the frustum base was frozen at radius 100,
  // the camera drifted along the view axis, and zoom accumulated to 4.
  camera.position.set(0, 0, 80);
  camera.zoom = 4;
  camera.updateMatrixWorld();

  bakeOrthoZoomIntoRadius(camera, target, 1, 100);

  assert.ok(Math.abs(camera.position.distanceTo(target) - 25) < 1e-4);
  assert.ok(Math.abs(camera.top - orthoHalfHeightForRadius(25)) < 1e-4);
});

test('bakeOrthoZoomIntoRadius preserves the visible half-height', () => {
  const { camera, target } = makeOrthoCamera(100, 1);

  camera.zoom = 4;
  camera.updateProjectionMatrix();
  const visibleHalfHBefore = (camera.top - camera.bottom) / (2 * camera.zoom);

  bakeOrthoZoomIntoRadius(camera, target, 1);

  const visibleHalfHAfter = (camera.top - camera.bottom) / (2 * camera.zoom);
  assert.equal(camera.zoom, 1);
  assert.ok(Math.abs(visibleHalfHAfter - visibleHalfHBefore) < 1e-4);
  assert.ok(
    Math.abs(camera.top - orthoHalfHeightForRadius(25, ORTHO_REFERENCE_FOV_DEG)) < 1e-4,
  );
});
