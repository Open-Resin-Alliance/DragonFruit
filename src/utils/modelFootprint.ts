import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type GeometryLike = Pick<GeometryWithBounds, 'geometry' | 'center'>;

type FootprintCacheEntry = {
  sampledCenteredPoints: Float32Array;
  attributeVersion: number;
  vertexCount: number;
  sizeCache: Map<string, { width: number; depth: number }>;
  hullCache: Map<string, THREE.Vector2[]>;
};

const MAX_SAMPLED_POINTS = 1024;
const MAX_HULL_SCANNED_VERTICES = 160_000;
const HULL_SILHOUETTE_BINS = 96;
const MAX_SIZE_CACHE_PER_GEOMETRY = 80;
const MAX_HULL_CACHE_PER_GEOMETRY = 80;
const QUANTIZE = 1e5;

const footprintCache = new WeakMap<THREE.BufferGeometry, FootprintCacheEntry>();
const matrixScratch = new THREE.Matrix4();
const quaternionScratch = new THREE.Quaternion();

function quantize(n: number): number {
  return Math.round(n * QUANTIZE) / QUANTIZE;
}

function makeFootprintKey(rotation: THREE.Euler, scale: THREE.Vector3): string {
  return [
    quantize(rotation.x), quantize(rotation.y), quantize(rotation.z),
    quantize(scale.x), quantize(scale.y), quantize(scale.z),
  ].join('|');
}

function cloneHull(points: THREE.Vector2[]): THREE.Vector2[] {
  return points.map((point) => point.clone());
}

function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length <= 1) return cloneHull(points);

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

function ensureSampledCenteredPoints(geometryData: GeometryLike): FootprintCacheEntry | null {
  const geometry = geometryData.geometry;
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute || positionAttribute.count === 0) return null;

  const attrVersion = positionAttribute instanceof THREE.BufferAttribute
    ? positionAttribute.version
    : (positionAttribute.data?.version ?? 0);
  const cached = footprintCache.get(geometry);
  if (cached && cached.attributeVersion === attrVersion && cached.vertexCount === positionAttribute.count) {
    return cached;
  }

  const stride = Math.max(1, Math.floor(positionAttribute.count / MAX_SAMPLED_POINTS));
  const sampledCount = Math.ceil(positionAttribute.count / stride);
  const sampled = new Float32Array(sampledCount * 3);
  const cx = geometryData.center.x;
  const cy = geometryData.center.y;
  const cz = geometryData.center.z;

  let writeIdx = 0;
  if (positionAttribute instanceof THREE.BufferAttribute) {
    const source = positionAttribute.array;
    const itemSize = positionAttribute.itemSize;
    for (let i = 0; i < positionAttribute.count; i += stride) {
      const src = i * itemSize;
      sampled[writeIdx++] = source[src] - cx;
      sampled[writeIdx++] = source[src + 1] - cy;
      sampled[writeIdx++] = source[src + 2] - cz;
    }
  } else {
    for (let i = 0; i < positionAttribute.count; i += stride) {
      sampled[writeIdx++] = positionAttribute.getX(i) - cx;
      sampled[writeIdx++] = positionAttribute.getY(i) - cy;
      sampled[writeIdx++] = positionAttribute.getZ(i) - cz;
    }
  }

  const next: FootprintCacheEntry = {
    sampledCenteredPoints: sampled,
    attributeVersion: attrVersion,
    vertexCount: positionAttribute.count,
    sizeCache: new Map<string, { width: number; depth: number }>(),
    hullCache: new Map<string, THREE.Vector2[]>(),
  };

  footprintCache.set(geometry, next);
  return next;
}

