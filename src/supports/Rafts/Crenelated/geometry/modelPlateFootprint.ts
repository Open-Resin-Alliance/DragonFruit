import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { quantizeToScale } from '@/utils/math';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { unionPolygonSets, type PolygonWithHoles } from './polygonSet2d';
import { rasterizePolygonsToRegion } from './polygonRaster2d';

/**
 * Where a model meets the raft: the model's footprint over the height band the
 * raft occupies (plate to raft top).
 *
 * The band — not just the plate cross-section — is what the raft has to dodge. A
 * ball resting on the plate touches it at a point, but its lower cap widens fast:
 * over a 2 mm raft the model's XY extent grows by millimetres, and cutting only
 * the contact patch would leave the raft buried in the ball's flank.
 *
 * The result is the union of the band-restricted triangles projected to XY, so it
 * is exact for concave and multi-lobed contact (a model with two feet on the
 * plate leaves the raft standing between them).
 */

export const MODEL_PLATE_CLEARANCE_MM = 1;

/** Extra local Z scanned when building a geometry's bottom-triangle index. */
const BOTTOM_WINDOW_MM = 12;

const CACHE_MAX_ENTRIES = 24;

export type PlateFootprintSource = {
  geometry: { geometry: THREE.BufferGeometry; center: THREE.Vector3 };
  transform: ModelTransform;
  visible?: boolean;
};

type BottomIndex = {
  version: number;
  vertexCount: number;
  topMm: number;
  /** Triangle indices whose local Z starts within the indexed window. */
  indices: Uint32Array;
};

type LocalShadowCacheEntry = { polys: PolygonWithHoles[] };

const bottomIndexCache = new WeakMap<THREE.BufferGeometry, BottomIndex>();
const localShadowCache = new Map<string, LocalShadowCacheEntry>();
const worldShadowCache = new Map<string, PolygonWithHoles[]>();

const matrixScratch = new THREE.Matrix4();
const quaternionScratch = new THREE.Quaternion();
const vectorScratch = new THREE.Vector3();
const vertexScratch = new Float64Array(3);
const frameScratch = new Float64Array(9);

function trimCache<T>(cache: Map<string, T>) {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function readCache<T>(cache: Map<string, T>, key: string): T | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  // Refresh insertion order for simple LRU behaviour.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function quantized(value: number): number {
  return quantizeToScale(Number.isFinite(value) ? value : 0, 1e5);
}

function transformKey(transform: ModelTransform): string {
  return [
    quantized(transform.rotation.x), quantized(transform.rotation.y), quantized(transform.rotation.z),
    quantized(transform.scale.x), quantized(transform.scale.y), quantized(transform.scale.z),
    quantized(transform.position.z),
  ].join('|');
}

function isPlateFacingRotation(transform: ModelTransform): boolean {
  return Math.abs(transform.rotation.x) < 1e-6
    && Math.abs(transform.rotation.y) < 1e-6
    && Math.abs(transform.scale.z) > 1e-9;
}

/** XY of a point through an affine 4x4 (three's Vector2 has no applyMatrix4). */
function toWorldPoint(point: THREE.Vector2, matrix: THREE.Matrix4): THREE.Vector2 {
  const e = matrix.elements;
  return new THREE.Vector2(
    e[0] * point.x + e[4] * point.y + e[12],
    e[1] * point.x + e[5] * point.y + e[13],
  );
}

/**
 * World-Z range of the model's bounding box. A model lifted clear of the band —
 * the common case for anything with a raft under it — is rejected here, before
 * any triangle is touched.
 */
