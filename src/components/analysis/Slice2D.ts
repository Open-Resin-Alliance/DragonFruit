"use client";

import * as THREE from 'three';

const EPS = 1e-6;

function intersectEdge(p1: THREE.Vector3, p2: THREE.Vector3, y: number): THREE.Vector3 | null {
  const y1 = p1.y, y2 = p2.y;
  const dy = y2 - y1;
  if (Math.abs(dy) < EPS) return null;
  const t = (y - y1) / dy;
  if (t < -EPS || t > 1 + EPS) return null;
  return new THREE.Vector3(
    THREE.MathUtils.lerp(p1.x, p2.x, t),
    y,
    THREE.MathUtils.lerp(p1.z, p2.z, t)
  );
}

function key2(v: THREE.Vector2): string {
  return `${Math.round(v.x * 1e5)}:${Math.round(v.y * 1e5)}`;
}

function buildLoops(segments: Array<[THREE.Vector2, THREE.Vector2]>): THREE.Vector2[][] {
  const nextMap = new Map<string, THREE.Vector2[]>();
  for (const [a, b] of segments) {
    const ka = key2(a), kb = key2(b);
    if (!nextMap.has(ka)) nextMap.set(ka, []);
    if (!nextMap.has(kb)) nextMap.set(kb, []);
    nextMap.get(ka)!.push(b);
    nextMap.get(kb)!.push(a);
  }
  const visited = new Set<string>();
  const loops: THREE.Vector2[][] = [];
  for (const [k, neighbors] of nextMap) {
    if (visited.has(k)) continue;
    if (!neighbors.length) continue;
    const start = new THREE.Vector2(parseFloat(k.split(':')[0]) / 1e5, parseFloat(k.split(':')[1]) / 1e5);
    let current = start.clone();
    const loop: THREE.Vector2[] = [start.clone()];
    visited.add(k);
    let guard = 0;
    while (guard++ < 100000) {
      const kn = key2(current);
      const options = nextMap.get(kn) || [];
      let next: THREE.Vector2 | null = null;
      for (const cand of options) {
        const kc = key2(cand);
        if (!visited.has(kc) || (kc === key2(start) && loop.length > 2)) {
          next = cand.clone();
          break;
        }
      }
      if (!next) break;
      loop.push(next.clone());
      const knext = key2(next);
      if (knext === key2(start)) {
        break; // closed
      }
      visited.add(knext);
      current = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function computeLoopsAtY(geometry: THREE.BufferGeometry, y: number): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  // Nudge the slicing plane slightly upward to capture coplanar top faces as outlines
  const ySlice = y + 1e-5;
  for (let i = 0; i < pos.count; i += 3) {
    const v0 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const v1 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    const v2 = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    const vs = [v0, v1, v2];
    const above = vs.map(v => v.y >= ySlice + 10 * EPS);
    const below = vs.map(v => v.y <= ySlice - 10 * EPS);
    if ((above[0] && above[1] && above[2]) || (below[0] && below[1] && below[2])) continue;
    const points: THREE.Vector3[] = [];
    const e01 = intersectEdge(v0, v1, ySlice); if (e01) points.push(e01);
    const e12 = intersectEdge(v1, v2, ySlice); if (e12) points.push(e12);
    const e20 = intersectEdge(v2, v0, ySlice); if (e20) points.push(e20);
    if (points.length === 2) {
      const a = new THREE.Vector2(points[0].x, -points[0].z);
      const b = new THREE.Vector2(points[1].x, -points[1].z);
      segments.push([a, b]);
    }
  }
  return buildLoops(segments);
}

// Slice at Z height (for Z-up coordinate system)
export function computeLoopsAtZ(geometry: THREE.BufferGeometry, z: number): THREE.Vector2[][] {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  const zSlice = z + 1e-5;

  function intersectEdgeZ(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
    const dz = b.z - a.z;
    if (Math.abs(dz) < EPS) return null;
    const t = (zSlice - a.z) / dz;
    if (t < -EPS || t > 1 + EPS) return null;
    return new THREE.Vector3(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), zSlice);
  }

  for (let i = 0; i < pos.count; i += 3) {
    const v0 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const v1 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    const v2 = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    const vs = [v0, v1, v2];
    const above = vs.map(v => v.z >= zSlice + 10 * EPS);
    const below = vs.map(v => v.z <= zSlice - 10 * EPS);
    if ((above[0] && above[1] && above[2]) || (below[0] && below[1] && below[2])) continue;
    const points: THREE.Vector3[] = [];
    const e01 = intersectEdgeZ(v0, v1); if (e01) points.push(e01);
    const e12 = intersectEdgeZ(v1, v2); if (e12) points.push(e12);
    const e20 = intersectEdgeZ(v2, v0); if (e20) points.push(e20);
    if (points.length === 2) {
      const a = new THREE.Vector2(points[0].x, -points[0].y);
      const b = new THREE.Vector2(points[1].x, -points[1].y);
      segments.push([a, b]);
    }
  }
  return buildLoops(segments);
}

export function polygonArea(loop: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    area += (loop[j].x * loop[i].y - loop[i].x * loop[j].y);
  }
  return Math.abs(area) * 0.5;
}

