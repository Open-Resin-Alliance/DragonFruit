import * as THREE from 'three';
import { ComputeFootprintOptions, FootprintProfile, SupportBaseCircle } from '../RaftTypes';
import { convexHull2d } from './convexHull2d';

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
  const hull = convexHull2d(pts);
  return hull;
}

