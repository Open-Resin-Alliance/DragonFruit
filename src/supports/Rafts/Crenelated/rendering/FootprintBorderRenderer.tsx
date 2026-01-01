"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '@/supports/state';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import { SupportBaseCircle } from '../RaftTypes';
import { computeFootprint } from '../geometry/computeFootprint';
import { computeRaftOuterBoundary } from '../geometry/computeRaftOuterBoundary';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';

interface FootprintBorderRendererProps {
  modelGeometry: GeometryWithBounds | null;
  modelTransform: ModelTransform | null | undefined;
}

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

/**
 * FootprintBorderRenderer
 * - Renders a blue line border showing combined model + raft footprint with margin
 * - Uses BVH-accelerated raycasting for accurate model footprint ("100 little lights" approach)
 */
export default function FootprintBorderRenderer({
  modelGeometry,
  modelTransform
}: FootprintBorderRendererProps) {
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const borderLine = React.useMemo(() => {
    if (raft.bottomMode === 'off' || !raft.showFootprintBorder) return null;

    const allPoints: THREE.Vector2[] = [];

    // 1. Add raft outer boundary points
    const circles: SupportBaseCircle[] = Object.values(supportState.roots).map(root => ({
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    }));

    if (circles.length > 0) {
      const baseProfile = computeFootprint(circles, { marginMm: 0.2, samplesPerCircle: 24 });
      if (baseProfile && baseProfile.length >= 3) {
        const raftOuterBoundary = computeRaftOuterBoundary(baseProfile, raft);
        if (raftOuterBoundary && raftOuterBoundary.length >= 3) {
          allPoints.push(...raftOuterBoundary);
        }
      }
    }

    // 2. Add model footprint using raycasting
    if (modelGeometry && modelTransform) {

      // Build transform matrix
      const bbox = modelGeometry.geometry.boundingBox ??
        new THREE.Box3().setFromBufferAttribute(
          modelGeometry.geometry.getAttribute('position') as THREE.BufferAttribute
        );
      const center = bbox.getCenter(new THREE.Vector3());

      const transformMatrix = new THREE.Matrix4();
      transformMatrix.compose(
        modelTransform.position,
        new THREE.Quaternion().setFromEuler(modelTransform.rotation),
        modelTransform.scale
      );
      const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      transformMatrix.multiply(offsetMatrix);

      // Compute world-space bounds
      const corners = [
        new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
        new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z),
        new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
        new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z),
        new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
        new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z),
        new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z),
        new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z),
      ];

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let maxZ = -Infinity;

      for (const corner of corners) {
        corner.applyMatrix4(transformMatrix);
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
        maxZ = Math.max(maxZ, corner.z);
      }

      // @ts-ignore - BVH is added by three-mesh-bvh
      const bvh = modelGeometry.geometry.boundsTree;

      if (bvh) {
        // RAYCAST APPROACH: Cast rays from above in a grid
        const GRID_SIZE = 50; // 50x50 = 2,500 rays (increased for better accuracy)
        const stepX = (maxX - minX) / GRID_SIZE;
        const stepY = (maxY - minY) / GRID_SIZE;

        const raycaster = new THREE.Raycaster();
        const rayOrigin = new THREE.Vector3();
        const rayDir = new THREE.Vector3(0, 0, -1);
        const inverseMatrix = transformMatrix.clone().invert();

        for (let i = 0; i <= GRID_SIZE; i++) {
          for (let j = 0; j <= GRID_SIZE; j++) {
            const worldX = minX + i * stepX;
            const worldY = minY + j * stepY;

            // Set up ray in world space
            rayOrigin.set(worldX, worldY, maxZ + 10);
            raycaster.ray.origin.copy(rayOrigin);
            raycaster.ray.direction.copy(rayDir);

            // Transform to local space for BVH query
            raycaster.ray.applyMatrix4(inverseMatrix);

            // Cast ray
            // @ts-ignore
            const hit = bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);

            if (hit) {
              // Transform hit back to world space
              const worldHit = hit.point.clone().applyMatrix4(transformMatrix);
              allPoints.push(new THREE.Vector2(worldHit.x, worldHit.y));
            }
          }
        }
      } else {
        // FALLBACK: Use bbox corners if no BVH
        for (const corner of corners) {
          allPoints.push(new THREE.Vector2(corner.x, corner.y));
        }
      }

    }

    if (allPoints.length < 3) return null;

    // 3. Compute convex hull
    const combinedHull = convexHull(allPoints);
    if (!combinedHull || combinedHull.length < 3) return null;

    // 4. Add margin
    const margin = raft.footprintBorderMargin || 2.0;
    const borderProfile = offsetPolygonOutward(combinedHull, margin);
    if (!borderProfile || borderProfile.length < 3) return null;

    // 5. Create line geometry
    const points: THREE.Vector3[] = [];
    for (const p of borderProfile) {
      points.push(new THREE.Vector3(p.x, p.y, -1.0));
    }
    points.push(new THREE.Vector3(borderProfile[0].x, borderProfile[0].y, -1.0));

    return new THREE.BufferGeometry().setFromPoints(points);
  }, [modelGeometry, modelTransform, supportState, raft]);

  if (raft.bottomMode === 'off' || !raft.showFootprintBorder || !borderLine) {
    return null;
  }

  return (
    <primitive object={new THREE.Line(borderLine, new THREE.LineBasicMaterial({
      color: '#3b82f6',
      linewidth: 5,
      opacity: 0.5,
      transparent: true
    }))} />
  );
}
