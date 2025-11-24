import * as THREE from 'three';
import { FootprintProfile } from '../RaftTypes';

/**
 * Compute combined footprint of model + raft with margin
 * 
 * @param modelGeometry - The model's BufferGeometry
 * @param modelTransform - Transform matrix for the model
 * @param raftProfile - The raft's 2D footprint polygon
 * @param marginMm - Additional outward margin (default 0.5mm)
 * @returns Combined footprint polygon with margin
 */
export function computeCombinedFootprint(
  modelGeometry: THREE.BufferGeometry | null,
  modelTransform: THREE.Matrix4,
  raftProfile: FootprintProfile | null,
  marginMm: number = 0.5
): FootprintProfile {
  const allPoints: THREE.Vector2[] = [];

  // Add raft profile points if available
  if (raftProfile && raftProfile.length > 0) {
    allPoints.push(...raftProfile);
  }

  // Add model footprint points (vertices at or near Z=0 in world space)
  if (modelGeometry) {
    const positions = modelGeometry.attributes.position;
    if (positions) {
      const vertex = new THREE.Vector3();
      const worldVertex = new THREE.Vector3();
      
      // Sample vertices and transform to world space
      for (let i = 0; i < positions.count; i++) {
        vertex.fromBufferAttribute(positions, i);
        worldVertex.copy(vertex).applyMatrix4(modelTransform);
        
        // Include all vertices (we'll compute convex hull anyway)
        // This captures the full XY extent of the model
        allPoints.push(new THREE.Vector2(worldVertex.x, worldVertex.y));
      }
    }
  }

  if (allPoints.length === 0) {
    return [];
  }

  // Compute convex hull of all points
  const hull = convexHull(allPoints);

  // Add margin by offsetting hull outward
  if (marginMm > 0 && hull.length >= 3) {
    return offsetPolygon(hull, marginMm);
  }

  return hull;
}

/**
 * Convex hull using monotonic chain algorithm
 */
function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length <= 1) return points.slice();
  
  const pts = points
    .map((p) => new THREE.Vector2(p.x, p.y))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => 
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: THREE.Vector2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: THREE.Vector2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Offset a convex polygon outward by a given distance
 */
function offsetPolygon(polygon: THREE.Vector2[], distance: number): THREE.Vector2[] {
  if (polygon.length < 3) return polygon;

  const result: THREE.Vector2[] = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    // Edge vectors
    const edge1 = new THREE.Vector2().subVectors(curr, prev).normalize();
    const edge2 = new THREE.Vector2().subVectors(next, curr).normalize();

    // Perpendicular normals (outward)
    const normal1 = new THREE.Vector2(-edge1.y, edge1.x);
    const normal2 = new THREE.Vector2(-edge2.y, edge2.x);

    // Average normal at vertex
    const avgNormal = new THREE.Vector2()
      .addVectors(normal1, normal2)
      .normalize();

    // Compute offset distance accounting for angle
    const cosAngle = normal1.dot(normal2);
    const offsetDist = distance / Math.max(0.1, Math.sqrt((1 + cosAngle) / 2));

    // Offset vertex
    const offsetVertex = new THREE.Vector2()
      .copy(curr)
      .addScaledVector(avgNormal, offsetDist);

    result.push(offsetVertex);
  }

  return result;
}
