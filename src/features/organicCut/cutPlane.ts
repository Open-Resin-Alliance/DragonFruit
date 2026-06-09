import * as THREE from 'three';
import type { OrganicCutLoopPoint } from './types';

/**
 * The cutting plane derived from the user's points, in the model's LOCAL space.
 * `normal` is unit length; the plane is { p : normal · p == offset }, passing
 * through `point` (used to position the preview quad).
 */
export interface CutPlane {
  normal: THREE.Vector3;
  offset: number;
  point: THREE.Vector3;
}

/** World up-axis in local space. Identity-rotation models: local +Z == world up. */
const LOCAL_UP = new THREE.Vector3(0, 0, 1);

/**
 * Derives the cutting plane from the placed points. THIS IS THE SINGLE SOURCE OF
 * TRUTH for the plane: the preview quad and the plane sent to Rust both come from
 * here, so what you see is exactly what gets cut.
 *
 * - **2 points** → the plane CONTAINS the A→B line and the world up-axis, so the
 *   cut follows the drawn line and slices vertically down through it.
 *   normal = (B−A) × up.
 * - **3+ points** → best-fit plane (centroid + least-variance normal). [Matches
 *   the Rust PCA path; preview for 3+ is approximate but the same intent.]
 *
 * Returns null when the points are too few or degenerate (coincident/collinear).
 */
export function cutPlaneFromPoints(points: OrganicCutLoopPoint[]): CutPlane | null {
  if (points.length < 2) return null;

  if (points.length === 2) {
    const a = new THREE.Vector3(...points[0].position);
    const b = new THREE.Vector3(...points[1].position);
    const line = b.clone().sub(a);
    if (line.length() < 1e-6) return null; // coincident
    line.normalize();

    let normal = line.clone().cross(LOCAL_UP);
    if (normal.length() < 1e-4) {
      // Line is ~vertical; fall back to crossing with world-Y.
      normal = line.clone().cross(new THREE.Vector3(0, 1, 0));
    }
    if (normal.length() < 1e-6) return null;
    normal.normalize();

    const point = a.clone().add(b).multiplyScalar(0.5);
    return { normal, offset: normal.dot(point), point };
  }

  // 3+ points: centroid + best-fit (covariance) normal.
  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(new THREE.Vector3(...p.position));
  centroid.multiplyScalar(1 / points.length);

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const d = new THREE.Vector3(...p.position).sub(centroid);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const detMax = Math.max(detX, detY, detZ);
  if (detMax <= 1e-12) return null; // collinear

  let normal: THREE.Vector3;
  if (detMax === detX) normal = new THREE.Vector3(detX, xz * yz - xy * zz, xy * yz - xz * yy);
  else if (detMax === detY) normal = new THREE.Vector3(xz * yz - xy * zz, detY, xy * xz - yz * xx);
  else normal = new THREE.Vector3(xy * yz - xz * yy, xy * xz - yz * xx, detZ);

  if (normal.length() < 1e-9) return null;
  normal.normalize();
  return { normal, offset: normal.dot(centroid), point: centroid };
}
