import * as THREE from 'three';
import { ConvexHull } from 'three-stdlib';

export interface FlatteningPlane {
  vertices: THREE.Vector3[];
  normal: THREE.Vector3;
  area: number;
  center: THREE.Vector3;
}

export function computeFlatteningPlanes(geometry: THREE.BufferGeometry): FlatteningPlane[] {
  console.time('computeFlatteningPlanes');
  console.time('1. extract and decimate vertices');
  // 1. Get all vertices from the geometry
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) {
    console.timeEnd('1. extract and decimate vertices');
    console.timeEnd('computeFlatteningPlanes');
    return [];
  }

  const posArray = positionAttribute.array;
  const vertexCount = positionAttribute.count;

  // Compute a grid size based on the model's bounding box
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const maxDim = Math.max(bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y, bbox.max.z - bbox.min.z);
  
  // A 40x40x40 grid ensures we never process more than a few thousand points
  const cellSize = Math.max(0.1, maxDim / 40.0);
  const invCellSize = 1.0 / cellSize;

  const cellMap = new Set<string>();
  const points: THREE.Vector3[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const x = posArray[i * 3];
    const y = posArray[i * 3 + 1];
    const z = posArray[i * 3 + 2];
    
    // Map to a 3D grid cell
    const cx = Math.round(x * invCellSize);
    const cy = Math.round(y * invCellSize);
    const cz = Math.round(z * invCellSize);
    const hash = `${cx},${cy},${cz}`;
    
    // Only keep ONE exact original point per cell
    if (!cellMap.has(hash)) {
      cellMap.add(hash);
      points.push(new THREE.Vector3(x, y, z));
    }
  }

  console.timeEnd('1. extract and decimate vertices');
  console.log(`Grid decimated from ${vertexCount} geometries to ${points.length} convex hull candidate points.`);

  console.time('2. ConvexHull generation');
  // 2. Generate Convex Hull
  const hull = new ConvexHull().setFromPoints(points);
  console.timeEnd('2. ConvexHull generation');

  console.time('3. Process and group faces');
  // 3. Process faces and group coplanar ones
  const faces = hull.faces;
  const coplanarGroups = new Map<string, THREE.Vector3[]>();
  
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
    
    let edge = face.edge;
    do {
      groupPoints.push(edge.vertex.point);
      edge = edge.next;
    } while (edge !== face.edge);
  });
  console.timeEnd('3. Process and group faces');

  console.time('4. Create planes');
  const planes: FlatteningPlane[] = [];
  const MIN_AREA = 5.0;
  const OVERLAY_SURFACE_OFFSET_MM = 0.2;

  coplanarGroups.forEach((groupPoints, keyStr) => {
    const [nx, ny, nz] = keyStr.split(',').map(parseFloat);
    const normal = new THREE.Vector3(nx, ny, nz).normalize();

    const center = new THREE.Vector3();
    groupPoints.forEach(p => center.add(p));
    center.divideScalar(groupPoints.length);

    const up = Math.abs(normal.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(normal, up).normalize();
    const upLocal = new THREE.Vector3().crossVectors(right, normal).normalize();

    // Unique points (avoid exact duplicates) using an O(N) spatial hash instead of O(N^2) distance checks
    const uniquePointsMap = new Map<string, THREE.Vector3>();
    groupPoints.forEach(p => {
      const hash = `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
      if (!uniquePointsMap.has(hash)) {
        uniquePointsMap.set(hash, p);
      }
    });
    const uniquePoints = Array.from(uniquePointsMap.values());

    uniquePoints.sort((a, b) => {
      const dirA = new THREE.Vector3().subVectors(a, center);
      const dirB = new THREE.Vector3().subVectors(b, center);
      const angleA = Math.atan2(dirA.dot(upLocal), dirA.dot(right));
      const angleB = Math.atan2(dirB.dot(upLocal), dirB.dot(right));
      return angleA - angleB;
    });

    let area = 0;
    for (let i = 0; i < uniquePoints.length; i++) {
      const p1 = uniquePoints[i];
      const p2 = uniquePoints[(i + 1) % uniquePoints.length];
      const cross = new THREE.Vector3().crossVectors(p1, p2);
      area += cross.dot(normal);
    }
    area = Math.abs(area * 0.5);

    if (area >= MIN_AREA) {
      const shrunkPoints = uniquePoints.map(p => {
        return new THREE.Vector3().lerpVectors(p, center, 0.1);
      });

      // Push clickable face overlays slightly off the model surface to avoid
      // z-fighting/clipping while hovering.
      shrunkPoints.forEach(p => p.addScaledVector(normal, OVERLAY_SURFACE_OFFSET_MM));
      
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
  console.timeEnd('4. Create planes');

  planes.sort((a, b) => b.area - a.area);
  console.timeEnd('computeFlatteningPlanes');
  return planes.slice(0, 254);
}
