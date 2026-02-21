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

const BASE_SLICE_COUNT = 24;
const MAX_SLICE_COUNT = 96;
const RESAMPLED_RING_POINTS = 64;
const SLICE_INTERSECTION_EPS_MM = 0.03;
const SLICE_DEDUPE_EPS_MM = 0.02;
const MIN_SLICE_SPACING_MM = 0.28;
const MIN_POINTS_PER_SLICE = 8;

type TriangleSliceProxy = {
  a: number;
  b: number;
  c: number;
  minZ: number;
  maxZ: number;
};

function pushUniquePoint(points: THREE.Vector2[], point: THREE.Vector2, eps: number) {
  const epsSq = eps * eps;
  for (const existing of points) {
    if (existing.distanceToSquared(point) <= epsSq) return;
  }
  points.push(point);
}

function collectTrianglePlaneIntersections2D(
  va: THREE.Vector3,
  vb: THREE.Vector3,
  vc: THREE.Vector3,
  planeZ: number,
  epsilon: number,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];

  const processEdge = (p0: THREE.Vector3, p1: THREE.Vector3) => {
    const d0 = p0.z - planeZ;
    const d1 = p1.z - planeZ;
    const on0 = Math.abs(d0) <= epsilon;
    const on1 = Math.abs(d1) <= epsilon;

    if (on0 && on1) {
      pushUniquePoint(out, new THREE.Vector2(p0.x, p0.y), SLICE_DEDUPE_EPS_MM);
      pushUniquePoint(out, new THREE.Vector2(p1.x, p1.y), SLICE_DEDUPE_EPS_MM);
      return;
    }

    if (on0) {
      pushUniquePoint(out, new THREE.Vector2(p0.x, p0.y), SLICE_DEDUPE_EPS_MM);
      return;
    }

    if (on1) {
      pushUniquePoint(out, new THREE.Vector2(p1.x, p1.y), SLICE_DEDUPE_EPS_MM);
      return;
    }

    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      pushUniquePoint(out, new THREE.Vector2(x, y), SLICE_DEDUPE_EPS_MM);
    }
  };

  processEdge(va, vb);
  processEdge(vb, vc);
  processEdge(vc, va);

  return out;
}

function buildAdaptiveSliceLevels(
  minZ: number,
  maxZ: number,
  worldVertices: THREE.Vector3[],
): number[] {
  const span = Math.max(1e-6, maxZ - minZ);
  const levels = new Set<number>();

  for (let i = 0; i <= BASE_SLICE_COUNT; i++) {
    levels.add(minZ + (i / BASE_SLICE_COUNT) * span);
  }

  const quant = Math.max(MIN_SLICE_SPACING_MM * 0.5, span / (MAX_SLICE_COUNT * 2));
  const vertexStride = Math.max(1, Math.ceil(worldVertices.length / 16000));
  for (let i = 0; i < worldVertices.length; i += vertexStride) {
    const z = THREE.MathUtils.clamp(worldVertices[i].z, minZ, maxZ);
    const snapped = minZ + Math.round((z - minZ) / quant) * quant;
    levels.add(THREE.MathUtils.clamp(snapped, minZ, maxZ));
  }

  let sorted = Array.from(levels).sort((a, b) => a - b);
  if (sorted.length === 0) return [minZ, maxZ];

  // Enforce a minimum spacing to avoid excessive near-duplicate slices.
  const filtered: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - filtered[filtered.length - 1] >= MIN_SLICE_SPACING_MM) {
      filtered.push(sorted[i]);
    }
  }
  if (filtered[filtered.length - 1] < maxZ) filtered.push(maxZ);

  sorted = filtered;

  if (sorted.length <= MAX_SLICE_COUNT) return sorted;

  const decimated: number[] = [];
  for (let i = 0; i < MAX_SLICE_COUNT; i++) {
    const t = i / Math.max(1, MAX_SLICE_COUNT - 1);
    const idx = Math.round(t * (sorted.length - 1));
    decimated.push(sorted[idx]);
  }

  decimated[0] = minZ;
  decimated[decimated.length - 1] = maxZ;
  return decimated;
}

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

