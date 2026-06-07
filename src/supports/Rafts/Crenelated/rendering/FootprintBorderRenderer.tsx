"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getKickstandSnapshot, subscribeToKickstandStore } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import { computeFootprint } from '../geometry/computeFootprint';
import { computeRaftOuterBoundary } from '../geometry/computeRaftOuterBoundary';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { computeProjectedFootprintHull } from '@/utils/modelFootprint';
import { collectRaftBaseCirclesByModel, RAFT_UNASSIGNED_MODEL_KEY } from '../raftFootprintCircles';

interface FootprintBorderRendererProps {
  modelGeometry: GeometryWithBounds | null;
  modelTransform: ModelTransform | null | undefined;
  modelId?: string | null;
  color?: string;
}

const FOOTPRINT_BORDER_Z = 0.001;
const FOOTPRINT_BORDER_MARGIN_MAX_MM = 0.05;
const FOOTPRINT_BORDER_OUTLINE_PADDING_MM = 0.1;
const FOOTPRINT_SILHOUETTE_CACHE_MAX_ENTRIES = 32;

const sharedFootprintSilhouetteCache = new Map<string, THREE.Vector2[]>();

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Convex hull using monotonic chain algorithm
 */
function convexHull(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length <= 1) return points.slice();

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

/**
 * Offset a polygon outward by a given distance
 */
function offsetPolygonOutward(polygon: THREE.Vector2[], distance: number): THREE.Vector2[] {
  if (polygon.length < 3 || distance <= 0) return polygon.map(p => p.clone());

  const result: THREE.Vector2[] = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    // Edge vectors
    const edge1 = new THREE.Vector2().subVectors(curr, prev).normalize();
    const edge2 = new THREE.Vector2().subVectors(next, curr).normalize();

    // Perpendicular normals (outward for CCW polygon)
    const normal1 = new THREE.Vector2(edge1.y, -edge1.x);
    const normal2 = new THREE.Vector2(edge2.y, -edge2.x);

    // Average normal at vertex
    const avgNormal = new THREE.Vector2()
      .addVectors(normal1, normal2)
      .normalize();

    // Compute offset distance accounting for angle
    const cosAngle = normal1.dot(normal2);
    const offsetDist = distance / Math.max(0.1, Math.sqrt((1 + cosAngle) / 2));

    // Offset vertex outward
    const offsetVertex = new THREE.Vector2()
      .copy(curr)
      .addScaledVector(avgNormal, offsetDist);

    result.push(offsetVertex);
  }

  return result;
}

function transformKeyPart(value: number | undefined): string {
  return Number.isFinite(value) ? (value as number).toFixed(5) : '0';
}

function makeFootprintSilhouetteCacheKey(
  modelGeometry: GeometryWithBounds,
  modelTransform: ModelTransform,
): string {
  return [
    modelGeometry.geometry.uuid,
    transformKeyPart(modelTransform.rotation.x),
    transformKeyPart(modelTransform.rotation.y),
    transformKeyPart(modelTransform.rotation.z),
    transformKeyPart(modelTransform.scale.x),
    transformKeyPart(modelTransform.scale.y),
    transformKeyPart(modelTransform.scale.z),
  ].join('|');
}

function cloneFootprint(points: THREE.Vector2[]): THREE.Vector2[] {
  return points.map((point) => point.clone());
}

function rememberFootprintSilhouette(cacheKey: string, hull: THREE.Vector2[]): THREE.Vector2[] {
  const cachedHull = cloneFootprint(hull);
  sharedFootprintSilhouetteCache.set(cacheKey, cachedHull);

  while (sharedFootprintSilhouetteCache.size > FOOTPRINT_SILHOUETTE_CACHE_MAX_ENTRIES) {
    const oldestKey = sharedFootprintSilhouetteCache.keys().next().value;
    if (!oldestKey) break;
    sharedFootprintSilhouetteCache.delete(oldestKey);
  }

  return cloneFootprint(cachedHull);
}

