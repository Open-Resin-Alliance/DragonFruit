import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyWheelZoomToPose,
  createWheelZoomPose,
  perspectiveWheelRadiusScale,
  seedWheelZoomPose,
} from '../wheelZoomPose';

function poseFor(position: [number, number, number], target: [number, number, number]) {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.005, 50000);
  camera.position.set(...position);
  camera.lookAt(new THREE.Vector3(...target));
  camera.updateMatrixWorld();
  const targetPoint = new THREE.Vector3(...target);
  const pose = createWheelZoomPose();
  seedWheelZoomPose(pose, camera, targetPoint);
  return { pose, target: targetPoint, camera };
}

describe('wheel zoom pose', () => {
  it('scales the radius and leaves the target alone in perspective', () => {
    const { pose, target } = poseFor([0, 0, 10], [0, 0, 0]);
    const before = pose.position.distanceTo(target);

    // A cursor on the view axis is the case where the dolly is pure radius: the
    // ray runs through the target, so the distance scales exactly.
    applyWheelZoomToPose(pose, {
      projection: 'perspective',
      ndcX: 0,
      ndcY: 0,
      radiusScale: 0.8,
      minRadius: 0,
      maxRadius: Infinity,
      aspect: 1,
      fovDeg: 50,
    });

    assert.ok(Math.abs(pose.position.distanceTo(target) - before * 0.8) < 1e-6);
    assert.deepEqual(pose.target.toArray(), target.toArray());
  });

  it('slides the perspective camera down the pointer ray, cursor anchored', () => {
    const { pose, target, camera } = poseFor([0, 0, 10], [0, 0, 0]);
    // The world point under the cursor, on the same ray OrbitControls uses.
    const anchored = new THREE.Vector3(0.35, -0.2, 1).unproject(camera);

    const radiusBefore = pose.position.distanceTo(target);
    applyWheelZoomToPose(pose, {
      projection: 'perspective',
      ndcX: 0.35,
      ndcY: -0.2,
      radiusScale: 0.8,
      minRadius: 0,
      maxRadius: Infinity,
      aspect: 1,
      fovDeg: 50,
    });

    // The camera moved *along* the cursor ray: the offset is parallel to it, so
    // the anchored point still projects under the cursor.
    const travel = pose.position.clone().sub(camera.position);
    const ray = anchored.clone().sub(camera.position).normalize();
    const along = travel.clone().normalize().dot(ray);
    assert.ok(along > 0.999, `travel should follow the ray, got ${along}`);
    assert.ok(Math.abs(travel.length() - (radiusBefore - radiusBefore * 0.8)) < 1e-6);
  });

  it('dollies straight in on the target when cursor zooming is off', () => {
    // A cursor-mode pivot owns the target, so the wheel must not drag it toward
    // the pointer: the camera slides along its own view axis instead.
    for (const projection of ['perspective', 'orthographic'] as const) {
      const { pose, target } = poseFor([12, -6, 9], [1, 2, 3]);
      const before = pose.position.clone();
      const radiusBefore = before.distanceTo(target);

      applyWheelZoomToPose(pose, {
        projection,
        ndcX: 0.5,
        ndcY: -0.4,
        radiusScale: 0.75,
        minRadius: 0.5,
        maxRadius: 200000,
        aspect: 1.3,
        fovDeg: 50,
        zoomToCursor: false,
      });

      assert.deepEqual(pose.target.toArray(), target.toArray(), `${projection} moved the target`);
      assert.ok(Math.abs(pose.position.distanceTo(target) - radiusBefore * 0.75) < 1e-6, `${projection} radius`);
      const travel = pose.position.clone().sub(before).normalize();
      const view = target.clone().sub(before).normalize();
      assert.ok(travel.dot(view) > 0.999, `${projection} travel should follow the view axis, got ${travel.dot(view)}`);
    }
  });

  it('keeps the cursor point fixed in orthographic', () => {
    const { pose } = poseFor([0, 0, 10], [0, 0, 0]);
    const fovDeg = 50;
    const aspect = 1.2;
    const ndcX = 0.4;
    const ndcY = -0.25;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5) * 10;
    const anchored = new THREE.Vector3(
      ndcX * halfHeight * aspect,
      ndcY * halfHeight,
      0,
    );

    applyWheelZoomToPose(pose, {
      projection: 'orthographic',
      ndcX,
      ndcY,
      radiusScale: 0.7,
      minRadius: 0.5,
      maxRadius: 200000,
      aspect,
      fovDeg,
    });

    // Project the anchored point through the posed camera and expect the input
    // NDC back: that is what "the point under the cursor stays put" means.
    const camera = new THREE.OrthographicCamera();
    camera.position.copy(pose.position);
    camera.up.copy(pose.up);
    camera.lookAt(pose.target);
    const radius = pose.position.distanceTo(pose.target);
    const nextHalfHeight = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5) * radius;
    camera.left = -nextHalfHeight * aspect;
    camera.right = nextHalfHeight * aspect;
    camera.top = nextHalfHeight;
    camera.bottom = -nextHalfHeight;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const projected = anchored.clone().project(camera);
    assert.ok(Math.abs(projected.x - ndcX) < 1e-6, `x ${projected.x} != ${ndcX}`);
    assert.ok(Math.abs(projected.y - ndcY) < 1e-6, `y ${projected.y} != ${ndcY}`);
    assert.ok(Math.abs(radius - 7) < 1e-6);
    // The pivot is re-seated in front of the moved camera, so it picks up the
    // lateral slide; the view direction is what stays put.
    const direction = pose.position.clone().sub(pose.target).normalize();
    assert.ok(Math.abs(direction.x) < 1e-6 && Math.abs(direction.y) < 1e-6);
    assert.ok(direction.z > 0.999);
  });

  it('composes repeated steps into one combined step', () => {
    const stepped = poseFor([0, 0, 12], [0, 0, 0]);
    const combined = poseFor([0, 0, 12], [0, 0, 0]);

    for (let i = 0; i < 3; i += 1) {
      applyWheelZoomToPose(stepped.pose, {
        projection: 'perspective',
        ndcX: 0,
        ndcY: 0,
        radiusScale: 0.9,
        minRadius: 0,
        maxRadius: Infinity,
        aspect: 1,
        fovDeg: 50,
      });
    }
    applyWheelZoomToPose(combined.pose, {
      projection: 'perspective',
      ndcX: 0,
      ndcY: 0,
      radiusScale: 0.9 * 0.9 * 0.9,
      minRadius: 0,
      maxRadius: Infinity,
      aspect: 1,
      fovDeg: 50,
    });

    assert.ok(
      Math.abs(
        stepped.pose.position.distanceTo(stepped.target)
        - combined.pose.position.distanceTo(combined.target),
      ) < 1e-6,
    );
  });

  it('derives the radius scale from the OrbitControls formula', () => {
    // getZoomScale(): 0.95^(zoomSpeed · |deltaY| / 100), inverted to zoom out.
    assert.ok(Math.abs(perspectiveWheelRadiusScale(-100, 1.45) - Math.pow(0.95, 1.45)) < 1e-12);
    assert.ok(Math.abs(perspectiveWheelRadiusScale(100, 1.45) - 1 / Math.pow(0.95, 1.45)) < 1e-12);
    assert.equal(perspectiveWheelRadiusScale(0, 1.45), 1);
  });
});
