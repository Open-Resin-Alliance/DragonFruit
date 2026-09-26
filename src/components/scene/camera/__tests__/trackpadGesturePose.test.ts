import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  applyTrackpadOrbitToPose,
  applyTrackpadPanToPose,
  blendCameraTowardTrackpadPose,
  createTrackpadGesturePose,
  seedTrackpadGesturePose,
  trackpadPoseBlendFactor,
  type TrackpadGesturePose,
} from '../trackpadGesturePose';
import { TRACKPAD_SCROLL } from '../../__tests__/wheelCaptures.fixture';

const FRAME_MS = 1000 / 60;
const VIEWPORT_HEIGHT_PX = 900;
const ACCELERATION = 2;

/** The app's Z-up world, looking down at the build plate from a tilted angle. */
function makeScene(): {
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  pose: TrackpadGesturePose;
} {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.005, 50000);
  camera.up.set(0, 0, 1);
  camera.position.set(30, 40, 50);
  const target = new THREE.Vector3(0, 0, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();

  const pose = createTrackpadGesturePose();
  seedTrackpadGesturePose(pose, camera, target);
  return { camera, target, pose };
}

function polarOf(pose: TrackpadGesturePose): number {
  const offset = pose.position.clone().sub(pose.target).normalize();
  return Math.acos(THREE.MathUtils.clamp(offset.dot(pose.up), -1, 1));
}

test('blend factor snaps when there is no time constant to blend over', () => {
  assert.equal(trackpadPoseBlendFactor(FRAME_MS, 0), 1, 'raw preset applies the pose outright');
  assert.equal(trackpadPoseBlendFactor(FRAME_MS, -5), 1);
  assert.equal(trackpadPoseBlendFactor(0, 70), 1, 'a zero-length frame must not divide by zero');
  assert.equal(trackpadPoseBlendFactor(Number.NaN, 70), 1);
});

test('blend factor is an exponential approach, not a fixed step', () => {
  const halfLifeMs = 70 * Math.LN2;
  assert.ok(Math.abs(trackpadPoseBlendFactor(halfLifeMs, 70) - 0.5) < 1e-12);
  assert.ok(trackpadPoseBlendFactor(FRAME_MS, 70) > trackpadPoseBlendFactor(FRAME_MS, 140));
  assert.equal(trackpadPoseBlendFactor(10_000, 70), 1, 'a long frame is a snap, not an overshoot');
});

test('the same elapsed time moves the camera the same distance at any frame rate', () => {
  const oneBigFrame = 4 * FRAME_MS;
  const step = (deltaMs: number, steps: number) => {
    const { camera, target, pose } = makeScene();
    pose.position.x += 100;
    pose.target.x += 100;
    for (let i = 0; i < steps; i += 1) {
      blendCameraTowardTrackpadPose(pose, camera, target, trackpadPoseBlendFactor(deltaMs, 70), false);
    }
    return 100 - camera.position.x;
  };

  assert.ok(Math.abs(step(oneBigFrame, 1) - step(FRAME_MS, 4)) < 1e-9);
});

test('the raw preset lands on the pose exactly, and blending converges without overshoot', () => {
  const { camera, target, pose } = makeScene();
  pose.position.set(11, 12, 13);
  pose.target.set(1, 2, 3);

  blendCameraTowardTrackpadPose(pose, camera, target, trackpadPoseBlendFactor(FRAME_MS, 0), false);
  assert.deepEqual(camera.position.toArray(), pose.position.toArray());
  assert.deepEqual(target.toArray(), pose.target.toArray());

  const { camera: eased, target: easedTarget, pose: easedPose } = makeScene();
  easedPose.position.set(11, 12, 13);
  easedPose.target.set(1, 2, 3);
  const start = eased.position.distanceTo(easedPose.position);
  let previous = start;
  for (let i = 0; i < 600; i += 1) {
    blendCameraTowardTrackpadPose(easedPose, eased, easedTarget, trackpadPoseBlendFactor(FRAME_MS, 70), false);
    const remaining = eased.position.distanceTo(easedPose.position);
    assert.ok(remaining <= previous + 1e-12, 'an exponential approach never backs off from the pose');
    previous = remaining;
  }
  assert.ok(previous < start * 0.001, '5 s of frames at tau 70 ms is fully converged');
});

