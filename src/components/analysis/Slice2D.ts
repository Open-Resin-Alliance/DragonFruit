"use client";

import * as THREE from 'three';

const Z_TOL = 3e-5;

export interface OrientedSegment2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  wind: number;
}

interface PtScratch {
  x: number;
  y: number;
}

function edgePlaneCrossingT(a: number, b: number, plane: number): number | null {
  const d1 = a - plane;
  const d2 = b - plane;
  const crosses = (d1 <= 0 && d2 > 0) || (d2 <= 0 && d1 > 0);
  if (!crosses) return null;
  const denom = b - a;
  if (Math.abs(denom) < 1e-12) return null;
  return (plane - a) / denom;
}

function distinctPointPush(
  pts: [PtScratch, PtScratch, PtScratch],
  count: number,
  x: number,
  y: number,
  eps = 1e-5,
): number {
  for (let i = 0; i < count; i++) {
    if (Math.abs(x - pts[i].x) <= eps && Math.abs(y - pts[i].y) <= eps) {
      return count;
    }
  }
  if (count < 3) {
    pts[count].x = x;
    pts[count].y = y;
    return count + 1;
  }
  return count;
}

function extractTriangleSegmentAtZ(
  v0x: number,
  v0y: number,
  v0z: number,
  v1x: number,
  v1y: number,
  v1z: number,
  v2x: number,
  v2y: number,
  v2z: number,
  zSlice: number,
  pts: [PtScratch, PtScratch, PtScratch],
): OrientedSegment2D | null {
  const triMinZ = Math.min(v0z, v1z, v2z);
  const triMaxZ = Math.max(v0z, v1z, v2z);
  if (zSlice < triMinZ || zSlice >= triMaxZ) return null;

  let count = 0;
  const t01 = edgePlaneCrossingT(v0z, v1z, zSlice);
  if (t01 !== null) {
    count = distinctPointPush(pts, count, v0x + t01 * (v1x - v0x), -(v0y + t01 * (v1y - v0y)));
  }
  const t12 = edgePlaneCrossingT(v1z, v2z, zSlice);
  if (t12 !== null) {
    count = distinctPointPush(pts, count, v1x + t12 * (v2x - v1x), -(v1y + t12 * (v2y - v1y)));
  }
  const t20 = edgePlaneCrossingT(v2z, v0z, zSlice);
  if (t20 !== null) {
    count = distinctPointPush(pts, count, v2x + t20 * (v0x - v2x), -(v2y + t20 * (v0y - v2y)));
  }
  if (count < 2) return null;

  let p0x = pts[0].x;
  let p0y = pts[0].y;
  let p1x = pts[1].x;
  let p1y = pts[1].y;

  const ux = v1x - v0x;
  const uy = v1y - v0y;
  const uz = v1z - v0z;
  const vx = v2x - v0x;
  const vy = v2y - v0y;
  const vz = v2z - v0z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;

  // World direction n x +Z = (ny, -nx) projects into 2D (x, -y) as (ny, +nx).
  if ((p1x - p0x) * ny + (p1y - p0y) * nx < 0) {
    const tx = p0x;
    const ty = p0y;
    p0x = p1x;
    p0y = p1y;
    p1x = tx;
    p1y = ty;
  }

  const wind = nx > 0 ? -1 : (nx < 0 ? 1 : 0);
  return { x1: p0x, y1: p0y, x2: p1x, y2: p1y, wind };
}

function extractSegmentsFromPositions(
  positions: Float32Array,
  indices: Int32Array | null,
  z: number,
  skipHorizontal: boolean,
): OrientedSegment2D[] {
  const zSlice = z + 1e-5;
  const segments: OrientedSegment2D[] = [];
  const pts: [PtScratch, PtScratch, PtScratch] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  if (indices === null) {
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const seg = extractTriangleSegmentAtZ(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        positions[i + 3],
        positions[i + 4],
        positions[i + 5],
        positions[i + 6],
        positions[i + 7],
        positions[i + 8],
        zSlice,
        pts,
      );
      if (!seg) continue;
      if (skipHorizontal && (seg.wind === 0 || Math.abs(seg.y2 - seg.y1) < 1e-8)) continue;
      segments.push(seg);
    }
  } else {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const seg = extractTriangleSegmentAtZ(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        positions[i + 3],
        positions[i + 4],
        positions[i + 5],
        positions[i + 6],
        positions[i + 7],
        positions[i + 8],
        zSlice,
        pts,
      );
      if (!seg) continue;
      if (skipHorizontal && (seg.wind === 0 || Math.abs(seg.y2 - seg.y1) < 1e-8)) continue;
      segments.push(seg);
    }
  }

  return segments;
}

function key2(v: THREE.Vector2): string {
  return `${Math.round(v.x * 1e5)}:${Math.round(v.y * 1e5)}`;
}

