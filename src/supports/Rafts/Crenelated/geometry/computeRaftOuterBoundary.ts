import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';

/**
 * Compute the outer boundary of the complete raft geometry
 * Accounts for:
 * - Base footprint (top surface)
 * - Perimeter wall thickness (extends outward from top surface)
 * 
 * Note: The chamfer makes the BOTTOM surface smaller (inset), not larger.
 * The perimeter wall sits on TOP of the base and extends outward.
 * 
 * @param baseProfile - The raft's base footprint (top surface)
 * @param settings - Raft settings (wall thickness)
 * @returns Outer boundary polygon at top of raft (where wall is)
 */
export function computeRaftOuterBoundary(
  baseProfile: FootprintProfile,
  settings: RaftSettings
): FootprintProfile {
  if (!baseProfile || baseProfile.length < 3) return [];

  const { wallThickness } = settings;

  // The outer boundary is the top surface + wall thickness
  // (The chamfer only affects the bottom, making it smaller)
  return offsetPolygonOutward(baseProfile, wallThickness);
}

/**
 * Offset a polygon outward by a given distance
 * Works for convex polygons (which raft footprints always are)
 */
function offsetPolygonOutward(polygon: THREE.Vector2[], distance: number): THREE.Vector2[] {
  if (polygon.length < 3 || distance <= 0) return polygon.map(p => p.clone());

  const result: THREE.Vector2[] = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    // Edge vectors
    const edge1 = new THREE.Vector2().subVectors(curr, prev).normalize();
    const edge2 = new THREE.Vector2().subVectors(next, curr).normalize();

    // Perpendicular normals (outward for CCW polygon)
    // For a CCW polygon, outward is the right-hand normal: (dy, -dx)
    const normal1 = new THREE.Vector2(edge1.y, -edge1.x);
    const normal2 = new THREE.Vector2(edge2.y, -edge2.x);

    // Average normal at vertex
    const avgNormal = new THREE.Vector2()
      .addVectors(normal1, normal2)
      .normalize();

    // Compute offset distance accounting for angle
    // When edges meet at an angle, we need to extend further to maintain distance
    const cosAngle = normal1.dot(normal2);
    const offsetDist = distance / Math.max(0.1, Math.sqrt((1 + cosAngle) / 2));

    // Offset vertex outward
    const offsetVertex = new THREE.Vector2()
      .copy(curr)
      .addScaledVector(avgNormal, offsetDist);

    result.push(offsetVertex);
  }

  return result;
}
