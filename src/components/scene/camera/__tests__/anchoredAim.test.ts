import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solveAnchoredAim } from '../anchoredAim';

const UP = new THREE.Vector3(0, 0, 1);

function makePerspective(eye: THREE.Vector3, target: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(50, 1.4, 0.005, 50000);
  camera.up.copy(UP);
  camera.position.copy(eye);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

function makeOrtho(eye: THREE.Vector3, target: THREE.Vector3) {
  const camera = new THREE.OrthographicCamera(-40, 40, 40 / 1.4, -40 / 1.4, -50000, 50000);
  const aspect = 1.4;
  camera.left = -40;
  camera.right = 40;
  camera.top = 40 / aspect;
  camera.bottom = -40 / aspect;
  camera.up.copy(UP);
  camera.position.copy(eye);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** The camera pose from a spherical position about the pivot. */
function placeOnOrbit(camera: THREE.Camera, pivot: THREE.Vector3, azimuth: number, polar: number, radius: number) {
  const sinPolar = Math.sin(polar);
  camera.position.set(
    pivot.x + Math.cos(azimuth) * sinPolar * radius,
    pivot.y + Math.sin(azimuth) * sinPolar * radius,
    pivot.z + Math.cos(polar) * radius,
  );
  camera.updateMatrixWorld();
}

const CAMERAS = [
  ['perspective', makePerspective],
  ['orthographic', makeOrtho],
] as const;

const aim = new THREE.Quaternion();

describe('anchored aim', () => {
  for (const [name, make] of CAMERAS) {
    it(`${name}: solving for the pixel a target already occupies keeps the pose`, () => {
      const pivot = new THREE.Vector3(8, -6, 20);
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const anchor = pivot.clone().project(camera);

      const before = camera.quaternion.clone();
      assert.equal(solveAnchoredAim(camera, pivot, new THREE.Vector2(anchor.x, anchor.y), aim), true);
      assert.ok(Math.abs(before.dot(aim)) > 1 - 1e-6, 'pose should be reproduced');
    });

    it(`${name}: the pivot keeps its pixel through the whole orbit`, () => {
      const pivot = new THREE.Vector3(8, -6, 20);
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const projected = pivot.clone().project(camera);
      const anchor = new THREE.Vector2(projected.x, projected.y);
      const radius = camera.position.distanceTo(pivot);

      for (const [azimuth, polar] of [[0.6, 0.5], [-2.2, 1.1], [2.9, 0.12], [-0.4, Math.PI - 0.12]]) {
        placeOnOrbit(camera, pivot, azimuth, polar, radius);
        assert.equal(solveAnchoredAim(camera, pivot, anchor, aim), true);
        camera.quaternion.copy(aim);
        camera.updateMatrixWorld();

        const now = pivot.clone().project(camera);
        assert.ok(Math.abs(now.x - anchor.x) < 1e-4, `x at ${azimuth},${polar}: ${now.x} != ${anchor.x}`);
        assert.ok(Math.abs(now.y - anchor.y) < 1e-4, `y at ${azimuth},${polar}: ${now.y} != ${anchor.y}`);
      }
    });

    it(`${name}: the horizon stays level`, () => {
      const pivot = new THREE.Vector3(8, -6, 20);
      const camera = make(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
      const anchor = new THREE.Vector2(0.4, -0.3);

      placeOnOrbit(camera, pivot, 1.3, 0.7, camera.position.distanceTo(pivot));
      assert.equal(solveAnchoredAim(camera, pivot, anchor, aim), true);
      camera.quaternion.copy(aim);
      camera.updateMatrixWorld();

      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      assert.ok(Math.abs(right.dot(UP)) < 1e-6, `right axis tilted: ${right.dot(UP)}`);
    });
  }

  it('stays upright as the orbit approaches and circles the pole', () => {
    const pivot = new THREE.Vector3(8, -6, 20);
    const camera = makePerspective(new THREE.Vector3(40, -70, 55), new THREE.Vector3(0, 0, 10));
    const projected = pivot.clone().project(camera);
    const anchor = new THREE.Vector2(projected.x, projected.y);
    const radius = camera.position.distanceTo(pivot);
    const screenUp = new THREE.Vector3();

    // Both roots of the level condition are level poses; one of them is the view
    // upside down. Keeping the upright one is the whole point.
    // The clamp in `PivotOrbitControls` keeps the orbit outside the zone where
    // the level roll's sign is decided by noise; this pins what holds inside it.
    for (let phi = 0.6; phi > 0.24; phi -= 0.02) {
      for (const azimuth of [-2.1, 0.4, 1.7]) {
        placeOnOrbit(camera, pivot, azimuth, phi, radius);
        assert.equal(solveAnchoredAim(camera, pivot, anchor, aim), true, `phi ${phi}`);
        camera.quaternion.copy(aim);
        camera.updateMatrixWorld();

        screenUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        assert.ok(screenUp.dot(UP) > 0, `upside down at phi ${phi}, azimuth ${azimuth}`);

        const now = pivot.clone().project(camera);
        assert.ok(Math.abs(now.x - anchor.x) < 1e-4 && Math.abs(now.y - anchor.y) < 1e-4, `pixel at ${phi}`);
      }
    }
  });

  it('refuses the degenerate case: the pivot straight along the up axis', () => {
    const pivot = new THREE.Vector3(0, 0, 0);
    const camera = makePerspective(new THREE.Vector3(0, 0, 60), new THREE.Vector3(0, 0, 0));
    assert.equal(solveAnchoredAim(camera, pivot, new THREE.Vector2(0.5, 0), aim), false);
  });
});
