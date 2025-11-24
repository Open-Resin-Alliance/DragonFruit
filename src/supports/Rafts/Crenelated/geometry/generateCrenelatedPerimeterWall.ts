import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

function computePerimeter(points: THREE.Vector2[]): { lengths: number[]; total: number } {
  const n = points.length;
  const lengths: number[] = new Array(n).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const len = a.distanceTo(b);
    lengths[i] = len;
    total += len;
  }
  return { lengths, total };
}

function resampleUniform(points: THREE.Vector2[], step: number): THREE.Vector2[] {
  // Uniform resampling along polygon perimeter (closed)
  const { lengths, total } = computePerimeter(points);
  if (total === 0) return points.map(p => p.clone());
  const samples: THREE.Vector2[] = [];
  const targetCount = Math.max(8, Math.ceil(total / Math.max(0.25, step))); // 0.25mm min granularity
  const n = points.length;

  let acc = 0;
  let segIdx = 0;
  let segT = 0; // 0..1 within current segment
  samples.push(points[0].clone());
  for (let s = 1; s < targetCount; s++) {
    const dist = (s * total) / targetCount;
    while (acc + lengths[segIdx] < dist && segIdx < n * 2) {
      acc += lengths[segIdx];
      segIdx = (segIdx + 1) % n;
    }
    const remain = dist - acc;
    const t = lengths[segIdx] === 0 ? 0 : remain / lengths[segIdx];
    const a = points[segIdx];
    const b = points[(segIdx + 1) % n];
    samples.push(new THREE.Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }
  return samples;
}

/**
 * Create a crenelated perimeter wall by building side quads only on kept spans
 * per spacing (mm) and gap width (mm). The wall is open at gaps across its
 * full thickness and height.
 */
export function generateCrenelatedPerimeterWall(
  topProfile: FootprintProfile,
  settings: Pick<RaftSettings, 'wallThickness' | 'wallHeight' | 'crenulationGapWidth' | 'crenulationSpacing' | 'thickness'>
): THREE.Mesh {
  const wallHeight = Math.max(0, settings.wallHeight);
  const wallThickness = Math.max(0, settings.wallThickness);
  if (!topProfile || topProfile.length < 3 || wallHeight === 0 || wallThickness === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Profiles
  const outerTop = topProfile;
  // Place wall on top of base thickness
  const zOffset = Math.max(0, settings.thickness);
  const outerBottomZ = zOffset;
  const outerTopZ = zOffset + wallHeight;

  // Inner profile by inward inset
  const innerProfileRaw = insetConvexPolygon(outerTop, wallThickness);

  // Resample to uniform spacing to allow perpendicular gap boundaries on straight runs
  const step = Math.max(0.25, Math.min(settings.crenulationGapWidth, settings.crenulationSpacing) / 4);
  const outer = resampleUniform(outerTop, step);
  const inner = resampleUniform(innerProfileRaw, step);
  const n = Math.min(outer.length, inner.length);

  // Perimeter measurements along outer
  const { total } = computePerimeter(outer);
  const spacing = Math.max(0.5, settings.crenulationSpacing);
  const gap = Math.max(0.1, Math.min(spacing, settings.crenulationGapWidth));

  // Precompute cumulative distances at each vertex along outer
  const cum: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + outer[i - 1].distanceTo(outer[i]);
  // close segment distance for wrap
  const wrapDist = outer[n - 1].distanceTo(outer[0]);

  // Detect straight edges: low curvature along local neighborhood
  const isStraight: boolean[] = new Array(n).fill(false);
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const maxAngleDeltaDeg = 1.0; // tolerance for straightness
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    const iNext = (i + 1) % n;
    const v1 = new THREE.Vector2().subVectors(outer[i], outer[iPrev]).normalize();
    const v2 = new THREE.Vector2().subVectors(outer[iNext], outer[i]).normalize();
    const dot = THREE.MathUtils.clamp(v1.dot(v2), -1, 1);
    const ang = Math.acos(dot);
    isStraight[i] = deg(ang) <= maxAngleDeltaDeg;
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const pushV = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };

  // Build vertex arrays: 4 rings (outerTop, outerBottom, innerTop, innerBottom)
  const baseIdx = { outerTop: 0, outerBottom: 0, innerTop: 0, innerBottom: 0 };
  for (let i = 0; i < n; i++) {
    const po = outer[i];
    pushV(po.x, po.y, outerTopZ, 0, 0, 1); // approximate normals; recompute later
  }
  baseIdx.outerBottom = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const po = outer[i];
    pushV(po.x, po.y, outerBottomZ, 0, 0, -1);
  }
  baseIdx.innerTop = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const pi = inner[i];
    pushV(pi.x, pi.y, outerTopZ, 0, 0, 1);
  }
  baseIdx.innerBottom = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const pi = inner[i];
    pushV(pi.x, pi.y, outerBottomZ, 0, 0, -1);
  }

  const idxOuterTop = (i: number) => baseIdx.outerTop + i;
  const idxOuterBottom = (i: number) => baseIdx.outerBottom + i;
  const idxInnerTop = (i: number) => baseIdx.innerTop + i;
  const idxInnerBottom = (i: number) => baseIdx.innerBottom + i;

  const shouldInclude = (i: number, midLen: number) => {
    // Only apply crenelation pattern on straight edges; always include on curves
    if (!isStraight[i]) return true;
    const phase = midLen % spacing;
    return !(phase < gap);
  };

  // Build faces only for included spans (ensure outward normals)
  let accLen = 0;
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const segLen = outer[i].distanceTo(outer[iNext]);
    const midLen = accLen + segLen / 2;

    if (shouldInclude(i, midLen)) {
      // Outer side (vertical quad) - outward normals
      indices.push(idxOuterTop(i), idxOuterBottom(iNext), idxOuterTop(iNext));
      indices.push(idxOuterTop(i), idxOuterBottom(i), idxOuterBottom(iNext));
      // Inner side (vertical quad) - reverse winding so normals face inward to cavity
      indices.push(idxInnerTop(i), idxInnerTop(iNext), idxInnerBottom(iNext));
      indices.push(idxInnerTop(i), idxInnerBottom(iNext), idxInnerBottom(i));
      // Top ring (bridge outer->inner)
      indices.push(idxOuterTop(i), idxInnerTop(iNext), idxInnerTop(i));
      indices.push(idxOuterTop(i), idxOuterTop(iNext), idxInnerTop(iNext));
      // Bottom ring (bridge inner->outer) - reversed winding
      indices.push(idxOuterBottom(i), idxInnerBottom(i), idxInnerBottom(iNext));
      indices.push(idxOuterBottom(i), idxInnerBottom(iNext), idxOuterBottom(iNext));
    }

    accLen += segLen;
  }

  // Validate to avoid NaNs
  if (!positions.every((v) => Number.isFinite(v))) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom);
  return mesh;
}
