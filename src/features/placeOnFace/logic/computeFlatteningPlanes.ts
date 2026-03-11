import * as THREE from 'three';
import { ConvexHull } from 'three-stdlib';

export interface FlatteningPlane {
  vertices: THREE.Vector3[];
  normal: THREE.Vector3;
  area: number;
  center: THREE.Vector3;
}

export function computeFlatteningPlanes(geometry: THREE.BufferGeometry): FlatteningPlane[] {
  // 1. Get all vertices from the geometry
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) return [];

  const points: THREE.Vector3[] = [];
  const vertexCount = positionAttribute.count;
  for (let i = 0; i < vertexCount; i++) {
    points.push(new THREE.Vector3().fromBufferAttribute(positionAttribute, i));
  }

  // 2. Generate Convex Hull
  const hull = new ConvexHull().setFromPoints(points);

  // 3. Process faces and group coplanar ones
  // In a ConvexHull, the faces are already well-defined triangles.
  // The PrusaSlicer approach merges adjacent coplanar triangles into larger polygons.
  // For a basic implementation, we can just take the raw hull faces if the hull isn't too complex,
  // or we can just merge them based on normal.
  
  const faces = hull.faces;
  const coplanarGroups = new Map<string, THREE.Vector3[]>();
  
  // A helper to generate a string key for a normal (rounded to group nearly identical normals)
  const getNormalKey = (normal: THREE.Vector3) => {
    return `${normal.x.toFixed(3)},${normal.y.toFixed(3)},${normal.z.toFixed(3)}`;
  };

  faces.forEach((face) => {
    const normal = face.normal;
    const key = getNormalKey(normal);
    
    if (!coplanarGroups.has(key)) {
      coplanarGroups.set(key, []);
    }
    
    const groupPoints = coplanarGroups.get(key)!;
    
    // Add the 3 vertices of this face
    let edge = face.edge;
    do {
      groupPoints.push(edge.vertex.point);
      edge = edge.next;
    } while (edge !== face.edge);
  });

  const planes: FlatteningPlane[] = [];

  // Minimum area filter (in mm^2) to ignore tiny facets
  const MIN_AREA = 5.0;

  coplanarGroups.forEach((groupPoints, keyStr) => {
    const [nx, ny, nz] = keyStr.split(',').map(parseFloat);
    const normal = new THREE.Vector3(nx, ny, nz).normalize();

    // To calculate the area of the projected polygon and find its boundary, 
    // we take the ConvexHull of just these coplanar points.
    // Since points are already on the 3D hull, their 2D projection on this plane is a convex polygon.
    
    // 1. Calculate centroid
    const center = new THREE.Vector3();
    groupPoints.forEach(p => center.add(p));
    center.divideScalar(groupPoints.length);

    // 2. We can just use the points directly if we render them as a triangle fan,
    // but to get the true area and a clean polygon, we sort them angularly around the center.
    // Create a local coordinate system on the plane
    const up = Math.abs(normal.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(normal, up).normalize();
    const upLocal = new THREE.Vector3().crossVectors(right, normal).normalize();

    // Unique points (avoid exact duplicates)
    const uniquePoints: THREE.Vector3[] = [];
    groupPoints.forEach(p => {
      if (!uniquePoints.some(up => up.distanceToSquared(p) < 0.0001)) {
        uniquePoints.push(p);
      }
    });

    // Sort radially
    uniquePoints.sort((a, b) => {
      const dirA = new THREE.Vector3().subVectors(a, center);
      const dirB = new THREE.Vector3().subVectors(b, center);
      const angleA = Math.atan2(dirA.dot(upLocal), dirA.dot(right));
      const angleB = Math.atan2(dirB.dot(upLocal), dirB.dot(right));
      return angleA - angleB;
    });

    // 3. Shoelace formula for area of a 3D planar polygon
    let area = 0;
    for (let i = 0; i < uniquePoints.length; i++) {
      const p1 = uniquePoints[i];
      const p2 = uniquePoints[(i + 1) % uniquePoints.length];
      const cross = new THREE.Vector3().crossVectors(p1, p2);
      area += cross.dot(normal);
    }
    area = Math.abs(area * 0.5);

    if (area >= MIN_AREA) {
      // Shrink the polygon slightly so it doesn't z-fight with the edge
      const shrunkPoints = uniquePoints.map(p => {
        return new THREE.Vector3().lerpVectors(p, center, 0.1);
      });

      // Push it slightly outwards along the normal
      shrunkPoints.forEach(p => p.addScaledVector(normal, 0.1));
      
      const planeCenter = new THREE.Vector3();
      shrunkPoints.forEach(p => planeCenter.add(p));
      planeCenter.divideScalar(shrunkPoints.length);

      planes.push({
        vertices: shrunkPoints,
        normal,
        area,
        center: planeCenter
      });
    }
  });

  // Sort by area descending so the biggest faces are most obviously clickable
  planes.sort((a, b) => b.area - a.area);
  
  // Return top N to avoid making the scene too heavy if it's a crazy shape
  return planes.slice(0, 254);
}
