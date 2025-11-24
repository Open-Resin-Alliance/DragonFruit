"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { getSupportList, subscribeToSupportStore } from '@/supports/state';
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
    // For CCW: right normal (edge.y, -edge.x) points outward
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
 * - Positioned below the build plate for build plate organization visualization
 * - Updates when model transforms, raft changes, or supports change
 */
export default function FootprintBorderRenderer({ 
  modelGeometry, 
  modelTransform 
}: FootprintBorderRendererProps) {
  const supports = useSyncExternalStore(subscribeToSupportStore, getSupportList, () => []);
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const borderLine = React.useMemo(() => {
    if (!raft.enabled || !raft.showFootprintBorder) return null;

    const allPoints: THREE.Vector2[] = [];

    // 1. Add raft outer boundary points
    const circles: SupportBaseCircle[] = supports
      .filter(s => s?.settings?.base?.diameterMm && s.base)
      .map(s => ({
        x: s.base.x,
        y: s.base.y,
        r: (s.settings.base.diameterMm || 0) / 2,
      }));

    if (circles.length > 0) {
      // Get base raft footprint
      const baseProfile = computeFootprint(circles, { marginMm: 0.2, samplesPerCircle: 24 });
      if (baseProfile && baseProfile.length >= 3) {
        // Compute outer boundary including chamfer and walls
        const raftOuterBoundary = computeRaftOuterBoundary(baseProfile, raft);
        if (raftOuterBoundary && raftOuterBoundary.length >= 3) {
          allPoints.push(...raftOuterBoundary);
        }
      }
    }

    // 2. Add model footprint points (transformed to world space)
    if (modelGeometry && modelTransform) {
      // Build transform matrix accounting for mesh center offset
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

      // Sample model vertices and transform to world space
      const positions = modelGeometry.geometry.attributes.position;
      if (positions) {
        const vertex = new THREE.Vector3();
        const worldVertex = new THREE.Vector3();
        
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i);
          worldVertex.copy(vertex).applyMatrix4(transformMatrix);
          allPoints.push(new THREE.Vector2(worldVertex.x, worldVertex.y));
        }
      }
    }

    if (allPoints.length < 3) return null;

    // 3. Compute convex hull of all points (model + raft)
    const combinedHull = convexHull(allPoints);
    if (!combinedHull || combinedHull.length < 3) return null;

    // 4. Add margin beyond the combined hull (adjustable setting)
    const margin = raft.footprintBorderMargin || 2.0;
    const borderProfile = offsetPolygonOutward(combinedHull, margin);
    if (!borderProfile || borderProfile.length < 3) return null;

    // Create line geometry from profile
    const points: THREE.Vector3[] = [];
    for (const p of borderProfile) {
      points.push(new THREE.Vector3(p.x, p.y, -1.0)); // Z = -1mm below build plate
    }
    // Close the loop
    points.push(new THREE.Vector3(borderProfile[0].x, borderProfile[0].y, -1.0));

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    return geometry;
  }, [modelGeometry, modelTransform, supports, raft]);

  if (!raft.enabled || !raft.showFootprintBorder || !borderLine) {
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