function signedArea2D(points: THREE.Vector2[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return 0.5 * area;
}

function rotateRing(points: THREE.Vector2[], offset: number): THREE.Vector2[] {
  const n = points.length;
  if (n === 0) return [];
  const o = ((offset % n) + n) % n;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    out.push(points[(i + o) % n]);
  }
  return out;
}

function alignRingToReference(ring: THREE.Vector2[], reference: THREE.Vector2[]): THREE.Vector2[] {
  if (ring.length !== reference.length || ring.length < 3) return ring;

  const refWinding = Math.sign(signedArea2D(reference));
  const ringWinding = Math.sign(signedArea2D(ring));
  let candidate = ring;

  if (refWinding !== 0 && ringWinding !== 0 && refWinding !== ringWinding) {
    candidate = ring.slice().reverse();
  }

  let bestOffset = 0;
  let bestScore = Infinity;

  for (let offset = 0; offset < candidate.length; offset++) {
    let score = 0;
    for (let i = 0; i < candidate.length; i++) {
      const p = candidate[(i + offset) % candidate.length];
      score += p.distanceToSquared(reference[i]);
    }
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  return rotateRing(candidate, bestOffset);
}

function normalizeRingSequence(rings: SliceRing[]): SliceRing[] {
  if (rings.length === 0) return rings;

  const normalized: SliceRing[] = [{
    z: rings[0].z,
    points: cloneRingPoints(rings[0].points),
  }];

  for (let i = 1; i < rings.length; i++) {
    const prev = normalized[i - 1].points;
    const curr = rings[i].points;
    normalized.push({
      z: rings[i].z,
      points: alignRingToReference(curr, prev),
    });
  }

  return normalized;
}

function ringAreaAbs(points: THREE.Vector2[]): number {
  return Math.abs(signedArea2D(points));
}

function addFeatureEndMarginSlices(rings: SliceRing[]): SliceRing[] {
  if (rings.length < 2) return rings;

  const out: SliceRing[] = [rings[0]];

  for (let i = 0; i < rings.length - 1; i++) {
    const current = rings[i];
    const next = rings[i + 1];
    const dz = next.z - current.z;

    if (dz > 1e-4) {
      const areaCurrent = ringAreaAbs(current.points);
      const areaNext = ringAreaAbs(next.points);
      const shrinkRatio = areaCurrent > 1e-6 ? areaNext / areaCurrent : 1;

      // If a footprint shrinks abruptly between slices, carry the larger footprint
      // forward by ~one extra half-to-full slice to avoid prematurely clipping
      // peaks/shoulders that end between sampled slice levels.
      if (shrinkRatio < 0.8) {
        const bridgeZ = Math.min(next.z - 1e-4, current.z + dz * 0.75);
        if (bridgeZ > current.z + 1e-4) {
          out.push({
            z: bridgeZ,
            points: cloneRingPoints(current.points),
          });
        }
      }
    }

    out.push(next);
  }

  return out;
}

function buildSliceMeshGeometry(rings: SliceRing[], pointCapHeight = 0): THREE.BufferGeometry | null {
  if (rings.length < 2) return null;

  const stitchedRings = normalizeRingSequence(rings);

  const ringSize = stitchedRings[0].points.length;
  if (ringSize < 3) return null;
  if (!stitchedRings.every((ring) => ring.points.length === ringSize)) return null;

  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of stitchedRings) {
    for (const p of ring.points) {
      positions.push(p.x, p.y, ring.z);
    }
  }

  for (let slice = 0; slice < stitchedRings.length - 1; slice++) {
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
  const topBase = (stitchedRings.length - 1) * ringSize;

  const bottomCenter = new THREE.Vector2();
  for (const p of stitchedRings[0].points) bottomCenter.add(p);
  bottomCenter.multiplyScalar(1 / ringSize);
  const bottomCenterIndex = positions.length / 3;
  const bottomCapZ = stitchedRings[0].z - Math.max(0, pointCapHeight);
  positions.push(bottomCenter.x, bottomCenter.y, bottomCapZ);

  for (let i = 0; i < ringSize; i++) {
    const next = (i + 1) % ringSize;
    indices.push(bottomCenterIndex, bottomBase + next, bottomBase + i);
  }

  const topCenter = new THREE.Vector2();
  for (const p of stitchedRings[stitchedRings.length - 1].points) topCenter.add(p);
  topCenter.multiplyScalar(1 / ringSize);
  const topCenterIndex = positions.length / 3;
  const topCapZ = stitchedRings[stitchedRings.length - 1].z + Math.max(0, pointCapHeight);
  positions.push(topCenter.x, topCenter.y, topCapZ);

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

function buildSliceWireframeGeometry(rings: SliceRing[], pointCapHeight = 0): THREE.BufferGeometry | null {
  if (rings.length < 2) return null;

  const stitchedRings = normalizeRingSequence(rings);
  const ringSize = stitchedRings[0].points.length;
  if (ringSize < 3) return null;
  if (!stitchedRings.every((ring) => ring.points.length === ringSize)) return null;

  const positions: number[] = [];
  const pushSegment = (a: THREE.Vector3, b: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };

  // Perimeter segments per ring
  for (const ring of stitchedRings) {
    for (let i = 0; i < ringSize; i++) {
      const next = (i + 1) % ringSize;
      const a = new THREE.Vector3(ring.points[i].x, ring.points[i].y, ring.z);
      const b = new THREE.Vector3(ring.points[next].x, ring.points[next].y, ring.z);
      pushSegment(a, b);
    }
  }

  // Vertical segments between consecutive rings
  for (let slice = 0; slice < stitchedRings.length - 1; slice++) {
    const ra = stitchedRings[slice];
    const rb = stitchedRings[slice + 1];
    for (let i = 0; i < ringSize; i++) {
      const a = new THREE.Vector3(ra.points[i].x, ra.points[i].y, ra.z);
      const b = new THREE.Vector3(rb.points[i].x, rb.points[i].y, rb.z);
      pushSegment(a, b);
    }
  }

  // Terminal cap spokes (point closure visualization)
  const bottomRing = stitchedRings[0];
  const topRing = stitchedRings[stitchedRings.length - 1];

  const bottomCenter = new THREE.Vector2();
  for (const p of bottomRing.points) bottomCenter.add(p);
  bottomCenter.multiplyScalar(1 / ringSize);

  const topCenter = new THREE.Vector2();
  for (const p of topRing.points) topCenter.add(p);
  topCenter.multiplyScalar(1 / ringSize);

  const bottomApex = new THREE.Vector3(bottomCenter.x, bottomCenter.y, bottomRing.z - Math.max(0, pointCapHeight));
  const topApex = new THREE.Vector3(topCenter.x, topCenter.y, topRing.z + Math.max(0, pointCapHeight));

  for (let i = 0; i < ringSize; i++) {
    const b = new THREE.Vector3(bottomRing.points[i].x, bottomRing.points[i].y, bottomRing.z);
    const t = new THREE.Vector3(topRing.points[i].x, topRing.points[i].y, topRing.z);
    pushSegment(b, bottomApex);
    pushSegment(t, topApex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export default function SliceSatBoundingMeshRenderer({
  modelGeometry,
  modelTransform,
  enabled,
  renderMode = 'shaded',
}: SliceSatBoundingMeshRendererProps) {
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);

  const satGeometries = React.useMemo(() => {
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

    const positionAttr = modelGeometry.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indexAttr = modelGeometry.geometry.getIndex();

    const worldVertices: THREE.Vector3[] = new Array(positionAttr.count);
    for (let i = 0; i < positionAttr.count; i++) {
      const v = new THREE.Vector3(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      v.applyMatrix4(transformMatrix);
      worldVertices[i] = v;
    }

    const triangleProxies: TriangleSliceProxy[] = [];
    const pushTriangleProxy = (a: number, b: number, c: number) => {
      const va = worldVertices[a];
      const vb = worldVertices[b];
      const vc = worldVertices[c];
      triangleProxies.push({
        a,
        b,
        c,
        minZ: Math.min(va.z, vb.z, vc.z),
        maxZ: Math.max(va.z, vb.z, vc.z),
      });
    };

    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        pushTriangleProxy(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
      }
    } else {
      for (let i = 0; i < positionAttr.count; i += 3) {
        pushTriangleProxy(i, i + 1, i + 2);
      }
    }

    {
      const sliceLevels = buildAdaptiveSliceLevels(minZ, maxZ, worldVertices);

      for (let sliceIndex = 0; sliceIndex < sliceLevels.length; sliceIndex++) {
        const z = sliceLevels[sliceIndex];
        const prevZ = sliceLevels[Math.max(0, sliceIndex - 1)];
        const nextZ = sliceLevels[Math.min(sliceLevels.length - 1, sliceIndex + 1)];
        const localStep = Math.max(MIN_SLICE_SPACING_MM, 0.5 * (nextZ - prevZ));
        const localEps = Math.max(SLICE_INTERSECTION_EPS_MM, 0.18 * localStep);
        const slicePoints: THREE.Vector2[] = [];

        for (const tri of triangleProxies) {
          if (tri.maxZ < z - localEps || tri.minZ > z + localEps) {
            continue;
          }

          const va = worldVertices[tri.a];
          const vb = worldVertices[tri.b];
          const vc = worldVertices[tri.c];

          const triIntersections = collectTrianglePlaneIntersections2D(
            va,
            vb,
            vc,
            z,
            localEps,
          );

          for (const p of triIntersections) {
            pushUniquePoint(slicePoints, p, SLICE_DEDUPE_EPS_MM);
          }
        }

        // If this exact plane is sparse (common around local peaks), probe nearby
        // planes to preserve neighboring peaks/shoulders.
        if (slicePoints.length < MIN_POINTS_PER_SLICE) {
          const probe = Math.max(localEps * 2, 0.35 * localStep);
          for (const sampleZ of [z - probe, z + probe]) {
            for (const tri of triangleProxies) {
              if (tri.maxZ < sampleZ - localEps || tri.minZ > sampleZ + localEps) continue;

              const va = worldVertices[tri.a];
              const vb = worldVertices[tri.b];
              const vc = worldVertices[tri.c];

              const triIntersections = collectTrianglePlaneIntersections2D(
                va,
                vb,
                vc,
                sampleZ,
                localEps,
              );

              for (const p of triIntersections) {
                pushUniquePoint(slicePoints, p, SLICE_DEDUPE_EPS_MM);
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

    }

    if (rings.length < 2) {
      // Final fallback to simple prism from transformed bounds.
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

    const ringsWithEndMargin = addFeatureEndMarginSlices(rings);

    const finalRings = ringsWithEndMargin;
    const meshGeometry = buildSliceMeshGeometry(finalRings, zPadding);
    if (!meshGeometry) return null;
    const wireGeometry = buildSliceWireframeGeometry(finalRings, zPadding);
    return { meshGeometry, wireGeometry };
  }, [enabled, modelGeometry, modelTransform, raft.footprintBorderMargin]);

  React.useEffect(() => {
    return () => {
      satGeometries?.meshGeometry.dispose();
      satGeometries?.wireGeometry?.dispose();
    };
  }, [satGeometries]);

  if (!enabled || !satGeometries?.meshGeometry) return null;

  if (renderMode === 'wireframe') {
    return (
      <group renderOrder={7}>
        {/* Depth pre-pass: occludes back-side wireframe segments without visible fill. */}
        <mesh geometry={satGeometries.meshGeometry} raycast={() => null} renderOrder={7}>
          <meshBasicMaterial colorWrite={false} depthWrite depthTest side={THREE.DoubleSide} />
        </mesh>
        {satGeometries.wireGeometry && (
          <lineSegments geometry={satGeometries.wireGeometry} raycast={() => null} renderOrder={8}>
            <lineBasicMaterial color="#baf72e" transparent opacity={0.95} depthWrite={false} depthTest />
          </lineSegments>
        )}
      </group>
    );
  }

  return (
    <mesh geometry={satGeometries.meshGeometry} raycast={() => null} renderOrder={7}>
      <meshStandardMaterial
        color="#baf72e"
        transparent
        opacity={0.22}
        side={THREE.DoubleSide}
        roughness={0.5}
        metalness={0.03}
        depthWrite={false}
      />
    </mesh>
  );
}
