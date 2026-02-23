import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

type GeometryLike = Pick<GeometryWithBounds, 'geometry' | 'center'>;

type FootprintCacheEntry = {
  sampledCenteredPoints: Float32Array;
  attributeVersion: number;
  vertexCount: number;
  sizeCache: Map<string, { width: number; depth: number }>;
};

const MAX_SAMPLED_POINTS = 1024;
const MAX_SIZE_CACHE_PER_GEOMETRY = 80;
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
  };

  footprintCache.set(geometry, next);
  return next;
}

export function computeProjectedFootprintSize(
  geometryData: GeometryLike,
  rotation: THREE.Euler,
  scale: THREE.Vector3,
): { width: number; depth: number } {
  const cacheEntry = ensureSampledCenteredPoints(geometryData);
  if (!cacheEntry || cacheEntry.sampledCenteredPoints.length === 0) {
    return { width: 2, depth: 2 };
  }

  const key = makeFootprintKey(rotation, scale);
  const cachedSize = cacheEntry.sizeCache.get(key);
  if (cachedSize) return cachedSize;

  matrixScratch.compose(
    new THREE.Vector3(0, 0, 0),
    quaternionScratch.copy(quaternionFromGlobalEuler(rotation)),
    scale,
  );
  const e = matrixScratch.elements;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const points = cacheEntry.sampledCenteredPoints;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];

    const tx = (x * e[0]) + (y * e[4]) + (z * e[8]) + e[12];
    const ty = (x * e[1]) + (y * e[5]) + (z * e[9]) + e[13];

    if (tx < minX) minX = tx;
    if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty;
    if (ty > maxY) maxY = ty;
  }

  const size = {
    width: Math.max(2, maxX - minX),
    depth: Math.max(2, maxY - minY),
  };

  cacheEntry.sizeCache.set(key, size);
  if (cacheEntry.sizeCache.size > MAX_SIZE_CACHE_PER_GEOMETRY) {
    const first = cacheEntry.sizeCache.keys().next();
    if (!first.done) cacheEntry.sizeCache.delete(first.value);
  }

  return size;
}
