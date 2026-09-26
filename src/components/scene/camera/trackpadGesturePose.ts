import * as THREE from 'three';

/**
 * The pose a trackpad gesture is *asking* for, kept apart from the live camera.
 *
 * Mouse orbit and pan are damped by OrbitControls (`enableDamping` /
 * `dampingFactor`); the custom trackpad gesture writes `camera.position` and
 * `controls.target` directly, once per wheel event, with no residual smoothing.
 * macOS hands over integral, per-frame deltas (the app's own WKWebView capture
 * in `src/components/scene/__tests__/wheelCaptures.fixture.ts`: 59.6 events/s,
 * whole-number deltas), so that path turns finger motion into a sequence of
 * discrete steps while the mouse gets an interpolated glide — same frame time,
 * visibly different feel.
 *
 * So the gesture accumulates into a pose instead, and the camera is eased
 * toward it once per frame by `TrackpadGesturePoseApplier`. Nothing else about
 * the gesture changes: the pan/orbit math below is the math that used to run
 * inline in `SceneCanvas.applyTrackpadGesture`, moved off the camera so the
 * incremental orbit basis stays self-consistent while the camera lags.
 *
 * The pose is *not* a target the camera must eventually reach after the user
 * stops — `SceneCanvas` drops it when the gesture ends (140 ms of wheel
 * silence, ≥ 2× the slowest blend time constant), by which point the residual
 * is sub-pixel.
 */
export type TrackpadGestureAction = 'pan' | 'orbit';

export type TrackpadGesturePose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** The orbit basis the gesture started from (world Z-up), matched to `camera.up`. */
  up: THREE.Vector3;
  /** Orientation derived from `position`/`target`/`up`; gives the pan basis and the orbit pole fallback. */
  quaternion: THREE.Quaternion;
};

/**
 * How long after the last wheel event the pose stays live.
 *
 * This — not the picking interaction's start/end — is what owns the pose's
 * lifetime, and that separation is deliberate. Those end signals are not
 * reliable within a gesture: `handleOrbitStart`/`handleOrbitEnd` describe which
 * subsystem owns *picking*, and they can fire mid-drag. Keying the pose on them
 * threw away every accumulated delta the moment the camera had not yet been
 * eased onto it — which, on a path where the camera only moves once per frame,
 * means the gesture does nothing at all. A window this size is also long enough
 * for the camera to arrive: at the slowest blend constant (70 ms) the residual
 * is under 3%, i.e. sub-pixel, before the pose is released.
 */
export const TRACKPAD_POSE_RELEASE_MS = 250;

/** Radians of orbit per unit `deltaX`/`deltaY`, before the settings' acceleration multiplier. */
const ORBIT_RADIANS_PER_PIXEL = 0.0022;
/** Orbit pitch stops short of the poles; a polar angle of exactly 0 or π has no yaw axis. */
const ORBIT_MIN_POLAR_RAD = 0.08;

const _right = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _sphericalOffset = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _lookMatrix = new THREE.Matrix4();

export function createTrackpadGesturePose(): TrackpadGesturePose {
  return {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    up: new THREE.Vector3(0, 0, 1),
    quaternion: new THREE.Quaternion(),
  };
}

/**
 * Start a gesture from where the camera currently is. Called once per gesture,
 * after `handleOrbitStart` has fired `picking-orbit-start` — `HorizonLock`
 * re-levels `camera.up` on that event, and the pose has to inherit the levelled
 * up-vector rather than the rolled one.
 */
export function seedTrackpadGesturePose(
  pose: TrackpadGesturePose,
  camera: THREE.Camera,
  target: THREE.Vector3,
): void {
  pose.position.copy(camera.position);
  pose.target.copy(target);
  pose.up.copy(camera.up).normalize();
  pose.quaternion.copy(camera.quaternion);
}

/**
 * Screen-space pan, in the pose's own basis so the direction stays correct while
 * the camera is still catching up with it. Returns false for camera types the
 * scale cannot be derived for, mirroring the caller's old early-out.
 */
