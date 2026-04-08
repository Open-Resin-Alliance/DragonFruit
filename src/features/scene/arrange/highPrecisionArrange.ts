import * as THREE from 'three';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';
import type { ArrangeAnchorMode } from '@/components/controls/ArrangePanel';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/**
 * High-Precision Arrange (2.5D SAT Nesting)
 * -----------------------------------------
 *
 * What this module does:
 * - Packs visible model footprints on the build plate using convex-hull SAT checks.
 * - Prioritizes dense on-plate fill first (top-left objective), then applies anchor intent.
 * - Falls back to an aggressive fit-rate rescue pass when standard pass leaves spills.
 *
 * Research lineage / inspiration (heuristic families used here):
 * - Irregular nesting + No-Fit-Polygon robustness:
 *   Rocha, "Robust NFP generation for Nesting problems" (arXiv:1903.11139, 2019).
 * - Constructive insertion heuristics for irregular 3D packing:
 *   Zuo et al., "A Constructive Heuristic Algorithm for 3D Bin Packing of Irregular Shaped Items"
 *   (arXiv:2206.15116, 2022).
 * - Extreme-point style candidate reduction + randomized/greedy insertion ideas:
 *   Heßler et al., "A Fast Optimization Approach For A Complex Real-Life 3D Multiple Bin Size
 *   Bin Packing Problem" (arXiv:2410.01445, 2024).
 * - Multi-start / multi-objective search intuition for practical utilization gains:
 *   Poolavaram et al., "GENPACK: KPI-Guided Multi-Objective Genetic Algorithm for Industrial
 *   3D Bin Packing" (arXiv:2601.11325, 2026).
 *
 * Note:
 * This implementation is a pragmatic hybrid for interactive slicing UX (fast-enough, robust-enough),
 * not a direct reproduction of any single paper.
 */

export type ArrangeTransform = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
};

export type ArrangeModel = {
  id: string;
  visible: boolean;
  transform: ArrangeTransform;
  geometry: {
    center: THREE.Vector3;
    geometry: THREE.BufferGeometry;
    supportLocalPoints?: THREE.Vector3[];
    supportHullKey?: string;
  };
};

export type HullCacheEntry = {
  points: THREE.Vector2[];
  halfW: number;
  halfD: number;
  localMinX: number;
  localMaxX: number;
  localMinY: number;
  localMaxY: number;
};

export type HighPrecisionArrangeInput = {
  visibleModels: ArrangeModel[];
  sceneModels: ArrangeModel[];
  widthMm: number;
  depthMm: number;
  originMode: 'front_left' | 'center';
  arrangeSpacingMm: number;
  arrangeAllowRotateOnZ: boolean;
  arrangeAnchorMode: ArrangeAnchorMode;
  getArrangeTransform: (model: ArrangeModel) => ArrangeTransform;
  hullCache: Map<string, HullCacheEntry>;
  safetyMarginMm?: { front: number; back: number; left: number; right: number };
};

export type HighPrecisionArrangeUpdate = {
  id: string;
  transform: ArrangeTransform;
};

