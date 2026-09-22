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
 * Fallback symmetric depth range when the scene radius is unknown. Orthographic
 * cameras need a negative near so geometry behind the camera's position stays
 * visible; ±50000 at 24-bit depth is ~0.006 mm resolution.
 */
export const ORTHO_NEAR = -50000;
export const ORTHO_FAR = 50000;

/** Extra slack beyond `radius + sceneRadius` so edges never clip. */
export const ORTHO_DEPTH_MARGIN = 500;

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

export type OrthoFrustumOptions = {
  fovDeg?: number;
  /**
   * Radius of the scene around the target. When known, the depth range is
   * `±(radius + sceneRadius + margin)` — tighter, so better z precision than the
   * blanket fallback. Pass 0/undefined to use the fallback.
   */
  sceneRadius?: number;
};

/** The horizontal:vertical aspect of an ortho camera's current frustum. */
export function orthoAspectOf(camera: THREE.OrthographicCamera): number {
  return (camera.right - camera.left) / Math.max(EPSILON, camera.top - camera.bottom);
}

/**
 * Write a symmetric ortho frustum for an explicit radius and pin `zoom` to 1.
 * `radius` is the axial camera-to-target distance — the single ortho scale.
 */
export function applyOrthoFrustum(
  camera: THREE.OrthographicCamera,
  radius: number,
  aspect: number,
  options: OrthoFrustumOptions = {},
): void {
  const halfH = orthoHalfHeightForRadius(radius, options.fovDeg);
  const halfW = halfH * Math.max(EPSILON, aspect);

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.zoom = 1;

  if (options.sceneRadius != null && options.sceneRadius > 0) {
    const depth = Math.max(EPSILON, radius) + options.sceneRadius + ORTHO_DEPTH_MARGIN;
    camera.near = -depth;
    camera.far = depth;
  } else {
    camera.near = ORTHO_NEAR;
    camera.far = ORTHO_FAR;
  }
  camera.updateProjectionMatrix();
}

/**
 * Recompute the frustum from the current radius. Returns the radius used.
 * Call after anything that changes `camera.position` or the orbit target.
 */
export function syncOrthoFrustum(
  camera: THREE.OrthographicCamera,
  target: THREE.Vector3,
  aspect: number,
  options: OrthoFrustumOptions = {},
): number {
  const radius = orthoRadius(camera, target);
  applyOrthoFrustum(camera, radius, aspect, options);
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
  options?: OrthoFrustumOptions;
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
    options,
  } = params;

  camera.updateMatrixWorld();
  const mouseBefore = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

  const radius = orthoRadius(camera, target);
  const nextRadius = THREE.MathUtils.clamp(radius * radiusScale, minRadius, maxRadius);
  const direction = camera.getWorldDirection(new THREE.Vector3());

  // Move along the view axis to the new radius, keeping the camera's orientation.
  camera.position.copy(target).addScaledVector(direction, -nextRadius);
  applyOrthoFrustum(camera, nextRadius, aspect, options);
  camera.updateMatrixWorld();

  // Shift laterally so the anchored point keeps its screen position.
  const mouseAfter = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);
  camera.position.sub(mouseAfter).add(mouseBefore);

  const nextTarget = camera.position.clone().addScaledVector(direction, nextRadius);
  camera.updateMatrixWorld();
  return nextTarget;
}
