import * as THREE from 'three';
import { applyOrthoFrustum, dollyOrthoToCursor } from './orthoDolly';

/**
 * The camera pose a wheel zoom is *asking* for.
 *
 * A wheel event used to dolly the camera on the spot: OrbitControls applies its
 * scale inside `update()`, and the orthographic path called `dollyOrthoToCursor`
 * directly. Both are one discrete step per event, so a mouse wheel — which sends
 * whole-number deltas — reads as a jump, while a damped drag glides. This is the
 * same split the trackpad gesture solved with a pose: the wheel accumulates into
 * a pose, and `WheelZoomPoseApplier` eases the camera onto it once per frame.
 *
 * The pose is not a queue of pending events. Each wheel event runs the dolly
 * maths against the *pose*, not the live camera: the camera lags behind by
 * design, so computing the next step from it would shrink every step that
 * followed while the camera was catching up. Running the maths on the pose keeps
 * the steps exactly as large as the user asked for, in the same way
 * `TrackpadGesturePose` keeps its orbit basis self-consistent while the camera
 * lags.
 */
export type WheelZoomPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** Orientation basis for the cursor ray; zoom never changes it. */
  up: THREE.Vector3;
};

/**
 * How long after the last wheel event the pose stays live.
 *
 * Long enough for the slowest camera-feel constant (70 ms) to leave a sub-pixel
 * residual: ~250 ms is 3.5 time constants, i.e. under 3% of the last step.
 */
export const WHEEL_ZOOM_POSE_RELEASE_MS = 250;

const EPSILON = 1e-6;

const _scratchPerspective = new THREE.PerspectiveCamera();
const _scratchOrtho = new THREE.OrthographicCamera();
const _dollyDirection = new THREE.Vector3();

export function createWheelZoomPose(): WheelZoomPose {
  return {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    up: new THREE.Vector3(0, 0, 1),
  };
}

/** Start from where the camera is now: a gesture always begins at the live view. */
export function seedWheelZoomPose(
  pose: WheelZoomPose,
  camera: THREE.Camera,
  target: THREE.Vector3,
): void {
  pose.position.copy(camera.position);
  pose.target.copy(target);
  pose.up.copy(camera.up).normalize();
}

/**
 * OrbitControls-compatible wheel scale for a perspective dolly: `0.95^zoomSpeed`
 * per 100 units of `deltaY`, the same expression as `getZoomScale()`.
 * A multiplier below 1 dollies in.
 */
export function perspectiveWheelRadiusScale(deltaY: number, zoomSpeed: number): number {
  if (deltaY === 0) return 1;
  const step = Math.pow(0.95, Math.max(EPSILON, zoomSpeed) * Math.abs(deltaY) * 0.01);
  return deltaY < 0 ? step : 1 / step;
}

export type WheelZoomPoseParams = {
  projection: 'perspective' | 'orthographic';
  /** Cursor position in normalised device coordinates (-1..1). */
  ndcX: number;
  ndcY: number;
  /** Multiplier applied to the radius; <1 zooms in. */
  radiusScale: number;
  minRadius: number;
  maxRadius: number;
  aspect: number;
  fovDeg: number;
  /** Ortho only: the scene radius tightens the symmetric depth range. */
  sceneRadius?: number;
};

/**
 * Fold one wheel event into the pose the user is asking for, anchored at the
 * cursor. Perspective reproduces OrbitControls' `zoomToCursor` step (the camera
 * slides down the pointer ray); orthographic reuses the app's own
 * `dollyOrthoToCursor`, run against a scratch camera posed like the pose.
 */
export function applyWheelZoomToPose(pose: WheelZoomPose, params: WheelZoomPoseParams): void {
  const {
    projection,
    ndcX,
    ndcY,
    radiusScale,
    minRadius,
    maxRadius,
    aspect,
    fovDeg,
    sceneRadius,
  } = params;

  if (!Number.isFinite(radiusScale) || radiusScale <= 0 || radiusScale === 1) return;

  const radius = Math.max(EPSILON, pose.position.distanceTo(pose.target));

  if (projection === 'orthographic') {
    _scratchOrtho.position.copy(pose.position);
    _scratchOrtho.up.copy(pose.up);
    _scratchOrtho.lookAt(pose.target);
    applyOrthoFrustum(_scratchOrtho, radius, aspect, { fovDeg, sceneRadius });
    _scratchOrtho.updateMatrixWorld();

    const nextTarget = dollyOrthoToCursor({
      camera: _scratchOrtho,
      target: pose.target,
      ndcX,
      ndcY,
      radiusScale,
      minRadius,
      maxRadius,
      aspect,
      options: { fovDeg, sceneRadius },
    });

    pose.position.copy(_scratchOrtho.position);
    pose.target.copy(nextTarget);
    return;
  }

  _scratchPerspective.position.copy(pose.position);
  _scratchPerspective.up.copy(pose.up);
  _scratchPerspective.fov = fovDeg;
  _scratchPerspective.aspect = aspect;
  _scratchPerspective.near = 0.005;
  _scratchPerspective.far = 50000;
  _scratchPerspective.lookAt(pose.target);
  _scratchPerspective.updateProjectionMatrix();
  _scratchPerspective.updateMatrixWorld();

  // The camera slides along the pointer ray, so the point under the cursor stays
  // put. `z = 1` is what OrbitControls' own `_dollyDirection` uses.
  _dollyDirection
    .set(ndcX, ndcY, 1)
    .unproject(_scratchPerspective)
    .sub(pose.position)
    .normalize();

  const nextRadius = THREE.MathUtils.clamp(radius * radiusScale, minRadius, maxRadius);
  pose.position.addScaledVector(_dollyDirection, radius - nextRadius);
}
