import * as THREE from 'three';

/**
 * Aim the camera so that `pivot` projects onto `anchorNdc`.
 *
 * OrbitControls always looks *at* its target, so the target can only ever sit in
 * the middle of the screen. Cursor mode needs the orbit centre to stay on the
 * pixel it was picked on — otherwise it slides up or down the screen as the
 * orbit pitches — while the camera still looks past it and the horizon stays
 * level.
 *
 * The rotation is solved rather than iterated: the eye and the pivot fix the
 * direction to the pivot, the anchor fixes the direction it must occupy in
 * camera space, and a rotation carries one onto the other. That rotation is
 * unique up to a roll about the pivot direction; the roll that levels the
 * horizon is a closed-form choice between two roots. (Iterating the aim instead
 * oscillates as the view approaches the poles.)
 */

const EPSILON = 1e-6;

const _pivotDirection = new THREE.Vector3();
const _viewDirection = new THREE.Vector3();
const _scratchA = new THREE.Vector3();
const _scratchB = new THREE.Vector3();
const _candidateUp = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qCandidate = new THREE.Quaternion();

/**
 * The pivot's direction in camera space: where the camera must point for the
 * pivot to sit on `anchorNdc`. Perspective divides the lateral offset by depth;
 * orthographic maps it onto the frustum extents.
 *
 * @returns false when the projection has no usable frustum for the anchor.
 */
function pivotViewDirection(
  camera: THREE.Camera,
  anchorNdc: THREE.Vector2,
  distance: number,
  out: THREE.Vector3,
): boolean {
  if (camera instanceof THREE.PerspectiveCamera) {
    const tanHalfV = Math.tan((camera.fov * Math.PI) / 360);
    out.set(anchorNdc.x * tanHalfV * camera.aspect, anchorNdc.y * tanHalfV, -1).normalize();
    return true;
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const lateralX = (anchorNdc.x * (camera.right - camera.left) * 0.5) / Math.max(EPSILON, distance);
    const lateralY = (anchorNdc.y * (camera.top - camera.bottom) * 0.5) / Math.max(EPSILON, distance);
    const depthSq = 1 - lateralX * lateralX - lateralY * lateralY;
    if (depthSq <= EPSILON) return false;
    out.set(lateralX, lateralY, -Math.sqrt(depthSq)).normalize();
    return true;
  }
  return false;
}

/**
 * Solve the camera orientation for a pivot held at `anchorNdc`.
 *
 * Writes the level solution into `out` and returns true. Returns false when the
 * geometry is degenerate — the pivot straight along the up axis, where "level"
 * has no meaning — and the caller should fall back to looking at the pivot.
 */
export function solveAnchoredAim(
  camera: THREE.Camera,
  pivot: THREE.Vector3,
  anchorNdc: THREE.Vector2,
  out: THREE.Quaternion,
): boolean {
  _pivotDirection.subVectors(pivot, camera.position);
  const distance = _pivotDirection.length();
  if (distance < EPSILON) return false;
  _pivotDirection.divideScalar(distance);

  if (!pivotViewDirection(camera, anchorNdc, distance, _viewDirection)) return false;

  _qAlign.setFromUnitVectors(_viewDirection, _pivotDirection);

  // The aligned rotation's right axis, split about the pivot direction.
  _scratchA.set(1, 0, 0).applyQuaternion(_qAlign);
  const alongPivot = _scratchA.dot(_pivotDirection);
  _scratchA.addScaledVector(_pivotDirection, -alongPivot);
  _scratchB.crossVectors(_pivotDirection, _scratchA);

  const cosCoefficient = _scratchA.dot(camera.up);
  const sinCoefficient = _scratchB.dot(camera.up);
  const target = -alongPivot * _pivotDirection.dot(camera.up);
  const amplitude = Math.hypot(cosCoefficient, sinCoefficient);
  if (amplitude < EPSILON) return false;

  const phase = Math.atan2(sinCoefficient, cosCoefficient);
  const offset = Math.acos(THREE.MathUtils.clamp(target / amplitude, -1, 1));

  let best = -Infinity;
  for (const roll of [phase + offset, phase - offset]) {
    _qCandidate.setFromAxisAngle(_pivotDirection, roll).multiply(_qAlign);
    _candidateUp.set(0, 1, 0).applyQuaternion(_qCandidate);
    const alignment = _candidateUp.dot(camera.up);
    if (alignment > best) {
      best = alignment;
      out.copy(_qCandidate);
    }
  }

  return true;
}
