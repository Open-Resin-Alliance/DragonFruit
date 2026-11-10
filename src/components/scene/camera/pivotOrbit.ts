import * as THREE from 'three';

/**
 * Orbiting around a pivot that is not the centre of the screen.
 *
 * OrbitControls can only orbit its `target` and re-aims the camera at it on
 * every `update()`, so pointing the target at the point under the cursor drags
 * the view onto that point. A CAD-style cursor orbit (Navisworks' steering-wheel
 * Orbit: "the model rotates around a pivot point while the view remains fixed",
 * pivot picked on the surface) needs the pivot to be the orbit centre while the
 * view keeps its own framing.
 *
 * This is a rigid rotation of the camera pose about the pivot, with the camera's
 * up vector left alone:
 *
 *   - picking the pivot changes nothing on screen — the state is seeded from the
 *     current pose, and the identity orbit reproduces it exactly;
 *   - orbiting turns the eye about the pivot and rotates the look point with it,
 *     so the pivot keeps its screen position for azimuth (which turns about the
 *     world up axis) and drifts on elevation, the way any level-horizon orbit
 *     has to;
 *   - the camera never rolls: `camera.up` stays the world up, so the horizon is
 *     always horizontal.
 *
 * The alternative — aiming at the pivot and compensating with a focal offset, as
 * `camera-controls` does — holds the pivot's pixel through elevation too, but it
 * visibly re-aims and rescales the view at the moment the pivot is picked. That
 * "the camera turns when you click the mesh" cost is why this model is the one
 * used here.
 */

export type PivotOrbitState = {
  pivot: THREE.Vector3;
  up: THREE.Vector3;
  /** Orbit radius: the camera's distance to the pivot. */
  radius: number;
  /** Azimuth of the eye about `up`, radians. */
  azimuth: number;
  /** Polar angle of the eye from `up`, radians. */
  polar: number;
  /**
   * The pixel the pivot must keep, in normalised device coordinates. Held by
   * choosing the camera's *aim*, so the pivot does not drift when the orbit
   * pitches — and the camera still looks elsewhere (it is not aimed at the
   * pivot), and the horizon stays level because the aim is built from the world
   * up.
   */
  pivotNdc: THREE.Vector2;
};

export const PIVOT_ORBIT_MIN_POLAR = 0.08;
const EPSILON = 1e-6;

const _f = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _pivotDirection = new THREE.Vector3();
const _viewDirection = new THREE.Vector3();
const _up = new THREE.Vector3();
const _scratchA = new THREE.Vector3();
const _scratchB = new THREE.Vector3();
const _candidateUp = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qCandidate = new THREE.Quaternion();
const _qBest = new THREE.Quaternion();

export function createPivotOrbitState(
  camera: THREE.Camera,
  pivot: THREE.Vector3,
): PivotOrbitState {
  camera.updateMatrixWorld();

  const up = camera.up.clone().normalize();
  const direction = new THREE.Vector3().subVectors(camera.position, pivot);
  const radius = Math.max(EPSILON, direction.length());
  direction.divideScalar(radius);

  // The pixel the pivot occupies right now. Every orbit frame re-aims to keep it.
  const projected = pivot.clone().project(camera);

  return {
    pivot: pivot.clone(),
    up,
    radius,
    azimuth: Math.atan2(direction.y, direction.x),
    polar: THREE.MathUtils.clamp(
      Math.acos(THREE.MathUtils.clamp(direction.dot(up), -1, 1)),
      PIVOT_ORBIT_MIN_POLAR,
      Math.PI - PIVOT_ORBIT_MIN_POLAR,
    ),
    pivotNdc: new THREE.Vector2(projected.x, projected.y),
  };
}

function directionFromAngles(state: PivotOrbitState, out: THREE.Vector3): THREE.Vector3 {
  const sinPolar = Math.max(EPSILON, Math.sin(state.polar));
  return out.set(
    Math.cos(state.azimuth) * sinPolar,
    Math.sin(state.azimuth) * sinPolar,
    Math.cos(state.polar),
  );
}

/**
 * The pivot's direction in camera space: where the camera must point for the
 * pivot to sit on its stored pixel. Perspective divides lateral offset by depth,
 * orthographic maps it onto the frustum extents.
 */
