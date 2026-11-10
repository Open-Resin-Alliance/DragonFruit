import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyPivotOrbitState,
  createPivotOrbitState,
  orbitPivotBy,
} from '../pivotOrbit';

const UP = new THREE.Vector3(0, 0, 1);

function makePerspective(position: THREE.Vector3, lookAt: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(50, 1.4, 0.005, 50000);
  camera.up.copy(UP);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  return camera;
}

function makeOrtho(position: THREE.Vector3, lookAt: THREE.Vector3) {
  const camera = new THREE.OrthographicCamera(-40, 40, 40 / 1.4, -40 / 1.4, -50000, 50000);
  camera.up.copy(UP);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  return camera;
}

function poseOf(camera: THREE.Camera) {
  return { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
}

describe('pivot orbit', () => {
  for (const [name, make] of [['perspective', makePerspective], ['orthographic', makeOrtho]] as const) {
    it(`${name}: picking the pivot changes nothing`, () => {
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const pivot = new THREE.Vector3(8, -6, 20);

      const before = poseOf(camera);
      const state = createPivotOrbitState(camera, pivot);
      applyPivotOrbitState(state, camera);
      const after = poseOf(camera);

      assert.ok(after.position.distanceTo(before.position) < 1e-6, 'position moved');
      assert.ok(Math.abs(after.quaternion.dot(before.quaternion)) > 1 - 1e-6, 'aim moved');
    });

    it(`${name}: the pivot keeps its pixel through the whole orbit`, () => {
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const pivot = new THREE.Vector3(8, -6, 20);
      const state = createPivotOrbitState(camera, pivot);
      applyPivotOrbitState(state, camera);
      const anchored = pivot.clone().project(camera);

      // Pitch well past horizontal and around, the case that used to slide the
      // pivot up the screen.
      for (const [dx, dy] of [[0, 120], [160, 90], [-220, -60], [0, 400]]) {
        orbitPivotBy(state, dx, dy, 900, 1);
        applyPivotOrbitState(state, camera);

        const projected = pivot.clone().project(camera);
        assert.ok(Math.abs(anchored.x - projected.x) < 1e-4, `x after ${dx},${dy}: ${anchored.x} != ${projected.x}`);
        assert.ok(Math.abs(anchored.y - projected.y) < 1e-4, `y after ${dx},${dy}: ${anchored.y} != ${projected.y}`);
        assert.ok(Math.abs(camera.position.distanceTo(pivot) - state.radius) < 1e-5, 'orbit radius');
      }
    });

    it(`${name}: the horizon stays level and the camera does not aim at the pivot`, () => {
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const pivot = new THREE.Vector3(8, -6, 20);
      const state = createPivotOrbitState(camera, pivot);

      orbitPivotBy(state, 90, 160, 900, 1);
      applyPivotOrbitState(state, camera);

      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      assert.ok(Math.abs(right.z) < 1e-5, `right axis tilted: z=${right.z}`);

      const view = state.pivotNdc.clone();
      assert.ok(Math.abs(view.x) > 1e-4 || Math.abs(view.y) > 1e-4, 'pivot should be off the view axis');
    });
  }

  it('reads deltas from the gesture start, not from the last sample', () => {
    const camera = makePerspective(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
    const pivot = new THREE.Vector3(1, 0, 0);

    // The controller resets the angles to the gesture start before each sample,
    // so two samples must land where one call with the last delta lands.
    const absolute = createPivotOrbitState(camera, pivot);
    const absoluteCamera = camera.clone();
    const absoluteSample = { ...absolute };
    orbitPivotBy(absoluteSample, 180, 140, 800, 1);
    absolute.azimuth = absoluteSample.azimuth;
    absolute.polar = absoluteSample.polar;
    applyPivotOrbitState(absolute, absoluteCamera);

    const sampled = createPivotOrbitState(camera, pivot);
    const sampledCamera = camera.clone();
    const seed = { azimuth: sampled.azimuth, polar: sampled.polar };
    for (const [dx, dy] of [[140, 120], [90, 20], [180, 140]]) {
      sampled.azimuth = seed.azimuth;
      sampled.polar = seed.polar;
      orbitPivotBy(sampled, dx, dy, 800, 1);
    }
    applyPivotOrbitState(sampled, sampledCamera);

    assert.ok(absoluteCamera.position.distanceTo(sampledCamera.position) < 1e-6);
  });

  it('clamps before the poles', () => {
    const camera = makePerspective(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
    const state = createPivotOrbitState(camera, new THREE.Vector3(1, 0, 0));

    orbitPivotBy(state, 0, 5000, 800, 1);
    assert.ok(state.polar >= 0.08);
    orbitPivotBy(state, 0, -5000, 800, 1);
    assert.ok(state.polar <= Math.PI - 0.08);
  });
});
