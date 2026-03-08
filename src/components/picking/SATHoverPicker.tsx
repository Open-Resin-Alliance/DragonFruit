'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

/**
 * SATHoverPicker: Uses Separating Axis Theorem with support-inclusive hulls
 * for unified model+support+raft hover detection.
 * 
 * Replaces GPU picking to eliminate desync between model/support/raft hover states
 * by testing a single SAT polygon per model that includes all its supports/raft.
 */

interface ModelHoverData {
  modelId: string;
  center: THREE.Vector2;
  hull: THREE.Vector2[];
  localMinX: number;
  localMaxX: number;
  localMinY: number;
  localMaxY: number;
}

interface SATHoverPickerProps {
  enabled: boolean;
  visibleModelIds: string[];
  getModelTransform: (modelId: string) => { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } | null;
  getModelGeometry: (modelId: string) => THREE.BufferGeometry | null;
  getSupportLocalPoints: (modelId: string) => THREE.Vector3[] | null;
}

export function SATHoverPicker({
  enabled,
  visibleModelIds,
  getModelTransform,
  getModelGeometry,
  getSupportLocalPoints,
}: SATHoverPickerProps) {
  const { camera, size } = useThree();
  const canvasSize = { width: size.width, height: size.height };
  
  const hullCacheRef = useRef<Map<string, ModelHoverData>>(new Map());
  const cursorPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastHoveredModelIdRef = useRef<string | null>(null);

  // Cache key combines geometry UUID + support hull key + transform
  const getHullCacheKey = useCallback((modelId: string): string => {
    const transform = getModelTransform(modelId);
    const geometry = getModelGeometry(modelId);
    if (!transform || !geometry) return '';

    // For hover purposes, we can simplify: just cache based on geometry + transform position
    // (real rotation/scale changes are rare during hover)
    return [
      geometry.uuid,
      'hover_' + Math.round(transform.position.x * 10),
      Math.round(transform.position.y * 10),
      Math.round(transform.position.z * 10),
    ].join('|');
  }, [getModelTransform, getModelGeometry]);

  // Build/retrieve support-inclusive hull for a model
  const getOrBuildHull = useCallback((modelId: string): ModelHoverData | null => {
    const transform = getModelTransform(modelId);
    const geometry = getModelGeometry(modelId);
    if (!transform || !geometry) return null;

    const key = getHullCacheKey(modelId);
    if (!key) return null;

    const cached = hullCacheRef.current.get(key);
    if (cached) return cached;

    // Build 2D hull from model geometry + support points
    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!positionAttr || positionAttr.count < 3) {
      const fallbackHull: ModelHoverData = {
        modelId,
        center: new THREE.Vector2(transform.position.x, transform.position.y),
        hull: [
          new THREE.Vector2(-1, -1),
          new THREE.Vector2(1, -1),
          new THREE.Vector2(1, 1),
          new THREE.Vector2(-1, 1),
        ],
        localMinX: -1,
        localMaxX: 1,
        localMinY: -1,
        localMaxY: 1,
      };
      hullCacheRef.current.set(key, fallbackHull);
      return fallbackHull;
    }

    // Sample geometry points
    const points2d: THREE.Vector2[] = [];
    const stride = Math.max(1, Math.floor(positionAttr.count / 8000));
    const tmp = new THREE.Vector3();
    const center = new THREE.Vector3();
    geometry.computeBoundingBox();
    if (geometry.boundingBox) {
      center.copy(geometry.boundingBox.getCenter(new THREE.Vector3()));
    }

    // Create transformation matrix for this model
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      quaternionFromGlobalEuler({ x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z }),
      transform.scale,
    );

    // Sample geometry vertices in local XY
    for (let i = 0; i < positionAttr.count; i += stride) {
      tmp.set(
        positionAttr.getX(i) - center.x,
        positionAttr.getY(i) - center.y,
        positionAttr.getZ(i) - center.z,
      ).applyMatrix4(matrix);
      points2d.push(new THREE.Vector2(tmp.x, tmp.y));
    }

    // Add extreme points for better hull coverage
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
      for (let d = 0; d < nE; d++) {
        const dot = tx * eDx[d] + ty * eDy[d];
        if (dot > eDot[d]) {
          eDot[d] = dot;
          eXArr[d] = tx;
          eYArr[d] = ty;
        }
      }
    }
    for (let d = 0; d < nE; d++) {
      if (Number.isFinite(eXArr[d]) && Number.isFinite(eYArr[d])) {
        points2d.push(new THREE.Vector2(eXArr[d], eYArr[d]));
      }
    }

    // Add support local points in model space
    const supportLocalPoints = getSupportLocalPoints(modelId);
    if (supportLocalPoints && supportLocalPoints.length > 0) {
      for (const point of supportLocalPoints) {
        tmp.copy(point).applyMatrix4(matrix);
        points2d.push(new THREE.Vector2(tmp.x, tmp.y));
      }
    }

    // Compute convex hull
    const hull = convexHull2d(points2d);
    const finalHull = hull.length >= 3 ? hull : [
      new THREE.Vector2(-1, -1),
      new THREE.Vector2(1, -1),
      new THREE.Vector2(1, 1),
      new THREE.Vector2(-1, 1),
    ];

    // Compute bounds
    let localMinX = Infinity;
    let localMaxX = -Infinity;
    let localMinY = Infinity;
    let localMaxY = -Infinity;
    for (const p of finalHull) {
      localMinX = Math.min(localMinX, p.x);
      localMaxX = Math.max(localMaxX, p.x);
      localMinY = Math.min(localMinY, p.y);
      localMaxY = Math.max(localMaxY, p.y);
    }

    if (!Number.isFinite(localMinX)) {
      localMinX = -1;
      localMaxX = 1;
      localMinY = -1;
      localMaxY = 1;
    }

    const hullData: ModelHoverData = {
      modelId,
      center: new THREE.Vector2(transform.position.x, transform.position.y),
      hull: finalHull,
      localMinX,
      localMaxX,
      localMinY,
      localMaxY,
    };

    hullCacheRef.current.set(key, hullData);
    return hullData;
  }, [getModelTransform, getModelGeometry, getSupportLocalPoints, getHullCacheKey]);

  // Project polygon onto axis and return min/max
  const projectPolygon = useCallback((poly: THREE.Vector2[], center: THREE.Vector2, axis: THREE.Vector2) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of poly) {
      const dot = (p.x + center.x) * axis.x + (p.y + center.y) * axis.y;
      min = Math.min(min, dot);
      max = Math.max(max, dot);
    }
    return { min, max };
  }, []);

  // Get SAT axes from polygon edges
  const getAxesFromPolygon = useCallback((poly: THREE.Vector2[]) => {
    const axes: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const edge = new THREE.Vector2(b.x - a.x, b.y - a.y);
      if (edge.lengthSq() <= 1e-10) continue;
      axes.push(new THREE.Vector2(-edge.y, edge.x).normalize());
    }
    return axes;
  }, []);

  // SAT overlap test
  const checkSATOverlap = useCallback((hullA: ModelHoverData, pointB: THREE.Vector2): boolean => {
    const axes = getAxesFromPolygon(hullA.hull);
    // For a point, we just need to check if it's inside the polygon
    // Use a simple approach: point-in-polygon via cross products
    for (let i = 0; i < hullA.hull.length; i++) {
      const a = hullA.hull[i];
      const b = hullA.hull[(i + 1) % hullA.hull.length];
      const edge = new THREE.Vector2(b.x - a.x, b.y - a.y);
      const toPoint = new THREE.Vector2(pointB.x - a.x, pointB.y - a.y);
      const cross = edge.x * toPoint.y - edge.y * toPoint.x;
      // All cross products should have same sign for point inside
      if (i === 0) {
        if (cross < 0) return false; // Point on wrong side
      } else if (cross < 0) {
        return false;
      }
    }
    return true;
  }, [getAxesFromPolygon]);

  // Convert screen cursor to world 2D
  const screenToWorld2D = useCallback((screenX: number, screenY: number): THREE.Vector2 => {
    // Normalize to [-1, 1]
    const x = (screenX / canvasSize.width) * 2 - 1;
    const y = -(screenY / canvasSize.height) * 2 + 1;

    // Create ray
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

    // Intersect with Z=0 plane (build plate)
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, intersection);

    return new THREE.Vector2(intersection.x, intersection.y);
  }, [camera, canvasSize]);

  // Track cursor position
  useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (e: MouseEvent) => {
      cursorPosRef.current = { x: e.clientX, y: e.clientY };
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [enabled]);

  // Main hover detection loop
  useEffect(() => {
    if (!enabled) return;

    const checkHover = () => {
      // Convert cursor to world 2D
      const cursorWorld = screenToWorld2D(cursorPosRef.current.x, cursorPosRef.current.y);

      // Test all visible models
      let hoveredModelId: string | null = null;
      let minDist = Infinity;

      for (const modelId of visibleModelIds) {
        const hull = getOrBuildHull(modelId);
        if (!hull) continue;

        if (checkSATOverlap(hull, cursorWorld)) {
          // Multiple hits: pick closest to cursor
          const dist = cursorWorld.distanceTo(hull.center);
          if (dist < minDist) {
            minDist = dist;
            hoveredModelId = modelId;
          }
        }
      }

      // Dispatch event if hover changed
      if (hoveredModelId !== lastHoveredModelIdRef.current) {
        lastHoveredModelIdRef.current = hoveredModelId;
        window.dispatchEvent(new CustomEvent('sat-hover-model-changed', {
          detail: { modelId: hoveredModelId },
        }));
      }
    };

    // Check hover on animation frame
    const frameId = setInterval(checkHover, 16); // ~60fps

    return () => clearInterval(frameId);
  }, [enabled, visibleModelIds, getOrBuildHull, checkSATOverlap, screenToWorld2D]);

  // Clear cache when models change
  useEffect(() => {
    if (!enabled) {
      hullCacheRef.current.clear();
    }
  }, [enabled, visibleModelIds]);

  return null;
}
