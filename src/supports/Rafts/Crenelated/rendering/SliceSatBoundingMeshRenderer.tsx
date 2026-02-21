"use client";

import React from 'react';
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { getRaftSettings, subscribeToRaftStore } from '../RaftState';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import type { ModelTransform } from '@/hooks/useModelTransform';

interface SliceSatBoundingMeshRendererProps {
  modelGeometry: GeometryWithBounds | null;
  modelTransform: ModelTransform | null | undefined;
  enabled: boolean;
  renderMode?: 'shaded' | 'wireframe';
}

const GRID_SIZE = 34;
const SLICE_COUNT = 24;
const RESAMPLED_RING_POINTS = 64;

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

function offsetPolygonOutward(polygon: THREE.Vector2[], distance: number): THREE.Vector2[] {
  if (polygon.length < 3 || distance <= 0) return polygon.map((p) => p.clone());

  const result: THREE.Vector2[] = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    const edge1 = new THREE.Vector2().subVectors(curr, prev).normalize();
    const edge2 = new THREE.Vector2().subVectors(next, curr).normalize();

    const normal1 = new THREE.Vector2(edge1.y, -edge1.x);
    const normal2 = new THREE.Vector2(edge2.y, -edge2.x);

    const avgNormal = new THREE.Vector2().addVectors(normal1, normal2).normalize();
    const cosAngle = normal1.dot(normal2);
    const offsetDist = distance / Math.max(0.1, Math.sqrt((1 + cosAngle) / 2));

    result.push(new THREE.Vector2().copy(curr).addScaledVector(avgNormal, offsetDist));
  }

  return result;
}

function resampleClosedPolygon(polygon: THREE.Vector2[], targetCount: number): THREE.Vector2[] {
  if (polygon.length < 3 || targetCount < 3) return [];

  const lengths: number[] = [];
  let totalLength = 0;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const len = a.distanceTo(b);
    lengths.push(len);
    totalLength += len;
  }

  if (totalLength <= 1e-6) return [];

  const result: THREE.Vector2[] = [];

  for (let i = 0; i < targetCount; i++) {
    const targetDist = (i / targetCount) * totalLength;
    let traversed = 0;

    for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
      const edgeLen = lengths[edgeIndex];
      if (traversed + edgeLen >= targetDist) {
        const t = edgeLen <= 1e-6 ? 0 : (targetDist - traversed) / edgeLen;
        const from = polygon[edgeIndex];
        const to = polygon[(edgeIndex + 1) % polygon.length];
        result.push(new THREE.Vector2().lerpVectors(from, to, THREE.MathUtils.clamp(t, 0, 1)));
        break;
      }
      traversed += edgeLen;
    }
  }

  return result;
}

type SliceRing = {
  z: number;
  points: THREE.Vector2[];
};

function cloneRingPoints(points: THREE.Vector2[]): THREE.Vector2[] {
  return points.map((p) => p.clone());
}

