import * as THREE from 'three';
import type { OrientationCandidate } from '../types';

const ANGLE_EPSILON = 1e-4;
const TWO_PI = Math.PI * 2;

/**
 * Number of "down" directions sampled over the sphere. 256 gives an even
 * angular spacing of roughly 12–13° between neighboring orientations — fine
 * enough to land on good resting poses without being noticeably slow, since
 * scoring each candidate is pure arithmetic.
 */
const SPHERE_SAMPLES = 256;

const DOWN = new THREE.Vector3(0, 0, -1);

/**
 * Generate candidate orientations as a uniform sweep of which world direction
 * the model's geometry is rotated to point "down" (toward the build plate).
 *
 * We sample directions with a Fibonacci sphere, which spreads points evenly
 * (no pole clustering like an Euler X/Y grid), then for each sampled local
 * direction `d` compute the rotation that maps `d` onto world-down (-Z). The
 * model's current rotation is always included first so auto-orient can never
 * produce a strictly worse result than the starting pose, and so ties resolve
 * in favor of leaving the model where it is.
 *
 * Candidates are de-duplicated by quantized euler so the current rotation and
 * any near-coincident samples don't double-count.
 */
export function generateCandidates(currentRotation: THREE.Euler): OrientationCandidate[] {
  const seen = new Set<string>();
  const candidates: OrientationCandidate[] = [];

  const wrap = (a: number) => {
    let v = a % TWO_PI;
    if (v < 0) v += TWO_PI;
    return v;
  };
  const quantKey = (e: THREE.Euler) =>
    [
      Math.round(wrap(e.x) / ANGLE_EPSILON),
      Math.round(wrap(e.y) / ANGLE_EPSILON),
      Math.round(wrap(e.z) / ANGLE_EPSILON),
    ].join('|');

  const pushEuler = (euler: THREE.Euler) => {
    const key = quantKey(euler);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ rotation: euler });
  };

  // Always include the current orientation first.
  pushEuler(new THREE.Euler(currentRotation.x, currentRotation.y, currentRotation.z, 'ZYX'));

  // Preserve the model's current Z (yaw) so footprint-driven packing stays
  // stable; the sweep only changes which face rests on the plate.
  const zSpin = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, currentRotation.z, 'ZYX'));

  // Fibonacci sphere: evenly distributed unit directions.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const tmpDir = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler(0, 0, 0, 'ZYX');

  for (let i = 0; i < SPHERE_SAMPLES; i++) {
    // z in (-1, 1), radius in the XY plane, angle by golden ratio.
    const dz = 1 - (2 * (i + 0.5)) / SPHERE_SAMPLES;
    const r = Math.sqrt(Math.max(0, 1 - dz * dz));
    const theta = golden * i;
    tmpDir.set(Math.cos(theta) * r, Math.sin(theta) * r, dz).normalize();

    // Rotation that brings this local direction to world-down, then re-apply
    // the model's current yaw so we only changed the resting face.
    tmpQuat.setFromUnitVectors(tmpDir, DOWN).premultiply(zSpin);
    tmpEuler.setFromQuaternion(tmpQuat, 'ZYX');
    pushEuler(new THREE.Euler(tmpEuler.x, tmpEuler.y, tmpEuler.z, 'ZYX'));
  }

  return candidates;
}