function viewDirectionOfPivot(
  camera: THREE.Camera,
  state: PivotOrbitState,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  const ndc = state.pivotNdc;
  if (camera instanceof THREE.PerspectiveCamera) {
    const tanHalfV = Math.tan((camera.fov * Math.PI) / 360);
    return out.set(ndc.x * tanHalfV * camera.aspect, ndc.y * tanHalfV, -1).normalize();
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const lateralX = (ndc.x * (camera.right - camera.left) * 0.5) / Math.max(EPSILON, state.radius);
    const lateralY = (ndc.y * (camera.top - camera.bottom) * 0.5) / Math.max(EPSILON, state.radius);
    const depthSq = 1 - lateralX * lateralX - lateralY * lateralY;
    if (depthSq <= EPSILON) return null;
    return out.set(lateralX, lateralY, -Math.sqrt(depthSq)).normalize();
  }
  return null;
}

/**
 * Orient the camera so the pivot lands on its stored pixel with a level
 * horizon.
 *
 * The rotation is solved rather than iterated: every rotation taking the
 * pivot's camera-space direction onto its world direction is the aligned
 * rotation composed with a roll about the pivot; the roll that levels the
 * horizon is a closed-form choice between two roots. Iterating instead
 * oscillates when the view approaches the poles.
 */
function aimAtPivot(
  camera: THREE.Camera,
  state: PivotOrbitState,
  eye: THREE.Vector3,
  out: THREE.Quaternion,
): boolean {
  _pivotDirection.subVectors(state.pivot, eye).normalize();
  if (!viewDirectionOfPivot(camera, state, _viewDirection)) return false;

  _qAlign.setFromUnitVectors(_viewDirection, _pivotDirection);

  // The aligned rotation's right axis, split about the pivot direction.
  _scratchA.set(1, 0, 0).applyQuaternion(_qAlign);
  const alongPivot = _scratchA.dot(_pivotDirection);
  _scratchA.addScaledVector(_pivotDirection, -alongPivot);
  _scratchB.crossVectors(_pivotDirection, _scratchA);

  const cosCoefficient = _scratchA.dot(state.up);
  const sinCoefficient = _scratchB.dot(state.up);
  const target = -alongPivot * _pivotDirection.dot(state.up);
  const amplitude = Math.hypot(cosCoefficient, sinCoefficient);
  if (amplitude < EPSILON) return false;

  const phase = Math.atan2(sinCoefficient, cosCoefficient);
  const offset = Math.acos(THREE.MathUtils.clamp(target / amplitude, -1, 1));

  let best = -Infinity;
  for (const roll of [phase + offset, phase - offset]) {
    _qCandidate.setFromAxisAngle(_pivotDirection, roll).multiply(_qAlign);
    _candidateUp.set(0, 1, 0).applyQuaternion(_qCandidate);
    const alignment = _candidateUp.dot(state.up);
    if (alignment > best) {
      best = alignment;
      _qBest.copy(_qCandidate);
    }
  }

  out.copy(_qBest);
  return true;
}

/**
 * Move the camera onto the orbit pose.
 *
 * The eye sits on the sphere about the pivot; the camera's aim is then solved so
 * the pivot lands back on its stored pixel. Aiming (rather than keeping the
 * look point rigidly attached) is what stops the pivot sliding up or down the
 * screen as the orbit pitches, while the camera still looks *past* the pivot and
 * the world up keeps the horizon level. A state created from the camera
 * reproduces that camera exactly, so picking a pivot moves nothing.
 */
export function applyPivotOrbitState(state: PivotOrbitState, camera: THREE.Camera): void {
  directionFromAngles(state, _f);
  _eye.copy(state.pivot).addScaledVector(_f, state.radius);

  camera.position.copy(_eye);
  camera.up.copy(state.up);
  if (aimAtPivot(camera, state, _eye, _qBest)) {
    camera.quaternion.copy(_qBest);
  } else {
    camera.lookAt(state.pivot);
  }
  camera.updateMatrixWorld();
}

/**
 * Turn the eye around the pivot by pointer deltas, the same reading as
 * OrbitControls' `rotateLeft`/`rotateUp`. Deltas are absolute from the gesture
 * start in the caller, so nothing accumulates here.
 */
export function orbitPivotBy(
  state: PivotOrbitState,
  dx: number,
  dy: number,
  viewportHeight: number,
  rotateSpeed: number,
): void {
  const perPixel = (2 * Math.PI * Math.max(EPSILON, rotateSpeed)) / Math.max(1, viewportHeight);
  state.azimuth -= dx * perPixel;
  state.polar = THREE.MathUtils.clamp(
    state.polar - dy * perPixel,
    PIVOT_ORBIT_MIN_POLAR,
    Math.PI - PIVOT_ORBIT_MIN_POLAR,
  );
}
