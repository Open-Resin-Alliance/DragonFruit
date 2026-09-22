import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  ORTHO_DEPTH_MARGIN,
  ORTHO_FAR,
  ORTHO_NEAR,
  ORTHO_REFERENCE_FOV_DEG,
  applyOrthoFrustum,
  dollyOrthoToCursor,
  ORTHO_VIEW_TURN_RAD,
  orthoAspectOf,
  orthoFitRadiusForScene,
  orthoHalfHeightForRadius,
  orthoWheelRadiusScale,
  resolveOrthoNavRadius,
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

test('resolveOrthoNavRadius re-fits the scene on a pure distance jump (fit)', () => {
  const next = resolveOrthoNavRadius({
    currentRadius: 100,
    prevAxial: -100,
    axial: -20,
    hasPrevious: true,
    turn: 0,
    eyeJump: 80,
    sceneRadius: 300,
  });
  assert.ok(Math.abs(next - orthoFitRadiusForScene(300)) < 1e-9);
});

test('resolveOrthoNavRadius keeps the zoom on a fit with no scene radius', () => {
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

test('orthoFitRadiusForScene frames the sphere for the reference FOV', () => {
  const radius = orthoFitRadiusForScene(200);
  assert.ok(Math.abs(radius - (200 * 1.05) / Math.tan(degToRad(ORTHO_REFERENCE_FOV_DEG) / 2)) < 1e-9);
});


