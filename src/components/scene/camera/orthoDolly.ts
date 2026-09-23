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
 * Callers pass the app's live FOV setting, the same value perspective uses, so
 * both projections share one FOV and switching is the identity.
 * `ORTHO_REFERENCE_FOV_DEG` is only the fallback when none is supplied.
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
 * OrbitControls-compatible wheel scale. Mirrors `getZoomScale()` =
 * `0.95^zoomSpeed`; returns a multiplier applied to the radius (<1 zooms in).
 */
export function orthoWheelRadiusScale(deltaY: number, zoomSpeed: number): number {
  const step = Math.pow(0.95, Math.max(EPSILON, zoomSpeed));
  return deltaY < 0 ? step : 1 / step;
}

/**
 * Any real rotation keeps the on-screen scale. Presets reorient, and an orbit
 * never changes distance — so a rotating frame must never drive the zoom.
 */
export const ORTHO_VIEW_TURN_RAD = THREE.MathUtils.degToRad(3);
/** A single-frame eye jump above this fraction of the radius is a Fit, not a dolly. */
export const ORTHO_FIT_JUMP_FRACTION = 0.3;

export type OrthoNavFrame = {
  currentRadius: number;
  prevAxial: number;
  axial: number;
  /** False on the first applied frame of a gesture (no previous to diff against). */
  hasPrevious: boolean;
  /** Rotation from the previous applied forward, radians. */
  turn: number;
  /** World-space eye movement since the previous applied frame. */
  eyeJump: number;
  minRadius?: number;
  maxRadius?: number;
};

/**
 * Whether a frame looks like a Fit: no rotation, but a large single-frame jump in
 * the eye. The controller runs the app's own focus (the F action) for these
 * rather than trusting navlib's perspective-fit eye distance.
 */
export function isOrthoFitFrame(frame: OrthoNavFrame): boolean {
  return (
    frame.hasPrevious
    && frame.turn <= ORTHO_VIEW_TURN_RAD
    && frame.eyeJump > ORTHO_FIT_JUMP_FRACTION * Math.max(EPSILON, frame.currentRadius)
  );
}

/**
 * The next ortho dolly radius for one navlib frame.
 *
 * Interactive dollies integrate navlib's own axial delta. View commands do not:
 * navlib picks their eye distance for a perspective projection, so under the
 * derived ortho frustum that distance *is* the scale and lands far too close.
 * A reorientation (preset) keeps the user's zoom, and so does a Fit — the
 * controller runs the app's focus for that separately.
 */
export function resolveOrthoNavRadius(frame: OrthoNavFrame): number {
  const {
    currentRadius,
    prevAxial,
    axial,
    hasPrevious,
    turn,
    minRadius = ORTHO_MIN_RADIUS,
    maxRadius = ORTHO_MAX_RADIUS,
  } = frame;

  if (!hasPrevious) return currentRadius;

  if (turn > ORTHO_VIEW_TURN_RAD) {
    // Preset: reorient, keep the on-screen scale.
    return currentRadius;
  }

  if (isOrthoFitFrame(frame)) {
    // Fit: keep the scale here; the controller runs the app's focus.
    return currentRadius;
  }

  return THREE.MathUtils.clamp(currentRadius - (axial - prevAxial), minRadius, maxRadius);
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
  // The world point under the cursor. Any point along the cursor's ray projects
  // to the same NDC, so anchoring the ray's origin on the camera plane anchors
  // the whole ray.
  const anchored = new THREE.Vector3(ndcX, ndcY, 0).unproject(camera);

  const radius = orthoRadius(camera, target);
  const nextRadius = THREE.MathUtils.clamp(radius * radiusScale, minRadius, maxRadius);
  const direction = camera.getWorldDirection(new THREE.Vector3());

  // Move along the view axis to the new radius, keeping the camera's orientation.
  camera.position.copy(target).addScaledVector(direction, -nextRadius);
  applyOrthoFrustum(camera, nextRadius, aspect, options);
  camera.updateMatrixWorld();

  // Slide the camera sideways so the anchored point keeps its screen position,
  // and only sideways. Re-unprojecting the cursor after the move and subtracting
  // the two world points mixes in the dolly's own travel: the two points were
  // taken on different camera planes, so their difference is the lateral anchor
  // offset *plus* the axial distance the camera just moved. Applying it as a
  // translation cancels the dolly outright (the camera lands back where it
  // started) and hands the whole displacement to the next target, which walks the
  // orbit pivot a full dolly distance away from whatever the user was orbiting.
  // Work in the camera's own basis instead, where the correction is a pure
  // in-plane offset by construction.
  const anchoredInView = anchored.applyMatrix4(camera.matrixWorldInverse);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const halfWidth = (camera.right - camera.left) * 0.5;
  const halfHeight = (camera.top - camera.bottom) * 0.5;
  camera.position.addScaledVector(right, anchoredInView.x - ndcX * halfWidth);
  camera.position.addScaledVector(up, anchoredInView.y - ndcY * halfHeight);

  const nextTarget = camera.position.clone().addScaledVector(direction, nextRadius);
  camera.updateMatrixWorld();
  return nextTarget;
}