function worldZRange(
  geometry: THREE.BufferGeometry,
  center: THREE.Vector3,
  matrix: THREE.Matrix4,
): { min: number; max: number } | null {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;

  const e = matrix.elements;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = (corner & 1 ? box.max.x : box.min.x) - center.x;
    const y = (corner & 2 ? box.max.y : box.min.y) - center.y;
    const z = (corner & 4 ? box.max.z : box.min.z) - center.z;
    const worldZ = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (worldZ < min) min = worldZ;
    if (worldZ > max) max = worldZ;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Index the triangles near the model's bottom. Only those can reach the raft
 * band, so the per-query scan stays proportional to the footprint instead of the
 * whole mesh — which is what makes this affordable on every transform change.
 */
function getBottomIndex(geometry: THREE.BufferGeometry, requiredTopMm: number): BottomIndex | null {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return null;

  const version = position instanceof THREE.BufferAttribute ? position.version : 0;
  const cached = bottomIndexCache.get(geometry);
  if (
    cached
    && cached.version === version
    && cached.vertexCount === position.count
    && cached.topMm >= requiredTopMm
  ) {
    return cached;
  }

  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
  const positionArray = position instanceof THREE.BufferAttribute ? position.array : null;
  const itemSize = position.itemSize;
  const zAt = (vertexIndex: number) => (positionArray
    ? positionArray[vertexIndex * itemSize + 2]
    : position.getZ(vertexIndex));

  let minZ = Number.POSITIVE_INFINITY;
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    const z = zAt(vertexIndex);
    if (z < minZ) minZ = z;
  }
  if (!Number.isFinite(minZ)) return null;

  const topMm = Math.max(BOTTOM_WINDOW_MM, requiredTopMm - minZ);
  const limit = minZ + topMm;
  const collected: number[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = index ? index.getX(triangle * 3) : triangle * 3;
    const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    if (zAt(a) <= limit || zAt(b) <= limit || zAt(c) <= limit) collected.push(triangle);
  }

  const next: BottomIndex = { version, vertexCount: position.count, topMm, indices: Uint32Array.from(collected) };
  bottomIndexCache.set(geometry, next);
  return next;
}

/** Sutherland–Hodgman clip of a flat XYZ polygon to `zLo <= z <= zHi`, returned as flat XY. */
function clipSlabToFlatXY(verts: Float64Array, zLo: number, zHi: number): number[] {
  let input: number[] = Array.from(verts);
  const planes: Array<[number, boolean]> = [[zLo, true], [zHi, false]];

  for (const [limit, keepAbove] of planes) {
    const output: number[] = [];
    for (let i = 0; i < input.length; i += 3) {
      const j = (i + 3) % input.length;
      const zA = input[i + 2];
      const zB = input[j + 2];
      const aInside = keepAbove ? zA >= limit : zA <= limit;
      const bInside = keepAbove ? zB >= limit : zB <= limit;

      if (aInside) output.push(input[i], input[i + 1], input[i + 2]);
      if (aInside !== bInside) {
        const t = (limit - zA) / (zB - zA);
        output.push(
          input[i] + (input[j] - input[i]) * t,
          input[i + 1] + (input[j + 1] - input[i + 1]) * t,
          limit,
        );
      }
    }
    input = output;
    if (input.length < 9) return [];
  }

  const xy: number[] = [];
  for (let i = 0; i < input.length; i += 3) xy.push(input[i], input[i + 1]);
  return xy;
}

/**
 * Project every triangle the band can reach, clipping triangles that straddle the
 * band's floor or ceiling.
 *
 * `toBandFrame` maps a model-local centred vertex into the frame the band is
 * axis-aligned in — the local frame when the model is only rotated about Z, the
 * world frame otherwise — writing three floats at `outOffset`.
 */
function accumulateShadow(
  geometry: THREE.BufferGeometry,
  center: THREE.Vector3,
  toBandFrame: (x: number, y: number, z: number, out: Float64Array, outOffset: number) => void,
  zLo: number,
  zHi: number,
  triangles: Uint32Array | null,
): THREE.Vector2[][] {
  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return [];

  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
  const positionArray = position instanceof THREE.BufferAttribute ? position.array : null;
  const itemSize = position.itemSize;

  const readVertex = (vertexIndex: number, out: Float64Array) => {
    if (positionArray) {
      const base = vertexIndex * itemSize;
      out[0] = positionArray[base] - center.x;
      out[1] = positionArray[base + 1] - center.y;
      out[2] = positionArray[base + 2] - center.z;
    } else {
      out[0] = position.getX(vertexIndex) - center.x;
      out[1] = position.getY(vertexIndex) - center.y;
      out[2] = position.getZ(vertexIndex) - center.z;
    }
  };

  const polygons: THREE.Vector2[][] = [];
  const candidates = triangles ? triangles.length : triangleCount;

  for (let i = 0; i < candidates; i += 1) {
    const triangle = triangles ? triangles[i] : i;
    if (triangle >= triangleCount) continue;

    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
      readVertex(vertexIndex, vertexScratch);
      toBandFrame(vertexScratch[0], vertexScratch[1], vertexScratch[2], frameScratch, corner * 3);
      const z = frameScratch[corner * 3 + 2];
      if (minZ > z) minZ = z;
      if (maxZ < z) maxZ = z;
    }

    if (maxZ < zLo || minZ > zHi) continue;

    const xy = (minZ >= zLo && maxZ <= zHi)
      ? [frameScratch[0], frameScratch[1], frameScratch[3], frameScratch[4], frameScratch[6], frameScratch[7]]
      : clipSlabToFlatXY(frameScratch, zLo, zHi);
    if (xy.length < 6) continue;

    let area = 0;
    for (let p = 0; p < xy.length; p += 2) {
      const q = (p + 2) % xy.length;
      area += xy[p] * xy[q + 1] - xy[q] * xy[p + 1];
    }
    if (Math.abs(area) < 1e-9) continue;

    const ring: THREE.Vector2[] = [];
    for (let p = 0; p < xy.length; p += 2) ring.push(new THREE.Vector2(xy[p], xy[p + 1]));
    polygons.push(ring);
  }

  return polygons;
}