export function computeProjectedFootprintHull(
  geometryData: GeometryLike,
  rotation: THREE.Euler,
  scale: THREE.Vector3,
): THREE.Vector2[] {
  const cacheEntry = ensureSampledCenteredPoints(geometryData);
  if (!cacheEntry) return [];

  const key = makeFootprintKey(rotation, scale);
  const cached = cacheEntry.hullCache.get(key);
  if (cached) return cloneHull(cached);

  const geometry = geometryData.geometry;
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute || positionAttribute.count < 3) return [];

  matrixScratch.compose(
    new THREE.Vector3(0, 0, 0),
    quaternionScratch.copy(quaternionFromGlobalEuler(rotation)),
    scale,
  );
  const e = matrixScratch.elements;
  const cx = geometryData.center.x;
  const cy = geometryData.center.y;
  const cz = geometryData.center.z;
  const stride = Math.max(1, Math.ceil(positionAttribute.count / MAX_HULL_SCANNED_VERTICES));

  const binPoints = new Array<THREE.Vector2 | null>(HULL_SILHOUETTE_BINS).fill(null);
  const binDistances = new Array<number>(HULL_SILHOUETTE_BINS).fill(-Infinity);
  const extremes = {
    minX: null as THREE.Vector2 | null,
    maxX: null as THREE.Vector2 | null,
    minY: null as THREE.Vector2 | null,
    maxY: null as THREE.Vector2 | null,
    minDiagA: null as THREE.Vector2 | null,
    maxDiagA: null as THREE.Vector2 | null,
    minDiagB: null as THREE.Vector2 | null,
    maxDiagB: null as THREE.Vector2 | null,
  };
  const values = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minDiagA: Infinity,
    maxDiagA: -Infinity,
    minDiagB: Infinity,
    maxDiagB: -Infinity,
  };

  for (let i = 0; i < positionAttribute.count; i += stride) {
    const x = positionAttribute.getX(i) - cx;
    const y = positionAttribute.getY(i) - cy;
    const z = positionAttribute.getZ(i) - cz;
    const tx = (x * e[0]) + (y * e[4]) + (z * e[8]);
    const ty = (x * e[1]) + (y * e[5]) + (z * e[9]);
    const point = new THREE.Vector2(tx, ty);
    const distSq = tx * tx + ty * ty;
    const angle = Math.atan2(ty, tx);
    const bin = Math.min(
      HULL_SILHOUETTE_BINS - 1,
      Math.max(0, Math.floor(((angle + Math.PI) / (Math.PI * 2)) * HULL_SILHOUETTE_BINS)),
    );

    if (distSq > binDistances[bin]) {
      binDistances[bin] = distSq;
      binPoints[bin] = point;
    }

    const diagA = tx + ty;
    const diagB = tx - ty;
    if (tx < values.minX) { values.minX = tx; extremes.minX = point; }
    if (tx > values.maxX) { values.maxX = tx; extremes.maxX = point; }
    if (ty < values.minY) { values.minY = ty; extremes.minY = point; }
    if (ty > values.maxY) { values.maxY = ty; extremes.maxY = point; }
    if (diagA < values.minDiagA) { values.minDiagA = diagA; extremes.minDiagA = point; }
    if (diagA > values.maxDiagA) { values.maxDiagA = diagA; extremes.maxDiagA = point; }
    if (diagB < values.minDiagB) { values.minDiagB = diagB; extremes.minDiagB = point; }
    if (diagB > values.maxDiagB) { values.maxDiagB = diagB; extremes.maxDiagB = point; }
  }

  const hull = convexHull([
    ...binPoints.filter((point): point is THREE.Vector2 => point !== null),
    ...Object.values(extremes).filter((point): point is THREE.Vector2 => point !== null),
  ]);

  cacheEntry.hullCache.set(key, cloneHull(hull));
  if (cacheEntry.hullCache.size > MAX_HULL_CACHE_PER_GEOMETRY) {
    const first = cacheEntry.hullCache.keys().next();
    if (!first.done) cacheEntry.hullCache.delete(first.value);
  }

  return hull;
}

export function computeProjectedFootprintSize(
  geometryData: GeometryLike,
  rotation: THREE.Euler,
  scale: THREE.Vector3,
): { width: number; depth: number } {
  const cacheEntry = ensureSampledCenteredPoints(geometryData);
  const key = makeFootprintKey(rotation, scale);
  const cachedSize = cacheEntry?.sizeCache.get(key);
  if (cachedSize) return cachedSize;

  const hull = computeProjectedFootprintHull(geometryData, rotation, scale);
  if (hull.length === 0) return { width: 2, depth: 2 };

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of hull) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const size = {
    width: Math.max(2, maxX - minX),
    depth: Math.max(2, maxY - minY),
  };

  if (cacheEntry) {
    cacheEntry.sizeCache.set(key, size);
    if (cacheEntry.sizeCache.size > MAX_SIZE_CACHE_PER_GEOMETRY) {
      const first = cacheEntry.sizeCache.keys().next();
      if (!first.done) cacheEntry.sizeCache.delete(first.value);
    }
  }

  return size;
}
