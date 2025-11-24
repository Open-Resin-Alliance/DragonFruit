import * as THREE from 'three';
import { ComputeFootprintOptions, FootprintProfile, SupportBaseCircle } from '../RaftTypes';

/**
 * Compute a minimal footprint polygon that covers all support base circles.
 * MVP implementation: sample each circle and compute convex hull (monotonic chain).
 */
export function computeFootprint(
  circles: SupportBaseCircle[],
  opts: ComputeFootprintOptions = {}
): FootprintProfile {
  if (!circles || circles.length === 0) return [];

  const margin = opts.marginMm ?? 0.0;
  const samplesPer = Math.max(8, Math.floor(opts.samplesPerCircle ?? 24));

  const pts: THREE.Vector2[] = [];
  const dTheta = (Math.PI * 2) / samplesPer;
  for (const c of circles) {
    const r = Math.max(0, (c.r ?? 0) + margin);
    for (let i = 0; i < samplesPer; i++) {
      const t = i * dTheta;
      pts.push(new THREE.Vector2(c.x + r * Math.cos(t), c.y + r * Math.sin(t)));
    }
  }

  // Compute convex hull using monotonic chain (returns in CCW order)
  const hull = convexHull(pts);
  return hull;
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length <= 1) return points.slice();
  const pts = points
    .map((p) => new THREE.Vector2(p.x, p.y))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: THREE.Vector2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper: THREE.Vector2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
