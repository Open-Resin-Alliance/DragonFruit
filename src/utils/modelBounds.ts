import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { quantizeToScale } from '@/utils/math';

export type TransformLike = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
};

type GeometryLike = Pick<GeometryWithBounds, 'geometry' | 'bbox' | 'center'>;

type GeometryCacheEntry = {
  attributeVersion: number;
  vertexCount: number;
  boundsCache: Map<string, THREE.Box3>;
};

/** The geometry's own vertex array plus the centre to subtract; no copy is made. */
export type CenteredPositionSource = {
  array: Float32Array;
  itemSize: number;
  count: number;
  center: THREE.Vector3;
};

const geometryCache = new WeakMap<THREE.BufferGeometry, GeometryCacheEntry>();
const MAX_BOUNDS_CACHE_PER_GEOMETRY = 48;
const QUANTIZE = 1e5;

const matrixScratch = new THREE.Matrix4();
const quaternionScratch = new THREE.Quaternion();
const centeredBoxScratch = new THREE.Box3();
const centerOffsetScratch = new THREE.Vector3();
const originScratch = new THREE.Vector3();

/**
 * The part of a transform the precise walk depends on: how the vertices are
 * oriented and sized, not where they sit.
 *
 * The position is deliberately absent. A translation moves every vertex by the
 * same vector, so it moves the resulting box by that vector and changes nothing
 * else - the walk is over the same points either way. Keeping it in the key gave
 * a drag a fresh key on every frame, and a full walk over every vertex with it:
 * the cost a complex model paid per frame and a small one did not.
 */
function makeOrientationKey(t: TransformLike): string {
  return [
    quantizeToScale(t.rotation.x, QUANTIZE), quantizeToScale(t.rotation.y, QUANTIZE), quantizeToScale(t.rotation.z, QUANTIZE),
    quantizeToScale(t.scale.x, QUANTIZE), quantizeToScale(t.scale.y, QUANTIZE), quantizeToScale(t.scale.z, QUANTIZE),
  ].join('|');
}

function boundsCacheFor(geometryData: GeometryLike): GeometryCacheEntry | null {
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

  const next: GeometryCacheEntry = {
    attributeVersion: attrVersion,
    vertexCount: positionAttribute.count,
    boundsCache: new Map<string, THREE.Box3>(),
  };
  geometryCache.set(geometry, next);
  return next;
}

/** Drop the derived bounds cache for a geometry that is being released. */
export function forgetCenteredPositions(geometry: THREE.BufferGeometry): void {
  geometryCache.delete(geometry);
}

/**
 * The original position array and centre. Keeping no centred copy matters: the
 * model was held by React's development fiber tree, so a WeakMap value keyed by
 * its geometry stayed alive and duplicated every vertex buffer (~20 MB a model).
 */
export function getCenteredPositionSource(geometryData: GeometryLike): CenteredPositionSource | null {
  const positionAttribute = geometryData.geometry.getAttribute('position');
  if (!(positionAttribute instanceof THREE.BufferAttribute) || positionAttribute.count === 0) return null;
  return {
    array: positionAttribute.array as Float32Array,
    itemSize: positionAttribute.itemSize,
    count: positionAttribute.count,
    center: geometryData.center,
  };
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
  const source = getCenteredPositionSource(geometryData);
  const cacheEntry = source ? boundsCacheFor(geometryData) : null;
  if (!source || !cacheEntry) {
    return computeApproxModelWorldBounds(geometryData, transform, target);
  }

  const key = makeOrientationKey(transform);
  const cachedBounds = cacheEntry.boundsCache.get(key);
  if (cachedBounds) {
    target.copy(cachedBounds).translate(transform.position);
    return target;
  }

  // Walked with the position held at the origin: the rotation and scale are what
  // the walk is for, and the position is added to the box afterwards. Translating
  // a box is exact, so this is the same answer for a fraction of the work.
  matrixScratch.compose(originScratch, quaternionScratch.copy(quaternionFromGlobalEuler(transform.rotation)), transform.scale);
  const e = matrixScratch.elements;
  const points = source.array;
  const itemSize = source.itemSize;
  const centerX = source.center.x;
  const centerY = source.center.y;
  const centerZ = source.center.z;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < source.count; i += 1) {
    const offset = i * itemSize;
    const x = points[offset] - centerX;
    const y = points[offset + 1] - centerY;
    const z = points[offset + 2] - centerZ;

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

  return target.translate(transform.position);
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

/**
 * True when `bounds` and `volume` share no space on any axis, so nothing inside
 * the bounds can print.
 *
 * Distinct from `isBoundsOutsideVolume`, which asks whether the bounds leave the
 * volume at all: a model that merely straddles a plate edge fails that test but
 * is not disjoint. Slicing retains its closed surface and limits raster output
 * to the printable footprint.
 */
export function isBoundsDisjointFromVolume(bounds: THREE.Box3, volume: THREE.Box3, epsilonMm: number): boolean {
  return (
    bounds.max.x < (volume.min.x - epsilonMm)
    || bounds.min.x > (volume.max.x + epsilonMm)
    || bounds.max.y < (volume.min.y - epsilonMm)
    || bounds.min.y > (volume.max.y + epsilonMm)
    || bounds.max.z < (volume.min.z - epsilonMm)
    || bounds.min.z > (volume.max.z + epsilonMm)
  );
}