function buildLoops(segments: Array<[THREE.Vector2, THREE.Vector2]>): THREE.Vector2[][] {
  if (segments.length === 0) return [];
  interface AdjEdge {
    to: THREE.Vector2;
    toKey: string;
    idx: number;
  }
  const outMap = new Map<string, AdjEdge[]>();
  const undirMap = new Map<string, AdjEdge[]>();

  for (let idx = 0; idx < segments.length; idx++) {
    const [a, b] = segments[idx];
    const ka = key2(a);
    const kb = key2(b);
    if (ka === kb) continue;

    let outList = outMap.get(ka);
    if (!outList) {
      outList = [];
      outMap.set(ka, outList);
    }
    outList.push({ to: b, toKey: kb, idx });

    let ua = undirMap.get(ka);
    if (!ua) {
      ua = [];
      undirMap.set(ka, ua);
    }
    ua.push({ to: b, toKey: kb, idx });

    let ub = undirMap.get(kb);
    if (!ub) {
      ub = [];
      undirMap.set(kb, ub);
    }
    ub.push({ to: a, toKey: ka, idx });
  }

  const used = new Uint8Array(segments.length);
  const loops: THREE.Vector2[][] = [];

  for (let startIdx = 0; startIdx < segments.length; startIdx++) {
    if (used[startIdx]) continue;
    const [startA, startB] = segments[startIdx];
    const startKey = key2(startA);
    const firstKey = key2(startB);
    if (startKey === firstKey) {
      used[startIdx] = 1;
      continue;
    }

    used[startIdx] = 1;
    const loop: THREE.Vector2[] = [startA.clone(), startB.clone()];
    let curKey = firstKey;
    let guard = 0;

    while (guard++ <= segments.length) {
      if (curKey === startKey) break;

      let chosen: AdjEdge | null = null;
      const outOpts = outMap.get(curKey);
      if (outOpts) {
        for (let j = 0; j < outOpts.length; j++) {
          const cand = outOpts[j];
          if (used[cand.idx]) continue;
          if (cand.toKey === startKey && loop.length >= 3) {
            chosen = cand;
            break;
          }
          if (!chosen && cand.toKey !== startKey) {
            chosen = cand;
          }
        }
        if (!chosen) {
          for (let j = 0; j < outOpts.length; j++) {
            if (!used[outOpts[j].idx]) {
              chosen = outOpts[j];
              break;
            }
          }
        }
      }

      if (!chosen) {
        const uOpts = undirMap.get(curKey);
        if (uOpts) {
          for (let j = 0; j < uOpts.length; j++) {
            const cand = uOpts[j];
            if (used[cand.idx]) continue;
            if (cand.toKey === startKey && loop.length >= 3) {
              chosen = cand;
              break;
            }
            if (!chosen && cand.toKey !== startKey) {
              chosen = cand;
            }
          }
          if (!chosen) {
            for (let j = 0; j < uOpts.length; j++) {
              if (!used[uOpts[j].idx]) {
                chosen = uOpts[j];
                break;
              }
            }
          }
        }
      }

      if (!chosen) break;
      used[chosen.idx] = 1;
      curKey = chosen.toKey;
      if (curKey === startKey) {
        break;
      }
      loop.push(chosen.to.clone());
    }

    if (loop.length >= 3) {
      loops.push(loop);
    }
  }

  return loops;
}

function buildLoopsFromOriented(segments: OrientedSegment2D[]): THREE.Vector2[][] {
  if (segments.length === 0) return [];
  const pairs: Array<[THREE.Vector2, THREE.Vector2]> = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    pairs[i] = [new THREE.Vector2(s.x1, s.y1), new THREE.Vector2(s.x2, s.y2)];
  }
  return buildLoops(pairs);
}

export function computeLoopsAtY(geometry: THREE.BufferGeometry, y: number): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return [];
  const index = geometry.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  // Nudge the slicing plane slightly upward to capture coplanar top faces as outlines
  const ySlice = y + 1e-5;
  const pts: [PtScratch, PtScratch, PtScratch] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= pos.count || i1 >= pos.count || i2 >= pos.count) continue;

    const v0x = pos.getX(i0), v0y = pos.getY(i0), v0z = pos.getZ(i0);
    const v1x = pos.getX(i1), v1y = pos.getY(i1), v1z = pos.getZ(i1);
    const v2x = pos.getX(i2), v2y = pos.getY(i2), v2z = pos.getZ(i2);

    const triMinY = Math.min(v0y, v1y, v2y);
    const triMaxY = Math.max(v0y, v1y, v2y);
    if (ySlice < triMinY || ySlice >= triMaxY) continue;

    let count = 0;
    const t01 = edgePlaneCrossingT(v0y, v1y, ySlice);
    if (t01 !== null) {
      count = distinctPointPush(pts, count, v0x + t01 * (v1x - v0x), -(v0z + t01 * (v1z - v0z)));
    }
    const t12 = edgePlaneCrossingT(v1y, v2y, ySlice);
    if (t12 !== null) {
      count = distinctPointPush(pts, count, v1x + t12 * (v2x - v1x), -(v1z + t12 * (v2z - v1z)));
    }
    const t20 = edgePlaneCrossingT(v2y, v0y, ySlice);
    if (t20 !== null) {
      count = distinctPointPush(pts, count, v2x + t20 * (v0x - v2x), -(v2z + t20 * (v0z - v2z)));
    }
    if (count < 2) continue;

    let p0x = pts[0].x;
    let p0y = pts[0].y;
    let p1x = pts[1].x;
    let p1y = pts[1].y;

    const ux = v1x - v0x, uy = v1y - v0y, uz = v1z - v0z;
    const vx = v2x - v0x, vy = v2y - v0y, vz = v2z - v0z;
    const nx = uy * vz - uz * vy;
    const nz = ux * vy - uy * vx;
    // n x +Y = (-nz, 0, nx) projects into 2D (x, -z) as (-nz, -nx).
    if ((p1x - p0x) * -nz + (p1y - p0y) * -nx < 0) {
      const tx = p0x;
      const ty = p0y;
      p0x = p1x;
      p0y = p1y;
      p1x = tx;
      p1y = ty;
    }

    segments.push([new THREE.Vector2(p0x, p0y), new THREE.Vector2(p1x, p1y)]);
  }
  return buildLoops(segments);
}