function getCachedFootprintSilhouette(cacheKey: string): THREE.Vector2[] | null {
  const cached = sharedFootprintSilhouetteCache.get(cacheKey);
  if (!cached) return null;

  // Refresh insertion order for simple LRU behavior.
  sharedFootprintSilhouetteCache.delete(cacheKey);
  sharedFootprintSilhouetteCache.set(cacheKey, cached);
  return cloneFootprint(cached);
}

function computeLocalModelFootprintHull(
  modelGeometry: GeometryWithBounds,
  modelTransform: ModelTransform,
): THREE.Vector2[] {
  return computeProjectedFootprintHull(
    modelGeometry,
    modelTransform.rotation,
    modelTransform.scale,
  );
}

function getOrComputeLocalModelFootprintHull(
  modelGeometry: GeometryWithBounds,
  modelTransform: ModelTransform,
  cacheKey: string,
): THREE.Vector2[] {
  const cached = getCachedFootprintSilhouette(cacheKey);
  if (cached) return cached;

  return rememberFootprintSilhouette(
    cacheKey,
    computeLocalModelFootprintHull(modelGeometry, modelTransform),
  );
}

/**
 * FootprintBorderRenderer
 * - Renders a blue line border showing combined model + raft footprint with margin
 * - Uses bounded silhouette candidates from the model's transformed XY projection
 *   so the outline tracks wide overhangs without loading-time vertex-cloud churn.
 */