test('pan replays the recorded trackpad scroll as one translation of position and target', () => {
  const { camera, pose } = makeScene();
  const seededPosition = pose.position.clone();
  const seededTarget = pose.target.clone();
  const seededQuaternion = pose.quaternion.clone();
  const radius = pose.position.distanceTo(pose.target);

  for (const [, dx, dy] of TRACKPAD_SCROLL) {
    assert.equal(applyTrackpadPanToPose(pose, camera, dx, dy, VIEWPORT_HEIGHT_PX, ACCELERATION), true);
  }

  const poseShift = pose.position.clone().sub(seededPosition);
  const targetShift = pose.target.clone().sub(seededTarget);
  assert.ok(poseShift.distanceTo(targetShift) < 1e-9, 'the orbit pivot travels with the camera');
  assert.ok(!Number.isFinite(poseShift.x) || Math.abs(pose.position.distanceTo(pose.target) - radius) < 1e-9);
  assert.deepEqual(pose.quaternion.toArray(), seededQuaternion.toArray(), 'pan never re-orients');

  // Screen-space pan, in the camera basis: +deltaX moves along +X screen,
  // -deltaY moves up the screen. Folding the whole capture equals folding the
  // summed deltas, because the basis never changes during a pan.
  const worldUnitsPerPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * radius) / VIEWPORT_HEIGHT_PX;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(seededQuaternion).normalize();
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(seededQuaternion).normalize();
  const sumX = TRACKPAD_SCROLL.reduce((total, [, dx]) => total + dx, 0);
  const sumY = TRACKPAD_SCROLL.reduce((total, [, , dy]) => total + dy, 0);
  const expected = new THREE.Vector3()
    .addScaledVector(right, sumX * worldUnitsPerPixel * ACCELERATION)
    .addScaledVector(cameraUp, -sumY * worldUnitsPerPixel * ACCELERATION);
  assert.ok(poseShift.distanceTo(expected) < 1e-6, `expected ${expected.toArray()}, got ${poseShift.toArray()}`);
});

test('pan refuses camera types it has no scale for', () => {
  const { pose } = makeScene();
  const cube = new THREE.Object3D();
  assert.equal(applyTrackpadPanToPose(pose, cube as unknown as THREE.Camera, 1, 1, VIEWPORT_HEIGHT_PX, 1), false);
});

test('orthographic pan scales with the derived frustum, not the camera distance', () => {
  const makeOrthoPose = (zoom: number, distance: number) => {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -50000, 50000);
    camera.up.set(0, 0, 1);
    camera.zoom = zoom;
    // Tilted, because looking straight down the up axis makes `lookAt` fall
    // back to a nudged basis and the screen directions stop being meaningful.
    camera.position.set(30, 40, distance);
    const target = new THREE.Vector3(0, 0, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const pose = createTrackpadGesturePose();
    seedTrackpadGesturePose(pose, camera, target);
    return { camera, target, pose };
  };

  const viewportHeight = 1000;
  const { camera, target, pose } = makeOrthoPose(1, 300);
  const seeded = pose.position.clone();
  assert.equal(applyTrackpadPanToPose(pose, camera, 0, -viewportHeight, viewportHeight, 1), true);

  const shift = pose.position.clone().sub(seeded);
  // The frustum spans 200 mm over 1000 px, so a full-height drag is 200 mm.
  assert.ok(Math.abs(shift.length() - 200) < 1e-9, `expected 200 mm, got ${shift.length()}`);
  const viewDirection = target.clone().sub(camera.position).normalize();
  assert.ok(Math.abs(shift.dot(viewDirection)) < 1e-9, 'an ortho pan slides within the screen plane');

  // The invented distance is not the scale: only the frustum is. The same
  // frustum at twice the zoom is half the world per pixel, whatever the camera
  // distance — which is why this path reads `camera.top`/`bottom`, not `fov`.
  const zoomed = makeOrthoPose(2, 8000);
  const zoomedSeed = zoomed.pose.position.clone();
  applyTrackpadPanToPose(zoomed.pose, zoomed.camera, 0, -viewportHeight, viewportHeight, 1);
  assert.ok(
    Math.abs(zoomed.pose.position.distanceTo(zoomedSeed) - 100) < 1e-9,
    `expected 100 mm at zoom 2, got ${zoomed.pose.position.distanceTo(zoomedSeed)}`,
  );
});

