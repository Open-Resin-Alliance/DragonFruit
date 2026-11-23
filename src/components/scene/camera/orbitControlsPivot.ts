import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { solveAnchoredAim } from './anchoredAim';

/**
 * OrbitControls with one addition: the orbit centre keeps a fixed pixel.
 *
 * Upstream always aims the camera *at* `target`, so `target` can only sit in the
 * middle of the screen and any off-centre orbit centre would slide away as the
 * camera pitches. This subclass solves the aim instead — see `anchoredAim.ts` —
 * so `anchorNdc` says where `target` must project.
 *
 * `anchorNdc` at (0, 0) is exactly the upstream behaviour: the pivot is the
 * middle of the screen. Picking a point under the cursor sets the anchor to
 * that point's own pixel, which the solve then reproduces frame for frame, so
 * adopting it moves nothing.
 */
/**
 * How close to vertical a cursor pivot lets the orbit get, in radians.
 *
 * The level-horizon solve is exact everywhere except there: looking straight
 * down (or up) the world up is perpendicular to the screen up, so the sign of
 * "which way is up" is decided by numerical noise and the image flips as the
 * orbit circles the pole. Stopping short keeps the frame stable, and the orbit
 * still circles the pivot at a rate that reads as turning the model.
 */
const MIN_POLAR_ANGLE = 0.2;

export class PivotOrbitControls extends OrbitControls {
  /** The pixel `target` projects onto, in normalised device coordinates. */
  readonly anchorNdc = new THREE.Vector2();

  private readonly aimQuaternion = new THREE.Quaternion();

  /**
   * The orientation this control last solved for the current pivot. Used only
   * when the solve itself is degenerate (pivot straight along the up axis), so
   * the frame holds instead of snapping to a different roll.
   */
  private readonly lastAim = new THREE.Quaternion();

  private hasAim = false;

  /** The app's own polar limits, while the cursor pivot needs them tightened. */
  private savedPolarLimits: { min: number; max: number } | null = null;

  /**
   * Give up the cursor pivot. Another camera owner (a SpaceMouse gesture) has
   * re-seated the target, and resuming our pixel would swing the view to put it
   * back under that pixel — the jump on release.
   */
  clearAnchor(): void {
    this.anchorNdc.set(0, 0);
    this.hasAim = false;
  }

  /**
   * Tighten the polar range while a cursor pivot is active, and hand the app's
   * own limits back the moment it is not. `update()` runs before `super`, so the
   * clamp is in place when upstream applies its own.
   */
  private applyPolarLimit(): void {
    const anchored = this.anchorNdc.lengthSq() > 1e-12;
    if (anchored) {
      if (!this.savedPolarLimits) {
        this.savedPolarLimits = { min: this.minPolarAngle, max: this.maxPolarAngle };
      }
      this.minPolarAngle = Math.max(this.savedPolarLimits.min, MIN_POLAR_ANGLE);
      this.maxPolarAngle = Math.min(this.savedPolarLimits.max, Math.PI - MIN_POLAR_ANGLE);
      return;
    }
    if (this.savedPolarLimits) {
      this.minPolarAngle = this.savedPolarLimits.min;
      this.maxPolarAngle = this.savedPolarLimits.max;
      this.savedPolarLimits = null;
    }
  }

  override update(deltaTime: number | null = null): boolean {
    // Upstream's constructor calls `update()` before subclass fields exist.
    if (!this.anchorNdc) return super.update(deltaTime);
    this.applyPolarLimit();
    const changed = super.update(deltaTime);
    if (this.anchorNdc.lengthSq() < 1e-12) {
      this.hasAim = false;
      return changed;
    }
    // `Controls` types its object as a plain Object3D; this control is only ever
    // constructed with the scene camera.
    const camera = this.object as THREE.Camera;
    const solved = solveAnchoredAim(camera, this.target, this.anchorNdc, this.aimQuaternion);
    if (!solved) {
      // Degenerate geometry (pivot straight along the up axis): hold the last
      // solved orientation. Falling through to `super.update()`'s look-at would
      // snap the roll, which is the flip this guards.
      if (!this.hasAim) return changed;
      camera.quaternion.copy(this.lastAim);
      camera.updateMatrixWorld();
      return changed;
    }
    this.lastAim.copy(this.aimQuaternion);
    this.hasAim = true;
    camera.quaternion.copy(this.aimQuaternion);
    camera.updateMatrixWorld();
    return changed;
  }
}

/**
 * Drop a cursor pivot from any controls that carry one. The SpaceMouse
 * controllers call this when they hand the camera back, because the pivot they
 * used is the one the camera resumes from.
 */
export function clearCursorPivotAnchor(controls: unknown): void {
  if (!controls || typeof controls !== 'object' || !('clearAnchor' in controls)) return;
  const visible = controls as { clearAnchor?: () => void };
  visible.clearAnchor?.();
}