export function applyTrackpadPanToPose(
  pose: TrackpadGesturePose,
  camera: THREE.Camera,
  deltaX: number,
  deltaY: number,
  viewportHeight: number,
  acceleration: number,
): boolean {
  const safeViewportHeight = Math.max(1, viewportHeight);

  let worldUnitsPerPixel = 0;
  if (camera instanceof THREE.OrthographicCamera) {
    worldUnitsPerPixel = ((camera.top - camera.bottom) / Math.max(1e-6, camera.zoom)) / safeViewportHeight;
  } else if (camera instanceof THREE.PerspectiveCamera) {
    // The pose's own radius: pan is a translation, so it equals the live one.
    const distanceToTarget = Math.max(0.001, pose.position.distanceTo(pose.target));
    const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * distanceToTarget;
    worldUnitsPerPixel = worldHeight / safeViewportHeight;
  } else {
    return false;
  }

  _right.set(1, 0, 0).applyQuaternion(pose.quaternion).normalize();
  _cameraUp.set(0, 1, 0).applyQuaternion(pose.quaternion).normalize();

  _offset
    .set(0, 0, 0)
    .addScaledVector(_right, deltaX * worldUnitsPerPixel * acceleration)
    .addScaledVector(_cameraUp, -deltaY * worldUnitsPerPixel * acceleration);

  pose.position.add(_offset);
  pose.target.add(_offset);
  return true;
}

/**
 * Yaw around `pose.up`, then pitch, with the radius held constant — an orbit
 * never changes distance. The polar angle is clamped away from the poles, which
 * is also the app's home view (straight down world Z): at the pole the yaw axis
 * is undefined, so the pitch clamp is what keeps the first frame after a Home
 * reset from spinning the view.
 */
export function applyTrackpadOrbitToPose(
  pose: TrackpadGesturePose,
  deltaX: number,
  deltaY: number,
  acceleration: number,
): void {
  const rotateScale = ORBIT_RADIANS_PER_PIXEL * acceleration;
  const worldUp = pose.up;

  _offset.copy(pose.position).sub(pose.target);
  const offsetLength = Math.max(0.001, _offset.length());

  _offset.applyQuaternion(_quaternion.setFromAxisAngle(worldUp, deltaX * rotateScale));

  _forward.copy(_offset).normalize();
  const currentPolar = Math.acos(THREE.MathUtils.clamp(_forward.dot(worldUp), -1, 1));
  const nextPolar = THREE.MathUtils.clamp(
    currentPolar + deltaY * rotateScale,
    ORBIT_MIN_POLAR_RAD,
    Math.PI - ORBIT_MIN_POLAR_RAD,
  );
  const pitchAngle = nextPolar - currentPolar;

  _axis.crossVectors(_forward.negate(), worldUp).normalize();
  if (_axis.lengthSq() < 1e-8) {
    // Looking straight along the up axis: no cross product to pitch around, so
    // pitch about the camera's own right instead of standing still.
    _axis.set(1, 0, 0).applyQuaternion(pose.quaternion).normalize();
  }

  _sphericalOffset
    .copy(_offset)
    .normalize()
    .multiplyScalar(offsetLength)
    .applyQuaternion(_quaternion.setFromAxisAngle(_axis, pitchAngle));

  pose.position.copy(pose.target).add(_sphericalOffset);
  _lookMatrix.lookAt(pose.position, pose.target, worldUp);
  pose.quaternion.setFromRotationMatrix(_lookMatrix);
}

/**
 * How far to move the camera toward the pose this frame, as a fraction of the
 * remaining distance: an exponential approach, so the motion is the same shape
 * at 60 Hz and at 120 Hz. `tauMs <= 0` returns 1 — the pose is applied as soon
 * as it is read, which is how the `raw` camera-feel preset behaves.
 */
export function trackpadPoseBlendFactor(deltaMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return 1;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 1;
  return THREE.MathUtils.clamp(1 - Math.exp(-deltaMs / tauMs), 0, 1);
}

/**
 * Move the live camera one step toward the pose. `orientToTarget` reproduces
 * what the inline orbit did per event (`camera.up` from the gesture basis, then
 * `lookAt`); a pan must leave the orientation alone, which is also what
 * OrbitControls' own per-frame `update()` already keeps consistent.
 */
export function blendCameraTowardTrackpadPose(
  pose: TrackpadGesturePose,
  camera: THREE.Camera,
  target: THREE.Vector3,
  alpha: number,
  orientToTarget: boolean,
): void {
  camera.position.lerp(pose.position, alpha);
  target.lerp(pose.target, alpha);

  if (orientToTarget) {
    camera.up.copy(pose.up);
    camera.lookAt(target);
  }

  camera.updateMatrixWorld();
}
