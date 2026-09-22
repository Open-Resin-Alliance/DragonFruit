import * as THREE from 'three';
import { DEFAULT_FOV_DEG } from '@/components/settings/cameraFovPreferences';

/**
 * Orthographic camera navigation.
 *
 * The ortho camera's apparent scale is set entirely by its frustum extents, so
 * the only way to make it behave like a real dolly is to *derive* the frustum
 * from a physical distance: `halfHeight = tan(fov/2) * radius`, where `radius`
 * is `|camera.position - target|`. Wheel/dolly changes the radius (the camera
 * actually moves); the frustum follows, so apparent size scales exactly like a
 * perspective dolly. `zoom` is pinned to 1 and is never the navigation state.
 *
 * The reference FOV is fixed at the default rather than the user's perspective
 * FOV, so the FOV slider never changes the orthographic scale (ADR-0032).
 */
export const ORTHO_REFERENCE_FOV_DEG = DEFAULT_FOV_DEG;

/**
 * Symmetric depth range. Orthographic cameras need a negative near so geometry
 * behind the camera's position stays visible; ±50000 at 24-bit depth is
 * ~0.006 mm resolution across the scene's 100–600 mm working volume.
 */
export const ORTHO_NEAR = -50000;
export const ORTHO_FAR = 50000;

/** Bounds on the dolly radius, so the wheel cannot collapse or run away. */
export const ORTHO_MIN_RADIUS = 0.5;
export const ORTHO_MAX_RADIUS = 200000;

const EPSILON = 1e-6;

export function orthoRadius(camera: THREE.OrthographicCamera, target: THREE.Vector3): number {
  return Math.max(EPSILON, camera.position.distanceTo(target));
}

export function orthoHalfHeightForRadius(radius: number, fovDeg = ORTHO_REFERENCE_FOV_DEG): number {
  return Math.max(
    EPSILON,
    Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5) * Math.max(EPSILON, radius),
  );
}

/**
 * Recompute the frustum from the current radius. Returns the radius used.
 * Call after anything that changes `camera.position` or the orbit target.
 */
export function syncOrthoFrustum(
  camera: THREE.OrthographicCamera,
  target: THREE.Vector3,
  aspect: number,
  fovDeg = ORTHO_REFERENCE_FOV_DEG,
): number {
  const radius = orthoRadius(camera, target);
  const halfH = orthoHalfHeightForRadius(radius, fovDeg);
  const halfW = halfH * Math.max(EPSILON, aspect);

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.zoom = 1;
  camera.near = ORTHO_NEAR;
  camera.far = ORTHO_FAR;
  camera.updateProjectionMatrix();
  return radius;
}

/**
 * The ortho radius that reproduces a perspective view's apparent size.
 *
 * Ortho derives from the fixed reference FOV while perspective uses the user's
 * FOV, so switching projections at the same distance would change the framing —
 * and because the return trip solves distance, every round trip would compound
 * that error. Scaling the radius by `tan(perspFov/2) / tan(refFov/2)` makes the
 * switch preserve apparent size, so the round trip is the identity.
 */
export function orthoRadiusForPerspectiveFraming(
  radius: number,
  perspectiveFovDeg: number,
  orthoFovDeg = ORTHO_REFERENCE_FOV_DEG,
): number {
  const perspectiveTan = Math.tan(THREE.MathUtils.degToRad(perspectiveFovDeg) * 0.5);
  const orthoTan = Math.tan(THREE.MathUtils.degToRad(orthoFovDeg) * 0.5);
  return (perspectiveTan * Math.max(EPSILON, radius)) / Math.max(EPSILON, orthoTan);
}

/**
 * OrbitControls-compatible wheel scale. Mirrors `getZoomScale()` =
 * `0.95^zoomSpeed`; returns a multiplier applied to the radius (<1 zooms in).
 */
export function orthoWheelRadiusScale(deltaY: number, zoomSpeed: number): number {
  const step = Math.pow(0.95, Math.max(EPSILON, zoomSpeed));
  return deltaY < 0 ? step : 1 / step;
}

/**
 * Bake an explicit `camera.zoom` into the radius and return to the derived
 * frustum. The SpaceMouse paths drive `zoom` directly while they hold the
 * camera; on hand-back this converts that accumulated zoom into the equivalent
 * radius so the derived frustum matches the last visible scale.
 *
 * `baseRadius` is the radius the frustum was derived from when the SpaceMouse
 * took over. Its `zoom` is relative to that frozen base — the camera's live
 * position may have drifted along the view axis during the gesture — so pass it
 * whenever it is known; otherwise the live radius is used.
 */
export function bakeOrthoZoomIntoRadius(
  camera: THREE.OrthographicCamera,
  target: THREE.Vector3,
  aspect: number,
  baseRadius?: number,
): number {
  const radius = baseRadius ?? orthoRadius(camera, target);
  const zoom = Math.max(EPSILON, camera.zoom || 1);
  const nextRadius = THREE.MathUtils.clamp(radius / zoom, ORTHO_MIN_RADIUS, ORTHO_MAX_RADIUS);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  camera.position.copy(target).addScaledVector(direction, -nextRadius);
  camera.updateMatrixWorld();
  return syncOrthoFrustum(camera, target, aspect);
}

export type OrthoDollyParams = {
  camera: THREE.OrthographicCamera;
  target: THREE.Vector3;
  /** Cursor position in normalised device coordinates (-1..1). */
  ndcX: number;
  ndcY: number;
  /** Multiplier applied to the radius; <1 dollies in. */
  radiusScale: number;
  minRadius?: number;
  maxRadius?: number;
  aspect: number;
  fovDeg?: number;
};

/**
 * Dolly along the view axis by `radiusScale`, anchored at the cursor: the world
 * point under the cursor stays under the cursor. Returns the new orbit target
 * (the camera stays looking along its current axis, so the target is re-seated
 * at the new radius in front of the camera).
 */
export function dollyOrthoToCursor(params: OrthoDollyParams): THREE.Vector3 {
  const {
    camera,
    target,
    ndcX,
    ndcY,
    radiusScale,
    minRadius = ORTHO_MIN_RADIUS,
    maxRadius = ORTHO_MAX_RADIUS,
    aspect,
    fovDeg,
  } = params;

  camera.updateMatrixWorld();
  const mouseBefore = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

  const radius = orthoRadius(camera, target);
  const nextRadius = THREE.MathUtils.clamp(radius * radiusScale, minRadius, maxRadius);
  const direction = camera.getWorldDirection(new THREE.Vector3());

  // Move along the view axis to the new radius, keeping the camera's orientation.
  camera.position.copy(target).addScaledVector(direction, -nextRadius);
  syncOrthoFrustum(camera, target, aspect, fovDeg);
  camera.updateMatrixWorld();

  // Shift laterally so the anchored point keeps its screen position.
  const mouseAfter = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
  camera.position.sub(mouseAfter).add(mouseBefore);

  const nextTarget = camera.position.clone().addScaledVector(direction, nextRadius);
  camera.updateMatrixWorld();
  return nextTarget;
}