// Slice at Z height (for Z-up coordinate system)
export function computeLoopsAtZ(geometry: THREE.BufferGeometry, z: number): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return [];
  const index = geometry.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  const zSlice = z + 1e-5;
  const oriented: OrientedSegment2D[] = [];
  const pts: [PtScratch, PtScratch, PtScratch] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= pos.count || i1 >= pos.count || i2 >= pos.count) continue;

    const seg = extractTriangleSegmentAtZ(
      pos.getX(i0),
      pos.getY(i0),
      pos.getZ(i0),
      pos.getX(i1),
      pos.getY(i1),
      pos.getZ(i1),
      pos.getX(i2),
      pos.getY(i2),
      pos.getZ(i2),
      zSlice,
      pts,
    );
    if (seg) oriented.push(seg);
  }
  return buildLoopsFromOriented(oriented);
}

export function polygonArea(loop: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    area += (loop[j].x * loop[i].y - loop[i].x * loop[j].y);
  }
  return Math.abs(area) * 0.5;
}

export function computeSegmentsFromPositions(positions: Float32Array, z: number): OrientedSegment2D[] {
  return extractSegmentsFromPositions(positions, null, z, true);
}

export function computeLoopsFromPositions(positions: Float32Array, z: number): THREE.Vector2[][] {
  return buildLoopsFromOriented(extractSegmentsFromPositions(positions, null, z, false));
}

export class BucketedSlicer {
  private positions: Float32Array;
  private buckets: Int32Array[];
  private minZ: number;
  private maxZ: number;
  private bucketHeight: number;

  constructor(positions: Float32Array, bucketHeight = 5.0) {
    this.positions = positions;
    this.bucketHeight = bucketHeight;

    if (positions.length < 9) {
      this.minZ = 0;
      this.maxZ = 0;
      this.buckets = [];
      return;
    }

    // 1. Find Z bounds
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < positions.length; i += 3) {
      const z = positions[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    this.minZ = minZ;
    this.maxZ = maxZ;

    // 2. Initialize buckets
    const numBuckets = Math.max(1, Math.ceil((maxZ - minZ) / bucketHeight) + 1);
    const tempBuckets: number[][] = Array.from({ length: numBuckets }, () => []);

    // 3. Fill buckets with Z_TOL boundary margin
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const z0 = positions[i + 2];
      const z1 = positions[i + 5];
      const z2 = positions[i + 8];

      const triMinZ = Math.min(z0, z1, z2);
      const triMaxZ = Math.max(z0, z1, z2);

      const startBucket = Math.max(0, Math.floor((triMinZ - Z_TOL - minZ) / bucketHeight));
      const endBucket = Math.min(numBuckets - 1, Math.floor((triMaxZ + Z_TOL - minZ) / bucketHeight));

      for (let b = startBucket; b <= endBucket; b++) {
        tempBuckets[b].push(i); // Store triangle start index
      }
    }

    // 4. Compact to typed arrays
    this.buckets = tempBuckets.map(b => new Int32Array(b));
  }

  private getBucketIndicesForZ(z: number): Int32Array | null {
    const zSlice = z + 1e-5;
    if (this.buckets.length === 0 || zSlice < this.minZ - Z_TOL || zSlice > this.maxZ + Z_TOL) {
      return null;
    }
    const bucketIdx = Math.min(
      this.buckets.length - 1,
      Math.max(0, Math.floor((zSlice - this.minZ) / this.bucketHeight)),
    );
    return this.buckets[bucketIdx];
  }

  sliceSegments(z: number): OrientedSegment2D[] {
    const indices = this.getBucketIndicesForZ(z);
    if (!indices || indices.length === 0) return [];
    return extractSegmentsFromPositions(this.positions, indices, z, true);
  }

  slice(z: number): THREE.Vector2[][] {
    const indices = this.getBucketIndicesForZ(z);
    if (!indices || indices.length === 0) return [];
    return buildLoopsFromOriented(extractSegmentsFromPositions(this.positions, indices, z, false));
  }
}
