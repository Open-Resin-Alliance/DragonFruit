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

    const points2d: THREE.Vector2[] = [];
    const tmp = new THREE.Vector3();
    const center = new THREE.Vector3();
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      quaternionFromGlobalEuler({ x: transform.rotation.x, y: transform.rotation.y, z: transform.rotation.z }),
      transform.scale,
    );

    geometry.computeBoundingBox();
    if (geometry.boundingBox) {
      center.copy(geometry.boundingBox.getCenter(new THREE.Vector3()));

      // Fast path: use 8 bounding-box corners as SAT seed points.
      const bb = geometry.boundingBox;
      const corners = [
        new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
        new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
        new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
      ];

      for (const corner of corners) {
        tmp.set(corner.x - center.x, corner.y - center.y, corner.z - center.z).applyMatrix4(matrix);
        points2d.push(new THREE.Vector2(tmp.x, tmp.y));
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

  // Point-in-convex-polygon test (works for CW or CCW winding)
  const checkSATOverlap = useCallback((hullA: ModelHoverData, pointB: THREE.Vector2): boolean => {
    let sawPositive = false;
    let sawNegative = false;

    for (let i = 0; i < hullA.hull.length; i++) {
      const a = hullA.hull[i];
      const b = hullA.hull[(i + 1) % hullA.hull.length];
      const cross = ((b.x - a.x) * (pointB.y - a.y)) - ((b.y - a.y) * (pointB.x - a.x));

      if (cross > 1e-6) sawPositive = true;
      else if (cross < -1e-6) sawNegative = true;

      if (sawPositive && sawNegative) return false;
    }

    return true;
  }, []);

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

  const runHoverCheck = useCallback(() => {
    const cursorWorld = screenToWorld2D(cursorPosRef.current.x, cursorPosRef.current.y);

    let hoveredModelId: string | null = null;
    let minDist = Infinity;

    for (const modelId of visibleModelIds) {
      const hull = getOrBuildHull(modelId);
      if (!hull) continue;

      if (checkSATOverlap(hull, cursorWorld)) {
        const dist = cursorWorld.distanceToSquared(hull.center);
        if (dist < minDist) {
          minDist = dist;
          hoveredModelId = modelId;
        }
      }
    }

    if (hoveredModelId !== lastHoveredModelIdRef.current) {
      lastHoveredModelIdRef.current = hoveredModelId;
      window.dispatchEvent(new CustomEvent('sat-hover-model-changed', {
        detail: { modelId: hoveredModelId },
      }));
    }
  }, [checkSATOverlap, getOrBuildHull, screenToWorld2D, visibleModelIds]);

  // Event-driven hover checks (no continuous polling)
  useEffect(() => {
    if (!enabled) {
      hullCacheRef.current.clear();
      if (lastHoveredModelIdRef.current !== null) {
        lastHoveredModelIdRef.current = null;
        window.dispatchEvent(new CustomEvent('sat-hover-model-changed', {
          detail: { modelId: null },
        }));
      }
      return;
    }

    let rafId: number | null = null;
    const scheduleCheck = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        runHoverCheck();
      });
    };

    const onMouseMove = (event: MouseEvent) => {
      cursorPosRef.current = { x: event.clientX, y: event.clientY };
      scheduleCheck();
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    // Run once on enable/model-change so state is never stale.
    scheduleCheck();

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled, runHoverCheck, visibleModelIds]);

  return null;
}