test('orbit holds the radius and keeps the polar angle off the poles', () => {
  const { pose } = makeScene();
  const radius = pose.position.distanceTo(pose.target);

  for (const [, dx, dy] of TRACKPAD_SCROLL) {
    applyTrackpadOrbitToPose(pose, dx, dy, ACCELERATION);
    assert.ok(Math.abs(pose.position.distanceTo(pose.target) - radius) < 1e-9, 'an orbit never dollies');
    const polar = polarOf(pose);
    assert.ok(polar >= 0.08 - 1e-9 && polar <= Math.PI - 0.08 + 1e-9, `polar ${polar} left the clamp`);
  }
});

test('orbit yaw is the summed horizontal gesture, about the world up axis', () => {
  const { pose } = makeScene();
  const rotateScale = 0.0022 * ACCELERATION;
  const seedOffset = pose.position.clone().sub(pose.target);
  const sumX = 240;
  for (let i = 0; i < sumX; i += 4) {
    applyTrackpadOrbitToPose(pose, 4, 0, ACCELERATION);
  }

  // No pitch is involved, so the composition is exactly one rotation of the
  // offset the gesture started from.
  const yaw = new THREE.Quaternion().setFromAxisAngle(pose.up, sumX * rotateScale);
  const expected = seedOffset.clone().applyQuaternion(yaw).add(pose.target);
  assert.ok(pose.position.distanceTo(expected) < 1e-9, `expected ${expected.toArray()}, got ${pose.position.toArray()}`);
});

test('orbit pitch is the summed vertical gesture, between the polar clamps', () => {
  const { pose } = makeScene();
  const startPolar = polarOf(pose);
  const rotateScale = 0.0022 * ACCELERATION;
  const sumY = 200;
  for (let i = 0; i < sumY; i += 8) {
    applyTrackpadOrbitToPose(pose, 0, 8, ACCELERATION);
  }

  assert.ok(Math.abs(polarOf(pose) - (startPolar + sumY * rotateScale)) < 1e-9);

  // Pushing straight past the pole clamps instead of spinning.
  for (let i = 0; i < 2000; i += 10) {
    applyTrackpadOrbitToPose(pose, 0, -10, ACCELERATION);
  }
  assert.ok(Math.abs(polarOf(pose) - 0.08) < 1e-9);
  assert.ok(Number.isFinite(pose.position.x) && Number.isFinite(pose.position.y) && Number.isFinite(pose.position.z));
});

test('the app home view is exactly at the pole and still orbits without spinning in place', () => {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.005, 50000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 120);
  const target = new THREE.Vector3(0, 0, 0);
  camera.lookAt(target);
  const pose = createTrackpadGesturePose();
  seedTrackpadGesturePose(pose, camera, target);

  assert.ok(Math.abs(polarOf(pose)) < 1e-9, 'seeded at the pole');

  applyTrackpadOrbitToPose(pose, 60, 30, ACCELERATION);
  assert.ok(Number.isFinite(pose.position.x) && Number.isFinite(pose.position.y) && Number.isFinite(pose.position.z));
  assert.ok(polarOf(pose) >= 0.08 - 1e-9, 'the pitch clamp carried the view off the undefined pole');
  assert.ok(Math.abs(pose.position.distanceTo(pose.target) - 120) < 1e-9);
});

test('easing the camera is what removes the per-event stepping, and loses no travel', () => {
  const run = (tauMs: number) => {
    const { camera, target, pose } = makeScene();
    let previous = camera.position.clone();
    let maxFrameStep = 0;
    for (const [, dx, dy] of TRACKPAD_SCROLL) {
      applyTrackpadPanToPose(pose, camera, dx, dy, VIEWPORT_HEIGHT_PX, ACCELERATION);
      blendCameraTowardTrackpadPose(pose, camera, target, trackpadPoseBlendFactor(FRAME_MS, tauMs), false);
      maxFrameStep = Math.max(maxFrameStep, camera.position.distanceTo(previous));
      previous = camera.position.clone();
    }
    // The gesture ends and the app drops the pose; drain the remaining frames.
    for (let i = 0; i < 60; i += 1) {
      blendCameraTowardTrackpadPose(pose, camera, target, trackpadPoseBlendFactor(FRAME_MS, tauMs), false);
    }
    return { maxFrameStep, end: camera.position.clone() };
  };

  const raw = run(0);
  const eased = run(70);

  assert.ok(eased.maxFrameStep < raw.maxFrameStep, 'no frame spends the whole event delta any more');
  assert.ok(
    eased.end.distanceTo(raw.end) < raw.maxFrameStep * 0.1,
    `eased ${eased.end.toArray()} vs raw ${raw.end.toArray()} — the gesture must land in the same place`,
  );
});