function buildSliceMeshGeometry(rings: SliceRing[]): THREE.BufferGeometry | null {
  if (rings.length < 2) return null;

  const ringSize = rings[0].points.length;
  if (ringSize < 3) return null;
  if (!rings.every((ring) => ring.points.length === ringSize)) return null;

  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (const p of ring.points) {
      positions.push(p.x, p.y, ring.z);
    }
  }

  for (let slice = 0; slice < rings.length - 1; slice++) {
    const aBase = slice * ringSize;
    const bBase = (slice + 1) * ringSize;

    for (let i = 0; i < ringSize; i++) {
      const next = (i + 1) % ringSize;
      const a = aBase + i;
      const b = aBase + next;
      const c = bBase + i;
      const d = bBase + next;

      indices.push(a, b, d);
      indices.push(a, d, c);
    }
  }

  const bottomBase = 0;
  const topBase = (rings.length - 1) * ringSize;

  const bottomCenter = new THREE.Vector2();
  for (const p of rings[0].points) bottomCenter.add(p);
  bottomCenter.multiplyScalar(1 / ringSize);
  const bottomCenterIndex = positions.length / 3;
  positions.push(bottomCenter.x, bottomCenter.y, rings[0].z);

  for (let i = 0; i < ringSize; i++) {
    const next = (i + 1) % ringSize;
    indices.push(bottomCenterIndex, bottomBase + next, bottomBase + i);
  }

  const topCenter = new THREE.Vector2();
  for (const p of rings[rings.length - 1].points) topCenter.add(p);
  topCenter.multiplyScalar(1 / ringSize);
  const topCenterIndex = positions.length / 3;
  positions.push(topCenter.x, topCenter.y, rings[rings.length - 1].z);

  for (let i = 0; i < ringSize; i++) {
    const next = (i + 1) % ringSize;
    indices.push(topCenterIndex, topBase + i, topBase + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export default function SliceSatBoundingMeshRenderer({
  modelGeometry,
  modelTransform,
  enabled,
  renderMode = 'shaded',
}: SliceSatBoundingMeshRendererProps) {
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const satMeshGeometry = React.useMemo(() => {
    if (!enabled || !modelGeometry || !modelTransform) return null;

    const bbox = modelGeometry.geometry.boundingBox
      ?? new THREE.Box3().setFromBufferAttribute(
        modelGeometry.geometry.getAttribute('position') as THREE.BufferAttribute,
      );
    const center = bbox.getCenter(new THREE.Vector3());

    const transformMatrix = new THREE.Matrix4();
    transformMatrix.compose(
      modelTransform.position,
      new THREE.Quaternion().setFromEuler(modelTransform.rotation),
      modelTransform.scale,
    );
    transformMatrix.multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

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

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const corner of corners) {
      corner.applyMatrix4(transformMatrix);
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y);
      maxY = Math.max(maxY, corner.y);
      minZ = Math.min(minZ, corner.z);
      maxZ = Math.max(maxZ, corner.z);
    }

    const margin = Math.max(0, raft.footprintBorderMargin || 0);
    const zPadding = margin;
    const rings: SliceRing[] = [];

    // @ts-ignore - injected by three-mesh-bvh
    const bvh = modelGeometry.geometry.boundsTree;

    if (bvh) {
      const startZ = minZ - zPadding;
      const endZ = maxZ + zPadding;
      const sliceStep = (endZ - startZ) / Math.max(1, SLICE_COUNT);
      const halfThickness = Math.max(0.35, sliceStep * 0.6);

      const raycaster = new THREE.Raycaster();
      const rayOrigin = new THREE.Vector3();
      const rayDir = new THREE.Vector3(0, 0, -1);
      const inverseMatrix = transformMatrix.clone().invert();
      const rayStartZ = maxZ + zPadding + 12;

      for (let sliceIndex = 0; sliceIndex <= SLICE_COUNT; sliceIndex++) {
        const z = startZ + (sliceIndex / SLICE_COUNT) * (endZ - startZ);
        const slicePoints: THREE.Vector2[] = [];

        for (let i = 0; i <= GRID_SIZE; i++) {
          for (let j = 0; j <= GRID_SIZE; j++) {
            const worldX = minX + (i / GRID_SIZE) * (maxX - minX);
            const worldY = minY + (j / GRID_SIZE) * (maxY - minY);

            rayOrigin.set(worldX, worldY, rayStartZ);
            raycaster.ray.origin.copy(rayOrigin);
            raycaster.ray.direction.copy(rayDir);
            raycaster.ray.applyMatrix4(inverseMatrix);

            // @ts-ignore - three-mesh-bvh extension API
            const hits = bvh.raycast(raycaster.ray, THREE.DoubleSide);
            if (!hits || hits.length === 0) continue;

            for (const hit of hits) {
              const worldHit = hit.point.clone().applyMatrix4(transformMatrix);
              if (Math.abs(worldHit.z - z) <= halfThickness) {
                slicePoints.push(new THREE.Vector2(worldHit.x, worldHit.y));
              }
            }
          }
        }

        if (slicePoints.length < 3) continue;

        const hull = convexHull(slicePoints);
        if (hull.length < 3) continue;

        const expanded = offsetPolygonOutward(hull, margin);
        if (expanded.length < 3) continue;

        const sampled = resampleClosedPolygon(expanded, RESAMPLED_RING_POINTS);
        if (sampled.length < 3) continue;

        rings.push({ z, points: sampled });
      }

      // Always enforce terminal cap slices slightly below/above the model.
      // Without these explicit terminal rings, caps can end up closing on the
      // nearest hit-slice and appear clipped at the top/bottom.
      if (rings.length > 0) {
        const firstPoints = cloneRingPoints(rings[0].points);
        const lastPoints = cloneRingPoints(rings[rings.length - 1].points);

        if (Math.abs(rings[0].z - startZ) > 1e-4) {
          rings.unshift({ z: startZ, points: firstPoints });
        }

        if (Math.abs(rings[rings.length - 1].z - endZ) > 1e-4) {
          rings.push({ z: endZ, points: lastPoints });
        }
      }
    } else {
      // Fallback to simple prism from transformed bounds.
      const profile = [
        new THREE.Vector2(minX, minY),
        new THREE.Vector2(maxX, minY),
        new THREE.Vector2(maxX, maxY),
        new THREE.Vector2(minX, maxY),
      ];
      const expanded = offsetPolygonOutward(profile, margin);
      const sampled = resampleClosedPolygon(expanded, RESAMPLED_RING_POINTS);
      if (sampled.length >= 3) {
        rings.push({ z: minZ - zPadding, points: sampled });
        rings.push({ z: maxZ + zPadding, points: sampled.map((p) => p.clone()) });
      }
    }

    return buildSliceMeshGeometry(rings);
  }, [enabled, modelGeometry, modelTransform, raft.footprintBorderMargin]);

  React.useEffect(() => {
    return () => {
      satMeshGeometry?.dispose();
    };
  }, [satMeshGeometry]);

  if (!enabled || !satMeshGeometry) return null;

  return (
    <mesh geometry={satMeshGeometry} raycast={() => null} renderOrder={7}>
      <meshStandardMaterial
        color="#baf72e"
        wireframe={renderMode === 'wireframe'}
        transparent={renderMode === 'shaded'}
        opacity={renderMode === 'wireframe' ? 0.95 : 0.22}
        side={THREE.DoubleSide}
        roughness={0.5}
        metalness={0.03}
        depthWrite={renderMode === 'wireframe'}
      />
    </mesh>
  );
}