export default function FootprintBorderRenderer({
  modelGeometry,
  modelTransform,
  modelId = null,
  color = '#3b82f6',
}: FootprintBorderRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const kickstandState = useSyncExternalStore(subscribeToKickstandStore, getKickstandSnapshot, getKickstandSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const [localModelFootprintHull, setLocalModelFootprintHull] = React.useState<THREE.Vector2[]>([]);
  const hullCacheKeyRef = React.useRef<string | null>(null);

  const supportFootprintPoints = React.useMemo(() => {
    const circlesByModel = collectRaftBaseCirclesByModel({
      roots: Object.values(supportState.roots),
      anchors: Object.values(supportState.anchors),
      kickstandRoots: Object.values(kickstandState.roots),
    }, modelId != null
      ? { modelFilterId: modelId, fallbackModelKey: RAFT_UNASSIGNED_MODEL_KEY }
      : { fallbackModelKey: RAFT_UNASSIGNED_MODEL_KEY });

    const circles = modelId != null
      ? (circlesByModel.get(modelId) ?? [])
      : Array.from(circlesByModel.values()).flat();

    if (circles.length === 0) return [];

    const baseProfile = computeFootprint(circles, { marginMm: 0.2, samplesPerCircle: 24 });
    if (!baseProfile || baseProfile.length < 3) return [];

    const raftOuterBoundary = computeRaftOuterBoundary(baseProfile, raft);
    return raftOuterBoundary && raftOuterBoundary.length >= 3 ? raftOuterBoundary : [];
  }, [modelId, raft, supportState.anchors, supportState.roots, kickstandState.roots]);

  React.useEffect(() => {
    if (!modelGeometry || !modelTransform) {
      hullCacheKeyRef.current = null;
      setLocalModelFootprintHull([]);
      return;
    }

    const cacheKey = makeFootprintSilhouetteCacheKey(modelGeometry, modelTransform);
    hullCacheKeyRef.current = cacheKey;

    const cachedHull = getCachedFootprintSilhouette(cacheKey);
    if (cachedHull) {
      setLocalModelFootprintHull(cachedHull);
      return;
    }

    setLocalModelFootprintHull([]);

    let cancelled = false;
    const idleWindow = typeof window !== 'undefined' ? window as IdleWindow : null;
    const run = () => {
      if (cancelled) return;
      const nextHull = getOrComputeLocalModelFootprintHull(modelGeometry, modelTransform, cacheKey);
      if (!cancelled && hullCacheKeyRef.current === cacheKey) setLocalModelFootprintHull(nextHull);
    };

    let cancelSchedule: () => void;
    if (idleWindow?.requestIdleCallback) {
      const delayHandle = window.setTimeout(() => {
        if (cancelled) return;
        const handle = idleWindow.requestIdleCallback(run);
        cancelSchedule = () => idleWindow.cancelIdleCallback?.(handle);
      }, 1400);
      cancelSchedule = () => window.clearTimeout(delayHandle);
    } else if (typeof window !== 'undefined') {
      const handle = window.setTimeout(run, 1400);
      cancelSchedule = () => window.clearTimeout(handle);
    } else {
      run();
      cancelSchedule = () => {};
    }

    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [
    modelGeometry,
    modelTransform?.rotation.x,
    modelTransform?.rotation.y,
    modelTransform?.rotation.z,
    modelTransform?.scale.x,
    modelTransform?.scale.y,
    modelTransform?.scale.z,
  ]);

  const modelFootprintHull = React.useMemo(() => {
    if (!modelTransform || localModelFootprintHull.length < 3) return [];
    const offsetX = modelTransform.position.x;
    const offsetY = modelTransform.position.y;
    return localModelFootprintHull.map((point) => new THREE.Vector2(
      point.x + offsetX,
      point.y + offsetY,
    ));
  }, [
    localModelFootprintHull,
    modelTransform?.position.x,
    modelTransform?.position.y,
  ]);

  const borderLine = React.useMemo(() => {
    if (raft.bottomMode === 'off' || !raft.showFootprintBorder) return null;

    const allPoints: THREE.Vector2[] = [];

    // 1. Add raft outer boundary points
    if (supportFootprintPoints.length >= 3) {
      allPoints.push(...supportFootprintPoints);
    }

    // 2. Add cached model XY silhouette.
    if (modelFootprintHull.length >= 3) {
      allPoints.push(...modelFootprintHull);
    }

    if (allPoints.length < 3) return null;

    // 3. Compute convex hull
    const combinedHull = convexHull(allPoints);
    if (!combinedHull || combinedHull.length < 3) return null;

    // 4. Add margin
    const margin = Math.min(FOOTPRINT_BORDER_MARGIN_MAX_MM, Math.max(0, raft.footprintBorderMargin || 0));
    const borderProfile = offsetPolygonOutward(
      combinedHull,
      FOOTPRINT_BORDER_OUTLINE_PADDING_MM + margin
    );
    if (!borderProfile || borderProfile.length < 3) return null;

    // 5. Create line geometry
    const points: THREE.Vector3[] = [];
    for (const p of borderProfile) {
      points.push(new THREE.Vector3(p.x, p.y, FOOTPRINT_BORDER_Z));
    }
    points.push(new THREE.Vector3(borderProfile[0].x, borderProfile[0].y, FOOTPRINT_BORDER_Z));

    return new THREE.BufferGeometry().setFromPoints(points);
  }, [
    modelFootprintHull,
    raft,
    supportFootprintPoints,
  ]);

  React.useEffect(() => {
    return () => {
      borderLine?.dispose();
    };
  }, [borderLine]);

  const borderObject = React.useMemo(() => {
    if (!borderLine) return null;
    const line = new THREE.Line(
      borderLine,
      new THREE.LineBasicMaterial({
        color,
        linewidth: 5,
        opacity: 0.5,
        transparent: true,
      }),
    );
    line.userData = {
      ...(line.userData ?? {}),
      thumbnailHelperType: 'footprintBorder',
    };
    line.frustumCulled = false;
    return line;
  }, [borderLine, color]);

  React.useEffect(() => {
    return () => {
      const material = borderObject?.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item.dispose());
      } else {
        material?.dispose();
      }
    };
  }, [borderObject]);

  if (raft.bottomMode === 'off' || !raft.showFootprintBorder || !borderObject) {
    return null;
  }

  return <primitive object={borderObject} />;
}
