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
export class PivotOrbitControls extends OrbitControls {
  /** The pixel `target` projects onto, in normalised device coordinates. */
  readonly anchorNdc = new THREE.Vector2();

  private readonly aimQuaternion = new THREE.Quaternion();

  override update(deltaTime: number | null = null): boolean {
    const changed = super.update(deltaTime);
    // Upstream's constructor calls `update()` before subclass fields exist.
    if (!this.anchorNdc) return changed;
    if (this.anchorNdc.lengthSq() < 1e-12) return changed;
    // `Controls` types its object as a plain Object3D; this control is only ever
    // constructed with the scene camera.
    const camera = this.object as THREE.Camera;
    if (!solveAnchoredAim(camera, this.target, this.anchorNdc, this.aimQuaternion)) {
      return changed;
    }
    camera.quaternion.copy(this.aimQuaternion);
    camera.updateMatrixWorld();
    return changed;
  }
}
