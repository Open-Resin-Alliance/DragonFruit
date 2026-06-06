import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { computePreciseModelWorldBounds } from '@/utils/modelBounds';
import { computeProjectedFootprintSize } from '@/utils/modelFootprint';
import type {
  AutoOrientGoals,
  OrientationCandidate,
  OrientationMetrics,
  ScoredOrientation,
} from '../types';

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/**
 * Overhang angle threshold. A face is "self-supporting" if its downward tilt
 * from horizontal is shallow enough that the printer can bridge it. Steeper
 * downward faces accumulate support need. 45° is the conventional resin default.
 *
 * We score support need as: area-weighted "overhang severity" of downward-facing
 * triangles, where severity ramps from 0 at the threshold to 1 when the face
 * points straight down. This is a fast geometric proxy for "how much support
 * material this orientation needs" — it avoids slicing entirely.
 */
const SUPPORT_THRESHOLD_DEG = 45;
const SUPPORT_THRESHOLD_NZ = -Math.sin((SUPPORT_THRESHOLD_DEG * Math.PI) / 180); // normal.z below this = needs support

/**
 * Precomputed per-triangle data in the model's *centered local* frame. Computed
 * once per geometry and reused for every candidate orientation, so scoring a
 * candidate is just a rotate-normal + dot-product pass with no allocation.
 */
interface TriangleFaceData {
  /** Flat [nx, ny, nz, ...] unit normals, one per triangle (local frame). */
  normals: Float32Array;
  /** Triangle areas in mm², one per triangle. */
  areas: Float32Array;
  count: number;
}

const faceDataCache = new WeakMap<THREE.BufferGeometry, { version: number; data: TriangleFaceData }>();

function attributeVersion(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  return attr instanceof THREE.BufferAttribute ? attr.version : (attr.data?.version ?? 0);
}

/**
 * Build (and cache) per-triangle normals + areas for a geometry. Normals are in
 * the geometry's own coordinate frame; rotation is applied per-candidate at
 * scoring time. This is the single expensive step and it runs once per model.
 */
function getFaceData(geom: GeometryWithBounds): TriangleFaceData {
  const geometry = geom.geometry;
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  const version = attributeVersion(posAttr);
  const cached = faceDataCache.get(geometry);
  if (cached && cached.version === version) return cached.data;

  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : posAttr.count / 3;
  const normals = new Float32Array(triCount * 3);
  const areas = new Float32Array(triCount);

  const ax = (i: number) => posAttr.getX(i);
  const ay = (i: number) => posAttr.getY(i);
  const az = (i: number) => posAttr.getZ(i);
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  for (let t = 0; t < triCount; t++) {
    const i0 = vi(t, 0);
    const i1 = vi(t, 1);
    const i2 = vi(t, 2);

    const ux = ax(i1) - ax(i0);
    const uy = ay(i1) - ay(i0);
    const uz = az(i1) - az(i0);
    const vx = ax(i2) - ax(i0);
    const vy = ay(i2) - ay(i0);
    const vz = az(i2) - az(i0);

    // Cross product = normal * 2*area
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const mag = Math.hypot(cx, cy, cz);
    const area = mag * 0.5;

    areas[t] = area;
    if (mag > 1e-12) {
      normals[t * 3] = cx / mag;
      normals[t * 3 + 1] = cy / mag;
      normals[t * 3 + 2] = cz / mag;
    }
  }

  const data: TriangleFaceData = { normals, areas, count: triCount };
  faceDataCache.set(geometry, { version, data });
  return data;
}

/**
 * Single rotated-normal pass that computes both the support proxy and the
 * protected-face exposure for one orientation. Both metrics depend only on each
 * triangle's world-space normal.Z, so we fold them into one loop.
 *
 * - support: area-weighted overhang severity of downward faces (lower = less
 *   support material). Computed only when `wantSupport`.
 * - protectedExposure: area-weighted downward exposure of faces flagged in
 *   `protectedMask` (lower = the protected face points more upward, away from
 *   the plate, so it stays support-free). Computed only when a mask is given.
 *
 * Pure arithmetic over cached face data — no slicing, no allocation beyond the
 * rotation matrix elements.
 */
