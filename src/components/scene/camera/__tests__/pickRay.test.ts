import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { applyOrthoFrustum } from '../orthoDolly';
import { extendPickRayToNearPlane, setPickRayFromCamera } from '../pickRay';

function orthoCameraAt(distance: number) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  camera.position.set(0, 0, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  applyOrthoFrustum(camera, 60, 1, { sceneRadius: 300 });
  camera.updateMatrixWorld();
  return camera;
}

function planeAt(z: number) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.position.set(0, 0, z);
  mesh.updateMatrixWorld();
  return mesh;
}

test('an ortho pick ray reaches a surface the camera has dollied past', () => {
  const camera = orthoCameraAt(5);
  const surface = planeAt(8); // 3 mm behind the camera's own plane
  const ndc = new THREE.Vector2(0, 0);

  // It is on screen: the symmetric depth range keeps it inside the frustum.
  const projected = surface.position.clone().project(camera);
  assert.ok(Math.abs(projected.z) <= 1, 'the surface has to be inside the depth range to be drawn');

  // Stock three cannot reach it. This is the bug the helper exists for: the
  // origin lands on the camera's own plane and the ray only walks forward.
  const plain = new THREE.Raycaster();
  plain.setFromCamera(ndc, camera);
  assert.equal(plain.intersectObject(surface).length, 0);

  const corrected = new THREE.Raycaster();
  setPickRayFromCamera(corrected, ndc, camera);
  assert.ok(corrected.intersectObject(surface).length > 0, 'the corrected ray has to reach it');
});

test('the corrected ortho ray is the same line, only starting further back', () => {
  const ndc = new THREE.Vector2(0.3, -0.2);
  const camera = orthoCameraAt(40);

  const plain = new THREE.Raycaster();
  plain.setFromCamera(ndc, camera);

  const corrected = new THREE.Raycaster();
  setPickRayFromCamera(corrected, ndc, camera);

  const offset = corrected.ray.origin.clone().sub(plain.ray.origin);
  const alongRay = offset.clone().addScaledVector(corrected.ray.direction, -offset.dot(corrected.ray.direction));
  assert.ok(alongRay.length() < 1e-6, 'the origin may only move along the ray');
  assert.ok(corrected.ray.direction.distanceTo(plain.ray.direction) < 1e-9);

  // Same line where it matters: any point in front of the plain origin is on
  // the corrected ray too, at the same distance along it. (A point *behind* the
  // plain origin is unreachable by it — a ray is a half line — which is exactly
  // the gap this helper closes.)
  const forward = plain.ray.at(50, new THREE.Vector3());
  assert.ok(corrected.ray.distanceSqToPoint(forward) < 1e-9);
  assert.ok(Math.abs(corrected.ray.direction.dot(forward.clone().sub(corrected.ray.origin)) - (50 + offset.length())) < 1e-6);
});

test('the correction leaves cameras that do not draw behind themselves alone', () => {
  const origin = new THREE.Vector3(1, 2, 3);

  const perspective = new THREE.PerspectiveCamera(56, 1, 0.005, 50000);
  const perspectiveRay = new THREE.Ray(origin.clone(), new THREE.Vector3(0, 0, -1));
  extendPickRayToNearPlane(perspectiveRay, perspective);
  assert.ok(perspectiveRay.origin.distanceTo(origin) < 1e-9);

  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.005, 2000);
  const orthoRay = new THREE.Ray(origin.clone(), new THREE.Vector3(0, 0, -1));
  extendPickRayToNearPlane(orthoRay, ortho);
  assert.ok(orthoRay.origin.distanceTo(origin) < 1e-9, 'a camera that clips in front needs no correction');
});