export function computeLoopsFromPositions(positions: Float32Array, z: number): THREE.Vector2[][] {
  const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
  const zSlice = z + 1e-5;

  function intersectEdgeZ(ax: number, ay: number, az: number, bx: number, by: number, bz: number): THREE.Vector3 | null {
    const dz = bz - az;
    if (Math.abs(dz) < EPS) return null;
    const t = (zSlice - az) / dz;
    if (t < -EPS || t > 1 + EPS) return null;
    return new THREE.Vector3(ax + t * (bx - ax), ay + t * (by - ay), zSlice);
  }

  for (let i = 0; i < positions.length; i += 9) {
    const v0x = positions[i], v0y = positions[i + 1], v0z = positions[i + 2];
    const v1x = positions[i + 3], v1y = positions[i + 4], v1z = positions[i + 5];
    const v2x = positions[i + 6], v2y = positions[i + 7], v2z = positions[i + 8];

    const above0 = v0z >= zSlice + 10 * EPS;
    const above1 = v1z >= zSlice + 10 * EPS;
    const above2 = v2z >= zSlice + 10 * EPS;

    const below0 = v0z <= zSlice - 10 * EPS;
    const below1 = v1z <= zSlice - 10 * EPS;
    const below2 = v2z <= zSlice - 10 * EPS;

    if ((above0 && above1 && above2) || (below0 && below1 && below2)) continue;

    const points: THREE.Vector3[] = [];
    const e01 = intersectEdgeZ(v0x, v0y, v0z, v1x, v1y, v1z); if (e01) points.push(e01);
    const e12 = intersectEdgeZ(v1x, v1y, v1z, v2x, v2y, v2z); if (e12) points.push(e12);
    const e20 = intersectEdgeZ(v2x, v2y, v2z, v0x, v0y, v0z); if (e20) points.push(e20);

    if (points.length === 2) {
      const a = new THREE.Vector2(points[0].x, -points[0].y);
      const b = new THREE.Vector2(points[1].x, -points[1].y);
      segments.push([a, b]);
    }
  }
  return buildLoops(segments);
}

export class BucketedSlicer {
  private positions: Float32Array;
  private buckets: Int32Array[];
  private minZ: number;
  private bucketHeight: number;

  constructor(positions: Float32Array, bucketHeight = 5.0) {
    this.positions = positions;
    this.bucketHeight = bucketHeight;

    // 1. Find Z bounds
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < positions.length; i += 3) {
      const z = positions[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    this.minZ = minZ;

    // 2. Initialize buckets
    const numBuckets = Math.ceil((maxZ - minZ) / bucketHeight) + 1;
    const tempBuckets: number[][] = Array.from({ length: numBuckets }, () => []);

    // 3. Fill buckets
    for (let i = 0; i < positions.length; i += 9) {
      const z0 = positions[i + 2];
      const z1 = positions[i + 5];
      const z2 = positions[i + 8];

      const triMinZ = Math.min(z0, z1, z2);
      const triMaxZ = Math.max(z0, z1, z2);

      const startBucket = Math.floor((triMinZ - minZ) / bucketHeight);
      const endBucket = Math.floor((triMaxZ - minZ) / bucketHeight);

      for (let b = startBucket; b <= endBucket; b++) {
        if (b >= 0 && b < numBuckets) {
          tempBuckets[b].push(i); // Store triangle start index
        }
      }
    }

    // 4. Compact to typed arrays
    this.buckets = tempBuckets.map(b => new Int32Array(b));
  }

  slice(z: number): THREE.Vector2[][] {
    const bucketIdx = Math.floor((z - this.minZ) / this.bucketHeight);
    if (bucketIdx < 0 || bucketIdx >= this.buckets.length) return [];

    const indices = this.buckets[bucketIdx];
    const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
    const zSlice = z + 1e-5;
    const positions = this.positions;

    function intersectEdgeZ(ax: number, ay: number, az: number, bx: number, by: number, bz: number): THREE.Vector3 | null {
      const dz = bz - az;
      if (Math.abs(dz) < EPS) return null;
      const t = (zSlice - az) / dz;
      if (t < -EPS || t > 1 + EPS) return null;
      return new THREE.Vector3(ax + t * (bx - ax), ay + t * (by - ay), zSlice);
    }

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const v0x = positions[i], v0y = positions[i + 1], v0z = positions[i + 2];
      const v1x = positions[i + 3], v1y = positions[i + 4], v1z = positions[i + 5];
      const v2x = positions[i + 6], v2y = positions[i + 7], v2z = positions[i + 8];

      const above0 = v0z >= zSlice + 10 * EPS;
      const above1 = v1z >= zSlice + 10 * EPS;
      const above2 = v2z >= zSlice + 10 * EPS;

      const below0 = v0z <= zSlice - 10 * EPS;
      const below1 = v1z <= zSlice - 10 * EPS;
      const below2 = v2z <= zSlice - 10 * EPS;

      if ((above0 && above1 && above2) || (below0 && below1 && below2)) continue;

      const points: THREE.Vector3[] = [];
      const e01 = intersectEdgeZ(v0x, v0y, v0z, v1x, v1y, v1z); if (e01) points.push(e01);
      const e12 = intersectEdgeZ(v1x, v1y, v1z, v2x, v2y, v2z); if (e12) points.push(e12);
      const e20 = intersectEdgeZ(v2x, v2y, v2z, v0x, v0y, v0z); if (e20) points.push(e20);

      if (points.length === 2) {
        const a = new THREE.Vector2(points[0].x, -points[0].y);
        const b = new THREE.Vector2(points[1].x, -points[1].y);
        segments.push([a, b]);
      }
    }
    return buildLoops(segments);
  }
}
