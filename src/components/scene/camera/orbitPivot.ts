import * as THREE from 'three';

/**
 * Where the orbit pivot lands when the camera orbits around the cursor instead
 * of the view centre.
 *
 * The point the user pointed at is what they expect to turn around, so the
 * pivot is the surface under the cursor when there is one, and the build plate
 * otherwise (clamped to the plate's footprint, so a ray that skims the horizon
 * cannot park the pivot thousands of millimetres away).
 *
 * The pivot is the orbit centre the cursor-mode camera (`PivotOrbitController`)
 * turns around: the camera keeps its distance to it, the pivot keeps its screen
 * position, and the horizon stays level.
 */

export type PlatePivotBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const EPSILON = 1e-6;

/**
 * Intersect a pick ray with the build plate (the z = 0 plane) and clamp the hit
 * to the plate footprint. Null when the ray runs parallel to the plate or
 * points away from it.
 */
export function platePivotFromRay(ray: THREE.Ray, bounds: PlatePivotBounds): THREE.Vector3 | null {
  if (Math.abs(ray.direction.z) < EPSILON) return null;

  const distance = -ray.origin.z / ray.direction.z;
  if (!(distance > 0)) return null;

  const point = ray.at(distance, new THREE.Vector3());
  point.x = THREE.MathUtils.clamp(point.x, bounds.minX, bounds.maxX);
  point.y = THREE.MathUtils.clamp(point.y, bounds.minY, bounds.maxY);
  point.z = 0;
  return point;
}
