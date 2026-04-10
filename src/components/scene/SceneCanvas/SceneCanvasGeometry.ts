import * as THREE from 'three';

export function getBoxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const { min, max } = bounds;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ];
}

export function buildBoxWireframePositions(bounds: THREE.Box3): Float32Array {
  const min = bounds.min;
  const max = bounds.max;

  const a = [min.x, min.y, min.z];
  const b = [max.x, min.y, min.z];
  const c = [max.x, max.y, min.z];
  const d = [min.x, max.y, min.z];
  const e = [min.x, min.y, max.z];
  const f = [max.x, min.y, max.z];
  const g = [max.x, max.y, max.z];
  const h = [min.x, max.y, max.z];

  return new Float32Array([
    ...a, ...b,
    ...b, ...c,
    ...c, ...d,
    ...d, ...a,
    ...e, ...f,
    ...f, ...g,
    ...g, ...h,
    ...h, ...e,
    ...a, ...e,
    ...b, ...f,
    ...c, ...g,
    ...d, ...h,
  ]);
}

export function writeCornerOnlyWireframePositions(target: Float32Array, bounds: THREE.Box3, cornerLengthMm = 5): void {
  const min = bounds.min;
  const max = bounds.max;

  const xLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.x - min.x));
  const yLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.y - min.y));
  const zLen = Math.min(Math.max(0, cornerLengthMm), Math.max(0, max.z - min.z));

  const corners: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [
    { x: min.x, y: min.y, z: min.z, sx: 1, sy: 1, sz: 1 },
    { x: max.x, y: min.y, z: min.z, sx: -1, sy: 1, sz: 1 },
    { x: max.x, y: max.y, z: min.z, sx: -1, sy: -1, sz: 1 },
    { x: min.x, y: max.y, z: min.z, sx: 1, sy: -1, sz: 1 },
    { x: min.x, y: min.y, z: max.z, sx: 1, sy: 1, sz: -1 },
    { x: max.x, y: min.y, z: max.z, sx: -1, sy: 1, sz: -1 },
    { x: max.x, y: max.y, z: max.z, sx: -1, sy: -1, sz: -1 },
    { x: min.x, y: max.y, z: max.z, sx: 1, sy: -1, sz: -1 },
  ];

  let index = 0;
  for (const corner of corners) {
    const { x, y, z, sx, sy, sz } = corner;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x + (sx * xLen); target[index++] = y; target[index++] = z;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x; target[index++] = y + (sy * yLen); target[index++] = z;

    target[index++] = x; target[index++] = y; target[index++] = z;
    target[index++] = x; target[index++] = y; target[index++] = z + (sz * zLen);
  }
}

export function buildEmptyCornerOnlyWireframePositions(): Float32Array {
  return new Float32Array(8 * 3 * 2 * 3);
}

function pushUniquePoint(
  points: THREE.Vector3[],
  candidate: THREE.Vector3,
  epsilonSq: number,
): void {
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].distanceToSquared(candidate) <= epsilonSq) {
      return;
    }
  }
  points.push(candidate.clone());
}

export function buildCrossSectionOutlinePositions(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  sliceZ: number,
  epsilon = 1e-4,
): Float32Array | null {
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!positions || positions.count < 3) return null;

  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(positions.count / 3);
  if (triangleCount <= 0) return null;

  const eps = Math.max(1e-7, epsilon);
  const epsSq = eps * eps;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edgePoint = new THREE.Vector3();
  const trianglePoints: THREE.Vector3[] = [];

  const linePositions: number[] = [];
  const segmentKeys = new Set<string>();

  const segmentKey = (p1: THREE.Vector3, p2: THREE.Vector3) => {
    const q = (n: number) => Math.round(n * 1000);
    const a = `${q(p1.x)},${q(p1.y)},${q(p1.z)}`;
    const b = `${q(p2.x)},${q(p2.y)},${q(p2.z)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };

  const appendSegment = (p1: THREE.Vector3, p2: THREE.Vector3) => {
    if (p1.distanceToSquared(p2) <= epsSq) return;
    const key = segmentKey(p1, p2);
    if (segmentKeys.has(key)) return;
    segmentKeys.add(key);

    linePositions.push(
      p1.x, p1.y, p1.z,
      p2.x, p2.y, p2.z,
    );
  };

  const appendEdgeIntersection = (
    p1: THREE.Vector3,
    d1: number,
    p2: THREE.Vector3,
    d2: number,
  ) => {
    const on1 = Math.abs(d1) <= eps;
    const on2 = Math.abs(d2) <= eps;

    if (on1 && on2) {
      pushUniquePoint(trianglePoints, p1, epsSq);
      pushUniquePoint(trianglePoints, p2, epsSq);
      return;
    }

    if (on1) {
      pushUniquePoint(trianglePoints, p1, epsSq);
      return;
    }

    if (on2) {
      pushUniquePoint(trianglePoints, p2, epsSq);
      return;
    }

    if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) {
      const t = d1 / (d1 - d2);
      edgePoint.lerpVectors(p1, p2, t);
      pushUniquePoint(trianglePoints, edgePoint, epsSq);
    }
  };

  const readVertexWorld = (vertexIndex: number, target: THREE.Vector3) => {
    target.fromBufferAttribute(positions, vertexIndex);
    target.applyMatrix4(matrixWorld);
  };

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const ia = index ? index.getX(tri * 3) : tri * 3;
    const ib = index ? index.getX((tri * 3) + 1) : (tri * 3) + 1;
    const ic = index ? index.getX((tri * 3) + 2) : (tri * 3) + 2;

    readVertexWorld(ia, a);
    readVertexWorld(ib, b);
    readVertexWorld(ic, c);

    const da = a.z - sliceZ;
    const db = b.z - sliceZ;
    const dc = c.z - sliceZ;

    const allPositive = da > eps && db > eps && dc > eps;
    const allNegative = da < -eps && db < -eps && dc < -eps;
    if (allPositive || allNegative) continue;

    trianglePoints.length = 0;
    appendEdgeIntersection(a, da, b, db);
    appendEdgeIntersection(b, db, c, dc);
    appendEdgeIntersection(c, dc, a, da);

    if (trianglePoints.length < 2) continue;

    if (trianglePoints.length === 2) {
      appendSegment(trianglePoints[0], trianglePoints[1]);
      continue;
    }

    // Degenerate/coplanar fallback: draw the longest chord from collected points.
    let bestI = 0;
    let bestJ = 1;
    let bestDistSq = trianglePoints[0].distanceToSquared(trianglePoints[1]);
    for (let i = 0; i < trianglePoints.length; i += 1) {
      for (let j = i + 1; j < trianglePoints.length; j += 1) {
        const distSq = trianglePoints[i].distanceToSquared(trianglePoints[j]);
        if (distSq > bestDistSq) {
          bestDistSq = distSq;
          bestI = i;
          bestJ = j;
        }
      }
    }

    appendSegment(trianglePoints[bestI], trianglePoints[bestJ]);
  }

  if (linePositions.length === 0) return null;
  return new Float32Array(linePositions);
}