function ringsToPolygons(rings: THREE.Vector2[][]): PolygonWithHoles[] {
  if (rings.length === 0) return [];
  // Thousands of triangles sharing edges: Clipper's sweep takes seconds on that
  // input (a frozen frame), the grid takes milliseconds.
  return rasterizePolygonsToRegion(rings);
}

/** Footprint in the model's own frame — valid while the model only turns about Z. */
function localShadowPolygons(
  geometry: THREE.BufferGeometry,
  center: THREE.Vector3,
  zLo: number,
  zHi: number,
): PolygonWithHoles[] {
  const key = [
    geometry.uuid,
    quantized(center.x), quantized(center.y), quantized(center.z),
    quantized(zLo), quantized(zHi),
  ].join('|');

  const cached = readCache(localShadowCache, key);
  if (cached) return cached.polys;

  const bottomIndex = getBottomIndex(geometry, zHi);
  if (!bottomIndex) return [];

  const rings = accumulateShadow(
    geometry,
    center,
    (x, y, z, out, outOffset) => {
      out[outOffset] = x;
      out[outOffset + 1] = y;
      out[outOffset + 2] = z;
    },
    zLo,
    zHi,
    bottomIndex.indices,
  );

  const polys = ringsToPolygons(rings);
  localShadowCache.set(key, { polys });
  trimCache(localShadowCache);
  return polys;
}

/**
 * World-XY footprint of every visible model inside the `[0, bandTopMm]` band,
 * unioned across models: a raft belongs to one model's supports but still has to
 * clear any other model standing on the plate.
 */
export function collectModelPlateFootprint(
  sources: readonly PlateFootprintSource[],
  bandTopMm: number,
): PolygonWithHoles[] {
  if (!Number.isFinite(bandTopMm) || bandTopMm <= 0) return [];

  const sets: PolygonWithHoles[] = [];

  for (const source of sources) {
    if (source.visible === false) continue;
    const { geometry, center } = source.geometry;
    const { transform } = source;

    matrixScratch.compose(
      vectorScratch.set(transform.position.x, transform.position.y, transform.position.z),
      quaternionScratch.copy(quaternionFromGlobalEuler(transform.rotation)),
      transform.scale,
    );

    const zRange = worldZRange(geometry, center, matrixScratch);
    if (!zRange || zRange.min > bandTopMm || zRange.max < 0) continue;

    const toWorld = (x: number, y: number, z: number, out: Float64Array, outOffset: number) => {
      const e = matrixScratch.elements;
      out[outOffset] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[outOffset + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[outOffset + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    };

    let polys: PolygonWithHoles[];

    if (isPlateFacingRotation(transform)) {
      const scaleZ = transform.scale.z;
      const zA = (0 - transform.position.z) / scaleZ;
      const zB = (bandTopMm - transform.position.z) / scaleZ;
      const local = localShadowPolygons(geometry, center, Math.min(zA, zB), Math.max(zA, zB));
      polys = local.map((poly) => ({
        outer: poly.outer.map((p) => toWorldPoint(p, matrixScratch)),
        holes: poly.holes.map((hole) => hole.map((p) => toWorldPoint(p, matrixScratch))),
      }));
    } else {
      const key = `${geometry.uuid}|${transformKey(transform)}|${quantized(bandTopMm)}`;
      const cached = readCache(worldShadowCache, key);
      if (cached) {
        sets.push(...cached);
        continue;
      }
      polys = ringsToPolygons(accumulateShadow(geometry, center, toWorld, 0, bandTopMm, null));
      worldShadowCache.set(key, polys);
      trimCache(worldShadowCache);
    }

    sets.push(...polys);
  }

  if (sets.length === 0) return [];
  return sets.length === 1 ? sets : unionPolygonSets(sets);
}
