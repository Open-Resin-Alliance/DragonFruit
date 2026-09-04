import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { quantizeToScale } from '@/utils/math';

type TransformLike = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
};

type GeometryLike = Pick<GeometryWithBounds, 'geometry' | 'bbox' | 'center'>;

type GeometryCacheEntry = {
  centeredPositions: Float32Array;
  attributeVersion: number;
  vertexCount: number;
  boundsCache: Map<string, THREE.Box3>;
};

const geometryCache = new WeakMap<THREE.BufferGeometry, GeometryCacheEntry>();
const MAX_BOUNDS_CACHE_PER_GEOMETRY = 48;
const QUANTIZE = 1e5;

const matrixScratch = new THREE.Matrix4();
const quaternionScratch = new THREE.Quaternion();
const centeredBoxScratch = new THREE.Box3();
const centerOffsetScratch = new THREE.Vector3();

function makeTransformKey(t: TransformLike): string {
  return [
    quantizeToScale(t.position.x, QUANTIZE), quantizeToScale(t.position.y, QUANTIZE), quantizeToScale(t.position.z, QUANTIZE),
    quantizeToScale(t.rotation.x, QUANTIZE), quantizeToScale(t.rotation.y, QUANTIZE), quantizeToScale(t.rotation.z, QUANTIZE),
    quantizeToScale(t.scale.x, QUANTIZE), quantizeToScale(t.scale.y, QUANTIZE), quantizeToScale(t.scale.z, QUANTIZE),
  ].join('|');
}

function ensureCenteredPositionBuffer(geometryData: GeometryLike): GeometryCacheEntry | null {
  const geometry = geometryData.geometry;
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute || positionAttribute.count === 0) return null;

  const attrVersion = positionAttribute instanceof THREE.BufferAttribute
    ? positionAttribute.version
    : (positionAttribute.data?.version ?? 0);
  const cached = geometryCache.get(geometry);
  if (cached && cached.attributeVersion === attrVersion && cached.vertexCount === positionAttribute.count) {
    return cached;
  }

  const centered = new Float32Array(positionAttribute.count * 3);
  const cx = geometryData.center.x;
  const cy = geometryData.center.y;
  const cz = geometryData.center.z;

  if (positionAttribute instanceof THREE.BufferAttribute) {
    const source = positionAttribute.array;
    const itemSize = positionAttribute.itemSize;
    for (let i = 0; i < positionAttribute.count; i++) {
      const src = i * itemSize;
      const dst = i * 3;
      centered[dst] = source[src] - cx;
      centered[dst + 1] = source[src + 1] - cy;
      centered[dst + 2] = source[src + 2] - cz;
    }
  } else {
    for (let i = 0; i < positionAttribute.count; i++) {
      const dst = i * 3;
      centered[dst] = positionAttribute.getX(i) - cx;
      centered[dst + 1] = positionAttribute.getY(i) - cy;
      centered[dst + 2] = positionAttribute.getZ(i) - cz;
    }
  }

  const next: GeometryCacheEntry = {
    centeredPositions: centered,
    attributeVersion: attrVersion,
    vertexCount: positionAttribute.count,
    boundsCache: new Map<string, THREE.Box3>(),
  };

  geometryCache.set(geometry, next);
  return next;
}

/**
 * Mesh vertices with the geometry's own centre offset already removed, so the
 * model transform alone places them in world space. Cached per geometry.
 */
export function getCenteredPositions(geometryData: GeometryLike): Float32Array | null {
  return ensureCenteredPositionBuffer(geometryData)?.centeredPositions ?? null;
}

export function shouldUsePreciseBoundsForTransform(transform: TransformLike, angleEpsilon = 1e-4): boolean {
  const snapStep = Math.PI * 0.5;
  const isNearRightAngle = (angle: number) => {
    const nearest = Math.round(angle / snapStep) * snapStep;
    return Math.abs(angle - nearest) <= angleEpsilon;
  };

  // Fast approximate bounds are exact when orientation is axis-aligned
  // (rotations near multiples of 90°), but can significantly overestimate
  // irregular meshes at arbitrary angles. Use precise bounds in those cases.
  const orthogonalRotation =
    isNearRightAngle(transform.rotation.x)
    && isNearRightAngle(transform.rotation.y)
    && isNearRightAngle(transform.rotation.z);

  return !orthogonalRotation;
}

export function computeApproxModelWorldBounds(
  geometryData: GeometryLike,
  transform: TransformLike,
  out?: THREE.Box3,
): THREE.Box3 {
  const target = out ?? new THREE.Box3();
  centeredBoxScratch.copy(geometryData.bbox);
  centerOffsetScratch.set(-geometryData.center.x, -geometryData.center.y, -geometryData.center.z);
  centeredBoxScratch.translate(centerOffsetScratch);

  matrixScratch.compose(transform.position, quaternionScratch.copy(quaternionFromGlobalEuler(transform.rotation)), transform.scale);
  target.copy(centeredBoxScratch).applyMatrix4(matrixScratch);
  return target;
}

export function computePreciseModelWorldBounds(
  geometryData: GeometryLike,
  transform: TransformLike,
  out?: THREE.Box3,
): THREE.Box3 {
  const target = out ?? new THREE.Box3();
  const cacheEntry = ensureCenteredPositionBuffer(geometryData);
  if (!cacheEntry || cacheEntry.centeredPositions.length === 0) {
    return computeApproxModelWorldBounds(geometryData, transform, target);
  }

  const key = makeTransformKey(transform);
  const cachedBounds = cacheEntry.boundsCache.get(key);
  if (cachedBounds) {
    target.copy(cachedBounds);
    return target;
  }

  matrixScratch.compose(transform.position, quaternionScratch.copy(quaternionFromGlobalEuler(transform.rotation)), transform.scale);
  const e = matrixScratch.elements;
  const points = cacheEntry.centeredPositions;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];

    const tx = (x * e[0]) + (y * e[4]) + (z * e[8]) + e[12];
    const ty = (x * e[1]) + (y * e[5]) + (z * e[9]) + e[13];
    const tz = (x * e[2]) + (y * e[6]) + (z * e[10]) + e[14];

    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tz < minZ) minZ = tz;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
    if (tz > maxZ) maxZ = tz;
  }

  target.min.set(minX, minY, minZ);
  target.max.set(maxX, maxY, maxZ);

  const storeCopy = target.clone();
  cacheEntry.boundsCache.set(key, storeCopy);
  if (cacheEntry.boundsCache.size > MAX_BOUNDS_CACHE_PER_GEOMETRY) {
    const first = cacheEntry.boundsCache.keys().next();
    if (!first.done) cacheEntry.boundsCache.delete(first.value);
  }

  return target;
}

export function isBoundsOutsideVolume(bounds: THREE.Box3, volume: THREE.Box3, epsilonMm: number): boolean {
  return (
    bounds.min.x < (volume.min.x - epsilonMm)
    || bounds.max.x > (volume.max.x + epsilonMm)
    || bounds.min.y < (volume.min.y - epsilonMm)
    || bounds.max.y > (volume.max.y + epsilonMm)
    || bounds.min.z < (volume.min.z - epsilonMm)
    || bounds.max.z > (volume.max.z + epsilonMm)
  );
}