export function computeHighPrecisionArrangeUpdates(input: HighPrecisionArrangeInput): HighPrecisionArrangeUpdate[] {
  const {
    visibleModels,
    sceneModels,
    widthMm,
    depthMm,
    originMode,
    arrangeSpacingMm,
    arrangeAllowRotateOnZ,
    arrangeAnchorMode,
    getArrangeTransform,
    hullCache,
  } = input;

  if (visibleModels.length <= 1) return [];

  // Numerical tolerance guard used in spacing enforcement to avoid near-contact jitter.
  const SAT_EPS_MM = 0.05;
  const spacing = Math.max(0, arrangeSpacingMm);
  const minSpacing = spacing + SAT_EPS_MM;
  const PERF_COMPLEX_SCENE = visibleModels.length >= 30;

  const rawMinX = originMode === 'front_left' ? 0 : -widthMm * 0.5;
  const rawMaxX = rawMinX + widthMm;
  const rawMinY = originMode === 'front_left' ? 0 : -depthMm * 0.5;
  const rawMaxY = rawMinY + depthMm;
  const minX = rawMinX + Math.max(0, input.safetyMarginMm?.left ?? 0);
  const maxX = rawMaxX - Math.max(0, input.safetyMarginMm?.right ?? 0);
  const minY = rawMinY + Math.max(0, input.safetyMarginMm?.front ?? 0);
  const maxY = rawMaxY - Math.max(0, input.safetyMarginMm?.back ?? 0);

  const modelTransformById = new Map(
    sceneModels.map((model) => [model.id, getArrangeTransform(model)] as const),
  );

  const quant = (n: number) => Math.round(n * 1e4) / 1e4;

  type HullData = HullCacheEntry;

  // Phase 1: Build/cache model footprints (2D convex hulls at a target Z rotation).
  const getHullAtRotation = (model: ArrangeModel, rotationZ: number): HullData => {
    const t = modelTransformById.get(model.id) ?? model.transform;
    const positionAttr = model.geometry.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!positionAttr || positionAttr.count < 3) {
      return {
        points: [
          new THREE.Vector2(-1, -1),
          new THREE.Vector2(1, -1),
          new THREE.Vector2(1, 1),
          new THREE.Vector2(-1, 1),
        ],
        halfW: 1,
        halfD: 1,
        localMinX: -1,
        localMaxX: 1,
        localMinY: -1,
        localMaxY: 1,
      };
    }

    const key = [
      model.geometry.geometry.uuid,
      model.geometry.supportHullKey ?? 'no_support_hull',
      quant(t.rotation.x),
      quant(t.rotation.y),
      quant(rotationZ),
      quant(t.scale.x),
      quant(t.scale.y),
      quant(t.scale.z),
    ].join('|');

    const cached = hullCache.get(key);
    if (cached) return cached;

    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      quaternionFromGlobalEuler({ x: t.rotation.x, y: t.rotation.y, z: rotationZ }),
      t.scale,
    );

    const center = model.geometry.center;
    const targetSamplesBase = 8000;
    const stride = Math.max(1, Math.floor(positionAttr.count / targetSamplesBase));
    const points2d: THREE.Vector2[] = [];
    const tmp = new THREE.Vector3();
    const nE = 8;
    const eDx = [1, -1, 0, 0, 0.7071068, 0.7071068, -0.7071068, -0.7071068];
    const eDy = [0, 0, 1, -1, 0.7071068, -0.7071068, 0.7071068, -0.7071068];
    const eDot = new Float64Array(nE).fill(-Infinity);
    const eXArr = new Float32Array(nE);
    const eYArr = new Float32Array(nE);
    for (let i = 0; i < positionAttr.count; i++) {
      tmp.set(
        positionAttr.getX(i) - center.x,
        positionAttr.getY(i) - center.y,
        positionAttr.getZ(i) - center.z,
      ).applyMatrix4(matrix);
      const tx = tmp.x;
      const ty = tmp.y;
      if (i % stride === 0) points2d.push(new THREE.Vector2(tx, ty));
      for (let d = 0; d < nE; d++) {
        const dot = tx * eDx[d] + ty * eDy[d];
        if (dot > eDot[d]) { eDot[d] = dot; eXArr[d] = tx; eYArr[d] = ty; }
      }
    }
    for (let d = 0; d < nE; d++) {
      if (Number.isFinite(eXArr[d]) && Number.isFinite(eYArr[d])) {
        points2d.push(new THREE.Vector2(eXArr[d], eYArr[d]));
      }
    }

    const supportLocalPoints = model.geometry.supportLocalPoints;
    if (supportLocalPoints && supportLocalPoints.length > 0) {
      for (const localPoint of supportLocalPoints) {
        tmp.copy(localPoint).applyMatrix4(matrix);
        points2d.push(new THREE.Vector2(tmp.x, tmp.y));
      }
    }

    const hull = convexHull2d(points2d);
    const points = hull.length >= 3
      ? hull
      : [
        new THREE.Vector2(-1, -1),
        new THREE.Vector2(1, -1),
        new THREE.Vector2(1, 1),
        new THREE.Vector2(-1, 1),
      ];

    let localMinX = Infinity;
    let localMaxX = -Infinity;
    let localMinY = Infinity;
    let localMaxY = -Infinity;
    for (const p of points) {
      localMinX = Math.min(localMinX, p.x);
      localMaxX = Math.max(localMaxX, p.x);
      localMinY = Math.min(localMinY, p.y);
      localMaxY = Math.max(localMaxY, p.y);
    }

    if (!Number.isFinite(localMinX) || !Number.isFinite(localMaxX) || !Number.isFinite(localMinY) || !Number.isFinite(localMaxY)) {
      localMinX = -1;
      localMaxX = 1;
      localMinY = -1;
      localMaxY = 1;
    }

    const next: HullData = {
      points,
      halfW: Math.max(1, (localMaxX - localMinX) * 0.5),
      halfD: Math.max(1, (localMaxY - localMinY) * 0.5),
      localMinX,
      localMaxX,
      localMinY,
      localMaxY,
    };

    hullCache.set(key, next);
    return next;
  };

  const axesFromPolygon = (poly: THREE.Vector2[]) => {
    const axes: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const edge = new THREE.Vector2(b.x - a.x, b.y - a.y);
      if (edge.lengthSq() <= 1e-10) continue;
      axes.push(new THREE.Vector2(-edge.y, edge.x).normalize());
    }
    return axes;
  };

  const projectPolygon = (poly: THREE.Vector2[], center: THREE.Vector2, axis: THREE.Vector2) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of poly) {
      const dot = (p.x + center.x) * axis.x + (p.y + center.y) * axis.y;
      min = Math.min(min, dot);
      max = Math.max(max, dot);
    }
    return { min, max };
  };

  // SAT overlap test expanded with minimum clearance (spacing) margin.
  const polygonsOverlapWithSpacing = (
    polyA: THREE.Vector2[],
    centerA: THREE.Vector2,
    polyB: THREE.Vector2[],
    centerB: THREE.Vector2,
    spacingMm: number,
  ) => {
    const axes = [...axesFromPolygon(polyA), ...axesFromPolygon(polyB)];
    for (const axis of axes) {
      const pa = projectPolygon(polyA, centerA, axis);
      const pb = projectPolygon(polyB, centerB, axis);
      if ((pa.max + spacingMm) <= pb.min || (pb.max + spacingMm) <= pa.min) {
        return false;
      }
    }
    return true;
  };

  type CollisionProxy = {
    center: THREE.Vector2;
    hull: THREE.Vector2[];
    halfW: number;
    halfD: number;
    localMinX: number;
    localMaxX: number;
    localMinY: number;
    localMaxY: number;
  };

  type Placed = CollisionProxy & {
    model: ArrangeModel;
    rotationZ: number;
  };

  const worldBoundsAt = (proxy: CollisionProxy, center: THREE.Vector2) => ({
    minX: center.x + proxy.localMinX,
    maxX: center.x + proxy.localMaxX,
    minY: center.y + proxy.localMinY,
    maxY: center.y + proxy.localMaxY,
  });

  const intersectsBroadphase = (
    a: CollisionProxy,
    centerA: THREE.Vector2,
    b: CollisionProxy,
    centerB: THREE.Vector2,
    pad: number,
  ) => {
    const ba = worldBoundsAt(a, centerA);
    const bb = worldBoundsAt(b, centerB);
    if (ba.maxX + pad <= bb.minX) return false;
    if (bb.maxX + pad <= ba.minX) return false;
    if (ba.maxY + pad <= bb.minY) return false;
    if (bb.maxY + pad <= ba.minY) return false;
    return true;
  };

  const withinPlateAt = (proxy: CollisionProxy, center: THREE.Vector2) => {
    const wb = worldBoundsAt(proxy, center);
    return wb.minX >= minX && wb.maxX <= maxX && wb.minY >= minY && wb.maxY <= maxY;
  };

  type CollisionLookup = {
    query: (candidate: CollisionProxy, center: THREE.Vector2, pad: number) => CollisionProxy[];
    insert: (proxy: CollisionProxy) => void;
  };

  const estimateCollisionCellSize = (poolSize: number) => {
    const plateArea = Math.max(1, widthMm * depthMm);
    const nominal = Math.sqrt(plateArea / Math.max(1, poolSize));
    return Math.max(2, minSpacing * 2, nominal);
  };

  const makeCollisionLookup = (initial: CollisionProxy[], preferredCellSize: number): CollisionLookup => {
    const cellSize = Math.max(1, preferredCellSize);
    const invCellSize = 1 / cellSize;
    const buckets = new Map<string, CollisionProxy[]>();
    const idByProxy = new WeakMap<CollisionProxy, number>();
    let idSeq = 1;

    const getId = (proxy: CollisionProxy) => {
      let id = idByProxy.get(proxy);
      if (!id) {
        id = idSeq++;
        idByProxy.set(proxy, id);
      }
      return id;
    };

    const key = (ix: number, iy: number) => `${ix}:${iy}`;

    const insert = (proxy: CollisionProxy) => {
      const wb = worldBoundsAt(proxy, proxy.center);
      const ix0 = Math.floor(wb.minX * invCellSize);
      const ix1 = Math.floor(wb.maxX * invCellSize);
      const iy0 = Math.floor(wb.minY * invCellSize);
      const iy1 = Math.floor(wb.maxY * invCellSize);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const k = key(ix, iy);
          const bucket = buckets.get(k);
          if (bucket) bucket.push(proxy);
          else buckets.set(k, [proxy]);
        }
      }
      getId(proxy);
    };

    for (const proxy of initial) insert(proxy);

    // Correctness invariant:
    // - Buckets index full world-space AABBs for all blockers/placed items.
    // - Query expands the candidate AABB by `pad` and returns a superset of potential overlaps.
    // - Final feasibility still uses exact broadphase + SAT, so placement density/quality is unchanged.
    const query = (candidate: CollisionProxy, center: THREE.Vector2, pad: number) => {
      const wb = worldBoundsAt(candidate, center);
      const qMinX = wb.minX - pad;
      const qMaxX = wb.maxX + pad;
      const qMinY = wb.minY - pad;
      const qMaxY = wb.maxY + pad;
      const ix0 = Math.floor(qMinX * invCellSize) - 1;
      const ix1 = Math.floor(qMaxX * invCellSize) + 1;
      const iy0 = Math.floor(qMinY * invCellSize) - 1;
      const iy1 = Math.floor(qMaxY * invCellSize) + 1;
      const out: CollisionProxy[] = [];
      const seenIds = new Set<number>();
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const bucket = buckets.get(key(ix, iy));
          if (!bucket) continue;
          for (const proxy of bucket) {
            const id = getId(proxy);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            out.push(proxy);
          }
        }
      }
      return out;
    };

    return { query, insert };
  };

  // Placement feasibility = inside plate + broadphase cull + narrowphase SAT spacing check.
  const canPlaceAt = (
    candidate: CollisionProxy,
    center: THREE.Vector2,
    others: CollisionProxy[],
    lookup?: CollisionLookup,
  ) => {
    if (!withinPlateAt(candidate, center)) return false;
    const candidates = lookup ? lookup.query(candidate, center, minSpacing) : others;
    for (const other of candidates) {
      if (!intersectsBroadphase(candidate, center, other, other.center, minSpacing)) continue;
      if (polygonsOverlapWithSpacing(candidate.hull, center, other.hull, other.center, minSpacing)) return false;
    }
    return true;
  };

  type Bounds2D = { minX: number; maxX: number; minY: number; maxY: number };
  const boundsFromProxies = (proxies: CollisionProxy[]): Bounds2D | null => {
    if (proxies.length === 0) return null;
    let bMinX = Infinity;
    let bMaxX = -Infinity;
    let bMinY = Infinity;
    let bMaxY = -Infinity;
    for (const p of proxies) {
      const wb = worldBoundsAt(p, p.center);
      bMinX = Math.min(bMinX, wb.minX);
      bMaxX = Math.max(bMaxX, wb.maxX);
      bMinY = Math.min(bMinY, wb.minY);
      bMaxY = Math.max(bMaxY, wb.maxY);
    }
    return { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY };
  };

  type PlacementScore = { area: number; depth: number; width: number; anchorDistSq: number };
  const scoreCandidatePlacement = (
    candidate: CollisionProxy,
    center: THREE.Vector2,
    existingBounds: Bounds2D | null,
    anchorDistSq: number,
  ): PlacementScore => {
    const wb = worldBoundsAt(candidate, center);
    const mergedMinX = existingBounds ? Math.min(existingBounds.minX, wb.minX) : wb.minX;
    const mergedMaxX = existingBounds ? Math.max(existingBounds.maxX, wb.maxX) : wb.maxX;
    const mergedMinY = existingBounds ? Math.min(existingBounds.minY, wb.minY) : wb.minY;
    const mergedMaxY = existingBounds ? Math.max(existingBounds.maxY, wb.maxY) : wb.maxY;
    const width = mergedMaxX - mergedMinX;
    const depth = mergedMaxY - mergedMinY;
    return { area: width * depth, depth, width, anchorDistSq };
  };

  const isScoreBetter = (a: PlacementScore, b: PlacementScore) => {
    const EPS = 1e-6;
    if (a.area < b.area - EPS) return true;
    if (a.area > b.area + EPS) return false;
    if (a.depth < b.depth - EPS) return true;
    if (a.depth > b.depth + EPS) return false;
    if (a.width < b.width - EPS) return true;
    if (a.width > b.width + EPS) return false;
    return a.anchorDistSq < b.anchorDistSq;
  };

  // Anchor requested by UI; applied as a post-pack translation after dense fill.
  const finalAnchor = (() => {
    if (arrangeAnchorMode === 'front_left') return new THREE.Vector2(minX, minY);
    if (arrangeAnchorMode === 'front_right') return new THREE.Vector2(maxX, minY);
    if (arrangeAnchorMode === 'back_left') return new THREE.Vector2(minX, maxY);
    if (arrangeAnchorMode === 'back_right') return new THREE.Vector2(maxX, maxY);
    return new THREE.Vector2((minX + maxX) * 0.5, (minY + maxY) * 0.5);
  })();
  // Packing objective is intentionally fixed to top-left for better fill consistency.
  const packingAnchor = new THREE.Vector2(minX, minY);

  const targetIdSet = new Set(visibleModels.map((m) => m.id));
  const blockers: CollisionProxy[] = sceneModels
    .filter((m) => m.visible && !targetIdSet.has(m.id))
    .map((m) => {
      const t = modelTransformById.get(m.id) ?? m.transform;
      const h = getHullAtRotation(m, t.rotation.z);
      return {
        center: new THREE.Vector2(t.position.x, t.position.y),
        hull: h.points,
        halfW: h.halfW,
        halfD: h.halfD,
        localMinX: h.localMinX,
        localMaxX: h.localMaxX,
        localMinY: h.localMinY,
        localMaxY: h.localMaxY,
      };
    });

  const makeRotationOptions = (currentZ: number) => {
    if (!arrangeAllowRotateOnZ) return [currentZ];
    const options: number[] = [];
    const seen = new Set<number>();
    const rotationStepDeg = PERF_COMPLEX_SCENE ? 30 : 15;
    const push = (angle: number) => {
      const twoPi = Math.PI * 2;
      let a = angle % twoPi;
      if (a < 0) a += twoPi;
      const k = Number(a.toFixed(5));
      if (seen.has(k)) return;
      seen.add(k);
      options.push(a);
    };

    push(currentZ);
    for (let deg = 0; deg < 360; deg += rotationStepDeg) push(THREE.MathUtils.degToRad(deg));
    return options;
  };

  // Contact-candidate generator: approximate edge-to-edge "nestle" opportunities.
  const buildContactCandidates = (
    h: HullData,
    pool: CollisionProxy[],
    minCX: number,
    maxCX: number,
    minCY: number,
    maxCY: number,
    out: Array<{ x: number; y: number }>,
    maxOut: number,
  ) => {
    if (maxOut <= 0) return;
    for (const other of pool) {
      if (out.length >= maxOut) break;
      const otherPoly = other.hull;
      for (let ei = 0; ei < otherPoly.length; ei++) {
        if (out.length >= maxOut) break;
        const vA = otherPoly[ei];
        const vB = otherPoly[(ei + 1) % otherPoly.length];
        const ex = vB.x - vA.x;
        const ey = vB.y - vA.y;
        const len = Math.sqrt(ex * ex + ey * ey);
        if (len < 1e-8) continue;
        const nx = -ey / len;
        const ny = ex / len;

        let minDot = Infinity;
        for (const p of h.points) {
          const d = p.x * nx + p.y * ny;
          if (d < minDot) minDot = d;
        }

        for (const vO of otherPoly) {
          if (out.length >= maxOut) break;
          const targetDot = (vO.x + other.center.x) * nx + (vO.y + other.center.y) * ny + minSpacing - minDot;
          if (Math.abs(ny) > 0.1) {
            for (const cx of [other.center.x, minCX, maxCX, packingAnchor.x]) {
              const cy = (targetDot - cx * nx) / ny;
              out.push({ x: Math.min(maxCX, Math.max(minCX, cx)), y: Math.min(maxCY, Math.max(minCY, cy)) });
              if (out.length >= maxOut) break;
            }
          }
          if (Math.abs(nx) > 0.1) {
            for (const cy of [other.center.y, minCY, maxCY, packingAnchor.y]) {
              const cx = (targetDot - cy * ny) / nx;
              out.push({ x: Math.min(maxCX, Math.max(minCX, cx)), y: Math.min(maxCY, Math.max(minCY, cy)) });
              if (out.length >= maxOut) break;
            }
          }
        }
      }
    }
  };

  const allShareSameGeometry = visibleModels.length > 0
    && visibleModels.every((m) => m.geometry.geometry.uuid === visibleModels[0].geometry.geometry.uuid);
  const SAME_GEOMETRY_FAST_PATH = allShareSameGeometry && visibleModels.length >= 18;
  const USE_CONTACT_CANDIDATES = !(SAME_GEOMETRY_FAST_PATH && PERF_COMPLEX_SCENE);
  const ENABLE_MULTI_ORDERING_RETRY = visibleModels.length <= 32;

  // Fast simulation pass used to pick a strong shared rotation in homogeneous batches.
  const simPackAtAngle = (angle: number): number => {
    const simPlaced: CollisionProxy[] = [...blockers];
    const simLookup = makeCollisionLookup(simPlaced, estimateCollisionCellSize(simPlaced.length));
    let count = 0;
    for (const model of visibleModels) {
      const h = getHullAtRotation(model, angle);
      const proxy: CollisionProxy = {
        center: new THREE.Vector2(),
        hull: h.points, halfW: h.halfW, halfD: h.halfD,
        localMinX: h.localMinX, localMaxX: h.localMaxX,
        localMinY: h.localMinY, localMaxY: h.localMaxY,
      };
      const minCX = minX - h.localMinX;
      const maxCX = maxX - h.localMaxX;
      const minCY = minY - h.localMinY;
      const maxCY = maxY - h.localMaxY;
      if (minCX > maxCX || minCY > maxCY) continue;

      const pitchX = Math.max(1, (h.localMaxX - h.localMinX) + minSpacing);
      const pitchY = Math.max(1, (h.localMaxY - h.localMinY) + minSpacing);
      const colsX = Math.ceil((maxCX - minCX) / pitchX) + 1;
      const rowsY = Math.ceil((maxCY - minCY) / pitchY) + 1;
      const cands: Array<{ cx: number; cy: number; d: number }> = [];
      const addSim = (x: number, y: number) => {
        const cx = Math.min(maxCX, Math.max(minCX, x));
        const cy = Math.min(maxCY, Math.max(minCY, y));
        const dx = cx - packingAnchor.x; const dy = cy - packingAnchor.y;
        cands.push({ cx, cy, d: dx * dx + dy * dy });
      };
      for (let ix = 0; ix <= colsX; ix++) {
        for (let iy = 0; iy <= rowsY; iy++) addSim(minCX + ix * pitchX, minCY + iy * pitchY);
      }
      for (const other of simPlaced) {
        const ob = worldBoundsAt(other, other.center);
        addSim(ob.maxX + minSpacing - h.localMinX, other.center.y);
        addSim(other.center.x, ob.maxY + minSpacing - h.localMinY);
      }
      cands.sort((a, b) => a.d - b.d);
      const scratchCenter = new THREE.Vector2();
      for (const c of cands) {
        scratchCenter.set(c.cx, c.cy);
        if (canPlaceAt(proxy, scratchCenter, simPlaced, simLookup)) {
          count++;
          const ctr = new THREE.Vector2(c.cx, c.cy);
          simPlaced.push({ ...proxy, center: ctr });
          simLookup.insert(simPlaced[simPlaced.length - 1]);
          break;
        }
      }
    }
    return count;
  };

  const sharedBestRotation = (() => {
    if (!allShareSameGeometry || visibleModels.length === 0) return null as number | null;
    const probe = visibleModels[0];
    const probeT = modelTransformById.get(probe.id) ?? probe.transform;
    const rotOpts = makeRotationOptions(probeT.rotation.z);
    if (rotOpts.length === 1) return rotOpts[0];
    let bestAngle = rotOpts[0];
    let bestCount = -1;
    for (const angle of rotOpts) {
      const n = simPackAtAngle(angle);
      if (n > bestCount) { bestCount = n; bestAngle = angle; }
    }
    return bestAngle;
  })();

  const areaAtBestAngle = (model: ArrangeModel) => {
    const angle = sharedBestRotation ?? (modelTransformById.get(model.id) ?? model.transform).rotation.z;
    const h = getHullAtRotation(model, angle);
    return Math.max(1, (h.localMaxX - h.localMinX) * (h.localMaxY - h.localMinY));
  };
  const modelOrder = [...visibleModels].sort((a, b) => areaAtBestAngle(b) - areaAtBestAngle(a));

  // Core constructive placer (standard or aggressive mode).
  // - standard: bounded candidate budget for interactivity
  // - aggressive: wider search budget to rescue fit rate
  const attemptPlacement = (order: ArrangeModel[], aggressive: boolean) => {
    const MAX_CANDIDATE_NEIGHBORS = aggressive ? 999_999 : (PERF_COMPLEX_SCENE ? 20 : 36);
    const MAX_VERTEX_PAIR_CANDIDATES = aggressive ? 1200 : (PERF_COMPLEX_SCENE ? 180 : 420);
    const MAX_CONTACT_CANDIDATES = aggressive ? 2400 : (PERF_COMPLEX_SCENE ? 360 : 900);
    const MAX_LATTICE_CANDIDATES = aggressive ? 4000 : (PERF_COMPLEX_SCENE ? 320 : 900);
    const MAX_EVALUATED_CANDIDATES = aggressive ? 7000 : (PERF_COMPLEX_SCENE ? 420 : 1200);
    const MAX_CANDIDATE_BUFFER = aggressive ? 10000 : (PERF_COMPLEX_SCENE ? 560 : 1500);

    const placed: Placed[] = [];
    let spills: Placed[] = [];

    for (const model of order) {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const placedBounds = boundsFromProxies(placed);
      const neighborPool: CollisionProxy[] = [...placed, ...blockers];
      const candidateNeighbors = neighborPool.length > MAX_CANDIDATE_NEIGHBORS
        ? neighborPool
          .slice()
          .sort((a, b) => a.center.distanceToSquared(packingAnchor) - b.center.distanceToSquared(packingAnchor))
          .slice(0, MAX_CANDIDATE_NEIGHBORS)
        : neighborPool;
      const collisionPool = [...placed, ...blockers];
      const collisionLookup = makeCollisionLookup(collisionPool, estimateCollisionCellSize(collisionPool.length));

      const angleOptions = (() => {
        const base = makeRotationOptions(t.rotation.z);
        if (SAME_GEOMETRY_FAST_PATH && sharedBestRotation != null && !aggressive) {
          const alternatives = base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5).slice(0, 2);
          return [sharedBestRotation, ...alternatives];
        }
        if (sharedBestRotation == null) return base;
        return [sharedBestRotation, ...base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5)];
      })();

      let best: { proxy: CollisionProxy; center: THREE.Vector2; rotationZ: number; score: PlacementScore } | null = null;

      for (const rotationZ of angleOptions) {
        const h = getHullAtRotation(model, rotationZ);
        const candidateProxy: CollisionProxy = {
          center: new THREE.Vector2(),
          hull: h.points, halfW: h.halfW, halfD: h.halfD,
          localMinX: h.localMinX, localMaxX: h.localMaxX,
          localMinY: h.localMinY, localMaxY: h.localMaxY,
        };

        const minCenterX = minX - h.localMinX;
        const maxCenterX = maxX - h.localMaxX;
        const minCenterY = minY - h.localMinY;
        const maxCenterY = maxY - h.localMaxY;
        if (minCenterX > maxCenterX || minCenterY > maxCenterY) continue;

        const seen = new Set<string>();
        const cands: Array<{ x: number; y: number; sortKey: number }> = [];
        const addCandidate = (x: number, y: number) => {
          if (cands.length >= MAX_CANDIDATE_BUFFER) return;
          const cx = Math.min(maxCenterX, Math.max(minCenterX, x));
          const cy = Math.min(maxCenterY, Math.max(minCenterY, y));
          const k = `${Math.round(cx * 100)}:${Math.round(cy * 100)}`;
          if (seen.has(k)) return;
          seen.add(k);
          const dx = cx - packingAnchor.x;
          const dy = cy - packingAnchor.y;
          cands.push({ x: cx, y: cy, sortKey: dx * dx + dy * dy });
        };

        addCandidate(packingAnchor.x, packingAnchor.y);
        addCandidate(minCenterX, minCenterY);
        addCandidate(maxCenterX, minCenterY);
        addCandidate(minCenterX, maxCenterY);
        addCandidate(maxCenterX, maxCenterY);

        let vertexPairCount = 0;
        for (const other of candidateNeighbors) {
          if (cands.length >= MAX_CANDIDATE_BUFFER) break;
          const ob = worldBoundsAt(other, other.center);
          addCandidate(ob.maxX + minSpacing - h.localMinX, other.center.y);
          addCandidate(ob.minX - minSpacing - h.localMaxX, other.center.y);
          addCandidate(other.center.x, ob.maxY + minSpacing - h.localMinY);
          addCandidate(other.center.x, ob.minY - minSpacing - h.localMaxY);
          addCandidate(ob.maxX + minSpacing - h.localMinX, packingAnchor.y);
          addCandidate(packingAnchor.x, ob.maxY + minSpacing - h.localMinY);
          for (const vO of other.hull) {
            if (vertexPairCount >= MAX_VERTEX_PAIR_CANDIDATES) break;
            for (const vC of h.points) {
              if (vertexPairCount >= MAX_VERTEX_PAIR_CANDIDATES) break;
              const wx = other.center.x + vO.x;
              const wy = other.center.y + vO.y;
              addCandidate(wx - vC.x + minSpacing, wy - vC.y);
              addCandidate(wx - vC.x - minSpacing, wy - vC.y);
              addCandidate(wx - vC.x, wy - vC.y + minSpacing);
              addCandidate(wx - vC.x, wy - vC.y - minSpacing);
              vertexPairCount++;
            }
          }
        }

        if (USE_CONTACT_CANDIDATES) {
          const contactRaw: Array<{ x: number; y: number }> = [];
          buildContactCandidates(
            h,
            candidateNeighbors,
            minCenterX,
            maxCenterX,
            minCenterY,
            maxCenterY,
            contactRaw,
            MAX_CONTACT_CANDIDATES,
          );
          for (const c of contactRaw) addCandidate(c.x, c.y);
        }

        // Use a fixed lattice pitch based on model dimensions, not spacing.
        // Adding minSpacing to the pitch caused smaller spacing to create finer grids
        // which were then sampled more sparsely, missing tight placements.
        const pitchX = Math.max(1, (h.localMaxX - h.localMinX) * 1.2);
        const pitchY = Math.max(1, (h.localMaxY - h.localMinY) * 1.2);
        const colsX = Math.ceil((maxCenterX - minCenterX) / pitchX) + 1;
        const rowsY = Math.ceil((maxCenterY - minCenterY) / pitchY) + 1;
        const totalLatticeCells = (colsX + 1) * (rowsY + 1) * 1.5;
        const latticeStride = aggressive
          ? 1
          : Math.max(1, Math.ceil(totalLatticeCells / Math.max(1, MAX_LATTICE_CANDIDATES)));
        let latticeCounter = 0;
        for (let ix = 0; ix <= colsX; ix++) {
          for (let iy = 0; iy <= rowsY; iy++) {
            if ((latticeCounter++ % latticeStride) !== 0) continue;
            addCandidate(minCenterX + ix * pitchX, minCenterY + iy * pitchY);
            if (iy % 2 === 1) {
              addCandidate(minCenterX + ix * pitchX + pitchX * 0.5, minCenterY + iy * pitchY);
            }
          }
        }

        // In aggressive mode we favor row-wise frontier growth (top-to-bottom, left-to-right)
        // before tie-breaking with anchor distance.
        cands.sort((a, b) => {
          if (!aggressive) return a.sortKey - b.sortKey;
          if (Math.abs(a.y - b.y) > 1e-5) return a.y - b.y;
          if (Math.abs(a.x - b.x) > 1e-5) return a.x - b.x;
          return a.sortKey - b.sortKey;
        });

        let localBest: { center: THREE.Vector2; score: PlacementScore } | null = null;
        const scratchCenter = new THREE.Vector2();
        for (let ci = 0; ci < cands.length && ci < MAX_EVALUATED_CANDIDATES; ci++) {
          const c = cands[ci];
          scratchCenter.set(c.x, c.y);
          if (canPlaceAt(candidateProxy, scratchCenter, collisionPool, collisionLookup)) {
            const placementScore = scoreCandidatePlacement(candidateProxy, scratchCenter, placedBounds, c.sortKey);
            if (!localBest || isScoreBetter(placementScore, localBest.score)) {
              localBest = { center: scratchCenter.clone(), score: placementScore };
              if (aggressive && placementScore.area <= (placedBounds ? (placedBounds.maxX - placedBounds.minX) * (placedBounds.maxY - placedBounds.minY) * 1.01 : Number.MAX_VALUE)) {
                break;
              }
            }
          }
        }

        if (!localBest) continue;

        if (!best || isScoreBetter(localBest.score, best.score)) {
          best = { proxy: candidateProxy, center: localBest.center, rotationZ, score: localBest.score };
        }
      }

      if (best) {
        placed.push({
          model,
          center: best.center,
          rotationZ: best.rotationZ,
          hull: best.proxy.hull,
          halfW: best.proxy.halfW,
          halfD: best.proxy.halfD,
          localMinX: best.proxy.localMinX,
          localMaxX: best.proxy.localMaxX,
          localMinY: best.proxy.localMinY,
          localMaxY: best.proxy.localMaxY,
        });
        continue;
      }

      const fallback = getHullAtRotation(model, t.rotation.z);
      const outsideGap = Math.max(8, spacing);
      const spillIndex = spills.length;
      const spillCenter = new THREE.Vector2(
        maxX + outsideGap - fallback.localMinX,
        minY - fallback.localMinY + spillIndex * ((fallback.localMaxY - fallback.localMinY) + spacing),
      );
      spills.push({
        model,
        center: spillCenter,
        rotationZ: t.rotation.z,
        hull: fallback.points,
        halfW: fallback.halfW,
        halfD: fallback.halfD,
        localMinX: fallback.localMinX,
        localMaxX: fallback.localMaxX,
        localMinY: fallback.localMinY,
        localMaxY: fallback.localMaxY,
      });
    }

    return { placed, spills };
  };

  // Phase 2: Multi-order constructive search (ordering is a major quality lever).
  let bestResult = attemptPlacement(modelOrder, false);

  if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
    const spillIds = new Set(bestResult.spills.map(s => s.model.id));
    const spillFirstOrder = [
      ...modelOrder.filter(m => spillIds.has(m.id)),
      ...modelOrder.filter(m => !spillIds.has(m.id)),
    ];
    const attempt = attemptPlacement(spillFirstOrder, false);
    if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
  }

  if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
    const attempt = attemptPlacement([...modelOrder].reverse(), false);
    if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
  }

  if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
    const interleaved: typeof modelOrder = [];
    let lo = 0; let hi = modelOrder.length - 1;
    while (lo <= hi) {
      interleaved.push(modelOrder[lo++]);
      if (lo <= hi) interleaved.push(modelOrder[hi--]);
    }
    const attempt = attemptPlacement(interleaved, false);
    if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
  }

  // Fit-rate rescue pass: if standard searches still spill, run a denser,
  // more exhaustive placement search over the same orderings.
  if (bestResult.spills.length > 0) {
    const aggressiveOrders: ArrangeModel[][] = [
      modelOrder,
      [...modelOrder].reverse(),
      (() => {
        const interleaved: ArrangeModel[] = [];
        let lo = 0; let hi = modelOrder.length - 1;
        while (lo <= hi) {
          interleaved.push(modelOrder[lo++]);
          if (lo <= hi) interleaved.push(modelOrder[hi--]);
        }
        return interleaved;
      })(),
    ];

    for (const order of aggressiveOrders) {
      const attempt = attemptPlacement(order, true);
      if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
      if (bestResult.spills.length === 0) break;
    }
  }

  const placed = bestResult.placed;
  const spills = bestResult.spills;

  // Phase 3: Local compaction (slide models toward packing objective without violating SAT spacing).
  const COMPACTION_PASSES = PERF_COMPLEX_SCENE ? 6 : 8;
  const COMPACTION_STEPS = PERF_COMPLEX_SCENE ? 12 : 16;

  const binarySlide = (entry: Placed, dir: THREE.Vector2, others: CollisionProxy[]) => {
    const start = entry.center.clone();
    if (dir.lengthSq() <= 1e-10) return false;
    let lo = 0; let hi = 1;
    for (let s = 0; s < COMPACTION_STEPS; s++) {
      const mid = (lo + hi) * 0.5;
      const c = new THREE.Vector2(start.x + dir.x * mid, start.y + dir.y * mid);
      if (canPlaceAt(entry, c, others)) lo = mid; else hi = mid;
    }
    if (lo > 1e-4) {
      entry.center.set(start.x + dir.x * lo, start.y + dir.y * lo);
      return true;
    }
    return false;
  };

  for (let pass = 0; pass < COMPACTION_PASSES; pass++) {
    let moved = false;
    const order = placed
      .map((_, i) => i)
      .sort((a, b) => placed[b].center.distanceToSquared(packingAnchor) - placed[a].center.distanceToSquared(packingAnchor));

    for (const idx of order) {
      const entry = placed[idx];
      const others: CollisionProxy[] = [...blockers];
      for (let oi = 0; oi < placed.length; oi++) {
        if (oi !== idx) others.push(placed[oi]);
      }
      const toAnchor = new THREE.Vector2(packingAnchor.x - entry.center.x, packingAnchor.y - entry.center.y);
      if (binarySlide(entry, toAnchor, others)) moved = true;
      const toAnchorX = new THREE.Vector2(packingAnchor.x - entry.center.x, 0);
      if (binarySlide(entry, toAnchorX, others)) moved = true;
      const toAnchorY = new THREE.Vector2(0, packingAnchor.y - entry.center.y);
      if (binarySlide(entry, toAnchorY, others)) moved = true;
    }

    if (!moved) break;
  }

  // Phase 4: Apply requested user anchor as a safe group translation on packed in-plate models.
  if (placed.length > 0) {
    const getPlacedBounds = (entries: Placed[]) => {
      let bMinX = Infinity;
      let bMaxX = -Infinity;
      let bMinY = Infinity;
      let bMaxY = -Infinity;
      for (const entry of entries) {
        const wb = worldBoundsAt(entry, entry.center);
        bMinX = Math.min(bMinX, wb.minX);
        bMaxX = Math.max(bMaxX, wb.maxX);
        bMinY = Math.min(bMinY, wb.minY);
        bMaxY = Math.max(bMaxY, wb.maxY);
      }
      return { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY };
    };

    const currentBounds = getPlacedBounds(placed);
    const currentCenterX = (currentBounds.minX + currentBounds.maxX) * 0.5;
    const currentCenterY = (currentBounds.minY + currentBounds.maxY) * 0.5;
    const plateCenterX = (minX + maxX) * 0.5;
    const plateCenterY = (minY + maxY) * 0.5;

    let desiredDx = 0;
    let desiredDy = 0;
    if (arrangeAnchorMode === 'front_left') {
      desiredDx = minX - currentBounds.minX;
      desiredDy = minY - currentBounds.minY;
    } else if (arrangeAnchorMode === 'front_right') {
      desiredDx = maxX - currentBounds.maxX;
      desiredDy = minY - currentBounds.minY;
    } else if (arrangeAnchorMode === 'back_left') {
      desiredDx = minX - currentBounds.minX;
      desiredDy = maxY - currentBounds.maxY;
    } else if (arrangeAnchorMode === 'back_right') {
      desiredDx = maxX - currentBounds.maxX;
      desiredDy = maxY - currentBounds.maxY;
    } else {
      desiredDx = plateCenterX - currentCenterX;
      desiredDy = plateCenterY - currentCenterY;
    }

    const canShiftPlaced = (dx: number, dy: number) => {
      for (const entry of placed) {
        const shiftedCenter = new THREE.Vector2(entry.center.x + dx, entry.center.y + dy);
        if (!withinPlateAt(entry, shiftedCenter)) return false;
        for (const blocker of blockers) {
          if (!intersectsBroadphase(entry, shiftedCenter, blocker, blocker.center, minSpacing)) continue;
          if (polygonsOverlapWithSpacing(entry.hull, shiftedCenter, blocker.hull, blocker.center, minSpacing)) {
            return false;
          }
        }
      }
      return true;
    };

    const maxDxLo = minX - currentBounds.minX;
    const maxDxHi = maxX - currentBounds.maxX;
    const maxDyLo = minY - currentBounds.minY;
    const maxDyHi = maxY - currentBounds.maxY;
    desiredDx = Math.min(maxDxHi, Math.max(maxDxLo, desiredDx));
    desiredDy = Math.min(maxDyHi, Math.max(maxDyLo, desiredDy));

    let appliedScale = 0;
    if (canShiftPlaced(desiredDx, desiredDy)) {
      appliedScale = 1;
    } else {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) * 0.5;
        if (canShiftPlaced(desiredDx * mid, desiredDy * mid)) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      appliedScale = lo;
    }

    if (appliedScale > 1e-4) {
      const dx = desiredDx * appliedScale;
      const dy = desiredDy * appliedScale;
      for (const entry of placed) {
        entry.center.set(entry.center.x + dx, entry.center.y + dy);
      }
    }
  }

  // Phase 5: Deterministic spill layout outside plate for models that still cannot fit.
  if (spills.length > 0) {
    const outsideGap = Math.max(8, spacing);
    let columnLeftX = maxX + outsideGap;
    let columnYCursor = minY;
    let columnMaxWidth = 0;

    for (const entry of spills) {
      const w = entry.localMaxX - entry.localMinX;
      const d = entry.localMaxY - entry.localMinY;
      if (columnYCursor > minY && (columnYCursor + d) > maxY) {
        columnLeftX += columnMaxWidth + outsideGap;
        columnMaxWidth = 0;
        columnYCursor = minY;
      }
      entry.center.set(columnLeftX - entry.localMinX, columnYCursor - entry.localMinY);
      columnYCursor += d + spacing;
      columnMaxWidth = Math.max(columnMaxWidth, w);
    }
  }

  // Final phase: materialize transform updates for scene application.
  return [...placed, ...spills].map((entry) => {
    const t = modelTransformById.get(entry.model.id) ?? entry.model.transform;
    return {
      id: entry.model.id,
      transform: {
        position: new THREE.Vector3(entry.center.x, entry.center.y, t.position.z),
        rotation: new THREE.Euler(t.rotation.x, t.rotation.y, entry.rotationZ, t.rotation.order),
        scale: t.scale.clone(),
      },
    };
  });
}