function measureFaceMetrics(
  geom: GeometryWithBounds,
  rotation: THREE.Euler,
  wantSupport: boolean,
  protectedMask: Uint8Array | undefined,
): { support: number; protectedExposure: number } {
  const { normals, areas, count } = getFaceData(geom);
  const hasMask = !!protectedMask && protectedMask.length >= count;

  // Rotation matrix row 2 brings each local normal's Z into world space.
  const q = quaternionFromGlobalEuler(rotation);
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const r20 = e[2];
  const r21 = e[6];
  const r22 = e[10];

  let support = 0;
  let protectedExposure = 0;
  for (let t = 0; t < count; t++) {
    const nx = normals[t * 3];
    const ny = normals[t * 3 + 1];
    const nz = normals[t * 3 + 2];
    const worldNz = r20 * nx + r21 * ny + r22 * nz;

    if (wantSupport && worldNz < SUPPORT_THRESHOLD_NZ) {
      // Severity ramps 0..1 from threshold to straight-down (-1).
      const severity = (SUPPORT_THRESHOLD_NZ - worldNz) / (SUPPORT_THRESHOLD_NZ + 1);
      support += areas[t] * severity;
    }

    if (hasMask && protectedMask![t] && worldNz < 0) {
      // Any downward tilt of a protected face is exposure; straight-down (-1)
      // is worst. Ramps 0 (horizontal/up) .. 1 (straight down).
      protectedExposure += areas[t] * -worldNz;
    }
  }
  return { support, protectedExposure };
}

function measureHeightMm(geom: GeometryWithBounds, rotation: THREE.Euler): number {
  const bounds = computePreciseModelWorldBounds(geom, {
    position: new THREE.Vector3(0, 0, 0),
    rotation,
    scale: UNIT_SCALE,
  });
  return bounds.max.z - bounds.min.z;
}

function measureFootprintMm2(geom: GeometryWithBounds, rotation: THREE.Euler): number {
  const { width, depth } = computeProjectedFootprintSize(geom, rotation, UNIT_SCALE);
  return width * depth;
}

/**
 * Compute raw metrics for one candidate orientation. All metrics are now cheap
 * geometric passes (no slicing), so this is synchronous and fast enough to score
 * hundreds of candidates per frame.
 *
 * `protectedMask` is an optional per-triangle flag buffer (1 = protected). The
 * protect goal only contributes when both its weight is > 0 and a mask exists.
 */
export function measureOrientation(
  geom: GeometryWithBounds,
  rotation: THREE.Euler,
  goals: AutoOrientGoals,
  protectedMask?: Uint8Array,
): OrientationMetrics {
  const metrics: OrientationMetrics = {
    heightMm: goals.minimizeHeight > 0 ? measureHeightMm(geom, rotation) : 0,
    footprintMm2: goals.minimizeFootprint > 0 ? measureFootprintMm2(geom, rotation) : 0,
  };

  const wantSupport = goals.minimizeIslands > 0;
  const wantProtect = goals.protectFaces > 0 && !!protectedMask;
  if (wantSupport || wantProtect) {
    const { support, protectedExposure } = measureFaceMetrics(
      geom,
      rotation,
      wantSupport,
      wantProtect ? protectedMask : undefined,
    );
    if (wantSupport) metrics.overhangAreaMm2 = support;
    if (wantProtect) metrics.protectedExposureMm2 = protectedExposure;
  }

  return metrics;
}

/** Min-max normalize an array of values to [0, 1]. Constant inputs map to all 0. */
function normalize(values: number[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!(range > 0)) return values.map(() => 0);
  return values.map((v) => (v - min) / range);
}

/**
 * Combine candidate metrics into weighted scores (lower is better) and return
 * the candidates sorted best-first.
 *
 * Each enabled goal's raw metric is normalized across all candidates, then
 * multiplied by its weight and summed. Normalizing per-run keeps goals
 * comparable regardless of their physical units.
 */
export function scoreCandidates(
  candidates: OrientationCandidate[],
  metrics: OrientationMetrics[],
  goals: AutoOrientGoals,
): ScoredOrientation[] {
  const n = candidates.length;
  const totals = new Array<number>(n).fill(0);

  const addGoal = (weight: number, raw: number[]) => {
    if (weight <= 0) return;
    const norm = normalize(raw);
    for (let i = 0; i < n; i++) totals[i] += norm[i] * weight;
  };

  addGoal(goals.minimizeIslands, metrics.map((m) => m.overhangAreaMm2 ?? 0));
  addGoal(goals.minimizeHeight, metrics.map((m) => m.heightMm));
  addGoal(goals.minimizeFootprint, metrics.map((m) => m.footprintMm2));
  addGoal(goals.protectFaces, metrics.map((m) => m.protectedExposureMm2 ?? 0));

  const scored: ScoredOrientation[] = candidates.map((c, i) => ({
    rotation: c.rotation,
    metrics: metrics[i],
    score: totals[i],
  }));

  // Stable sort: lowest score first; ties keep candidate order (current rotation
  // is index 0, so it wins ties — auto-orient never needlessly moves a model).
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.score - b.s.score) || (a.i - b.i))
    .map(({ s }) => s);
}
