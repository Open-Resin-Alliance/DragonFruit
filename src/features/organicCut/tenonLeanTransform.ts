import * as THREE from 'three';
import { TENON_MAX_TILT_RAD, type TenonPreviewFrame } from './types';

/**
 * The live lean/roll of the registration tenon, as a matrix.
 *
 * The tenon SOUP is built STRAIGHT in Rust and the aim is applied here, so dragging
 * the gizmo never costs a Rust round-trip. The price is that this has to match
 * `LeanXform` in `tenon.rs` exactly — every sign in it has a twin over there — which
 * is why it lives in its own module with its own tests instead of inside a
 * component: the mismatches are invisible on screen until they are gross, and the
 * only ones we ever shipped were sign errors.
 *
 * CRITICAL: the soup is built in the Rust BUILD frame
 * (`frame_extruding_toward_part_b`) — the reported natural frame with the axis
 * NEGATED and u/v SWAPPED. Leaning in the natural frame instead would MIRROR the
 * result, because that swap flips handedness.
 *
 * Returns null when there is nothing to apply (no lean, no roll).
 */
export function tenonLeanMatrix(
  frame: TenonPreviewFrame,
  tiltRad: number,
  rollRad: number,
): THREE.Matrix4 | null {
  const anchor = new THREE.Vector3(...frame.anchor);
  // Natural ("orig") frame as reported.
  const axisN = new THREE.Vector3(...frame.axis).normalize();
  const uN = new THREE.Vector3(...frame.u).normalize();
  // Build frame = frame_extruding_toward_part_b(natural): negate axis, swap u/v,
  // so the build frame's +y — the hinge the lean turns about, giving a tip over a
  // NARROW face — is the natural u.
  const buildAxis = axisN.clone().multiplyScalar(-1);
  const buildV = uN.clone();

  const tilt = clampTenonTilt(tiltRad, frame);
  const roll = rollRad;
  if (Math.abs(tilt) < 1e-6 && Math.abs(roll) < 1e-6) return null;

  // Apply order (matches LeanXform::apply): lean about the body's own +y, then
  // roll about +z — the lean in the tenon's own frame welds the lean plane to the
  // body, so the roll turns the two as one. (The old azimuth failed because it was
  // a second number for the same freedom as the roll; one welded lean cannot.)
  const q = new THREE.Quaternion();
  if (Math.abs(tilt) >= 1e-6) {
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(buildV, tilt));
  }
  if (Math.abs(roll) >= 1e-6) {
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(buildAxis, roll));
  }

  // A pure rigid rotation about the anchor — nothing else. Rust used to sink the
  // leaned tenon and stretch its trunk (so the cap stayed at a fixed height above
  // the cut face) and this had to mirror both; neither exists now, because leaning
  // a solid does not resize it. See LeanXform.
  //
  // This used to carry a known, bounded difference: Rust turned about a build origin
  // half a kerf below the membrane and shifted back to put the axis through the
  // anchor, which landed the body up to half_kerf·(1−cos tilt) differently along the
  // axis. There is no kerf any more — the two halves share their cut face and the
  // build frame sits ON it — so both sides now turn about the same point and the
  // preview matches the cut exactly.
  const toOrigin = new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z);
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const back = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z);
  return back.multiply(rot).multiply(toOrigin);
}

/**
 * The lean, clamped to what this placement can take: the room the part leaves
 * around the tenon (`maxTiltRad`, measured in Rust), never past the hard ceiling.
 * Keeps its sign — a negative lean tips the other way in the same plane.
 */
export function clampTenonTilt(tiltRad: number, frame: TenonPreviewFrame | null): number {
  const cap = Math.min(frame?.maxTiltRad ?? TENON_MAX_TILT_RAD, TENON_MAX_TILT_RAD);
  return Math.max(-cap, Math.min(cap, tiltRad));
}
