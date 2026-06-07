import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import {
  type ROIRegion,
  type BrushType,
  type VoxlROIBoundaryLoop,
  type BrushMetadata,
  type SupportGenerationMetadata,
  type CustomSupportOperation,
  type FailedPlacementCandidate,
  upgradePipeline,
} from './supportPainterTypes';
import { supportPainterStore } from './supportPainterStore';
import { compressRLE } from './voxlCodec';
import {
  getSnapshot as getSupportSnapshot,
  setSnapshot as setSupportSnapshot,
  beginSupportStateBatch,
  endSupportStateBatch,
  addLeaf,
  addKnot,
  addRoot,
  addTrunk,
  addBranch,
  removeTrunk,
} from '@/supports/state';
import { getShaftProfile, getSettings, setSettings, getPresetById } from '@/supports/Settings';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { placeSupportUnified, validateSupportPlacement } from '@/supports/PlacementLogic/UnifiedPlacement';
import { buildLeafData } from '@/supports/SupportTypes/Leaf/leafBuilder';
import { getTrunkSegmentEndpoints } from '@/supports/SupportPrimitives/Knot/knotUtils';
import { type Trunk, type Segment, type Knot, type Branch, type Joint } from '@/supports/types';
import { type ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { encodeSupportSettingsHex } from '@/supports/Settings/supportSettingsCodec';
import { generateUuid } from '@/utils/uuid';
import { getJointDiameter } from '@/supports/constants';
import { resolveConeAxisPolicy } from '@/supports/PlacementLogic/ConeAxisPolicy';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import { buildBranchData } from '@/supports/SupportTypes/Branch/branchBuilder';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';


// ─── Brush Metadata for Toasts ───
// [AGENT_NOTE] Display names used for summary reporting in the toast component.
const BRUSH_DETAILS: Record<BrushType, { label: string }> = {
  MacroFace:      { label: 'MacroFace' },
  TexturedFace:   { label: 'Textured Face' },
  Ridge:          { label: 'Ridge Crease' },
  Point:          { label: 'Point Geodesic' },
  RoughEdge:      { label: 'Rough Edge' },
  SoftRidge:      { label: 'Soft Ridge' },
  Ring:           { label: 'Z-Plane Ring' },
  ManualCircle:   { label: 'Manual Circle' },
  ManualSquare:   { label: 'Manual Square' },
  Marker:         { label: 'Marker Brush' },
  PointPath:      { label: 'Point Path' },
  MinimaIslands:  { label: 'Minima Islands' },
  'Unk Legacy Brush': { label: 'Unk Legacy Brush' },
};

function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  const index = geometry.getIndex();

  if (!index) {
    if (positions instanceof Float32Array) {
      return positions;
    }
    return new Float32Array(positions as unknown as ArrayLike<number>);
  }

  const indexArr = index.array as Uint16Array | Uint32Array;
  const out = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i++) {
    const vi = indexArr[i] * 3;
    const oi = i * 3;
    out[oi] = positions[vi];
    out[oi + 1] = positions[vi + 1];
    out[oi + 2] = positions[vi + 2];
  }
  return out;
}

export interface WeldedTriangle {
  id: number; // Face index
  v0: THREE.Vector3; // World space
  v1: THREE.Vector3; // World space
  v2: THREE.Vector3; // World space
  idx0: number; // Welded index
  idx1: number;
  idx2: number;
  normal: THREE.Vector3; // World space
  centroid: THREE.Vector3; // World space
}

interface BasicSampledPoint {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
}

interface SampledPoint extends BasicSampledPoint {
  regionId: string;
  regionType: BrushType;
  regionTriCount: number;
  stage: 'minima' | 'perimeter' | 'infill' | 'centerline';
  attemptLeafCreation?: boolean;
  leafInterval?: number;
  supportPresetId?: string;
}

// 2D Point-in-Triangle test using Barycentric Coordinates
function pointInTriangle2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): { in: boolean; u: number; v: number; w: number } {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-8) {
    return { in: false, u: 0, v: 0, w: 0 };
  }
  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return {
    in: u >= -1e-5 && v >= -1e-5 && (u + v) <= 1 + 1e-5,
    u,
    v,
    w: 1 - u - v,
  };
}

function samplePolylineWithNormals(
  indices: number[],
  spacing: number,
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>,
  zDensityParams?: {
    minimaZ: number;
    maximaZ: number;
    op: CustomSupportOperation;
    activeTrunkDiameter: number;
  }
): BasicSampledPoint[] {
  if (indices.length < 2) return [];

  const samples: BasicSampledPoint[] = [];

  // Always add first point
  const firstIdx = indices[0];
  samples.push({
    pos: uniqueVertices[firstIdx].clone(),
    normal: (vertexNormals.get(firstIdx) || new THREE.Vector3(0, 0, 1)).clone(),
  });

  let accumulatedDist = 0;
  for (let i = 0; i < indices.length - 1; i++) {
    const idx0 = indices[i];
    const idx1 = indices[i + 1];
    const p0 = uniqueVertices[idx0];
    const p1 = uniqueVertices[idx1];
    const n0 = vertexNormals.get(idx0) || new THREE.Vector3(0, 0, 1);
    const n1 = vertexNormals.get(idx1) || new THREE.Vector3(0, 0, 1);

    const segDir = new THREE.Vector3().subVectors(p1, p0);
    const segLen = segDir.length();
    if (segLen === 0) continue;
    segDir.normalize();

    let tSeg = 0;
    while (true) {
      const currentPos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const currentSpacing = zDensityParams
        ? calculateZHeightDensitySpacing(currentPos.z, zDensityParams.minimaZ, zDensityParams.maximaZ, zDensityParams.op, zDensityParams.activeTrunkDiameter)
        : spacing;

      if (accumulatedDist + (segLen - tSeg * segLen) >= currentSpacing) {
        const needed = currentSpacing - accumulatedDist;
        tSeg += needed / segLen;
        const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
        const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
        samples.push({ pos, normal });
        accumulatedDist = 0;
      } else {
        break;
      }
    }
    accumulatedDist += segLen * (1 - tSeg);
  }

  return samples;
}

function getSegmentLength(indices: number[], uniqueVertices: THREE.Vector3[]): number {
  let len = 0;
  for (let i = 0; i < indices.length - 1; i++) {
    len += uniqueVertices[indices[i]].distanceTo(uniqueVertices[indices[i + 1]]);
  }
  return len;
}

function sampleSegmentEvenly(
  indices: number[],
  targetSpacing: number,
  NPrime: number,
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>
): BasicSampledPoint[] {
  const samples: BasicSampledPoint[] = [];
  if (indices.length < 2) return [];

  // Always emit the first point of the segment
  const startIdx = indices[0];
  samples.push({
    pos: uniqueVertices[startIdx].clone(),
    normal: (vertexNormals.get(startIdx) || new THREE.Vector3(0, 0, 1)).clone(),
  });

  let accumulatedDist = 0;
  let count = 1;

  for (let i = 0; i < indices.length - 1; i++) {
    const idx0 = indices[i];
    const idx1 = indices[i + 1];
    const p0 = uniqueVertices[idx0];
    const p1 = uniqueVertices[idx1];
    const n0 = vertexNormals.get(idx0) || new THREE.Vector3(0, 0, 1);
    const n1 = vertexNormals.get(idx1) || new THREE.Vector3(0, 0, 1);

    const segDir = new THREE.Vector3().subVectors(p1, p0);
    const segLen = segDir.length();
    if (segLen === 0) continue;
    segDir.normalize();

    let tSeg = 0;
    while (count < NPrime && accumulatedDist + (segLen - tSeg * segLen) >= targetSpacing) {
      const needed = targetSpacing - accumulatedDist;
      tSeg += needed / segLen;
      const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
      samples.push({ pos, normal });
      count++;
      accumulatedDist = 0;
    }
    accumulatedDist += segLen * (1 - tSeg);
  }

  return samples;
}

export function sampleSequencePolyline(
  indices: number[],
  sequence: number[],
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>
): BasicSampledPoint[] {
  if (indices.length < 2) return [];

  const samples: BasicSampledPoint[] = [];

  // Always add first point
  const firstIdx = indices[0];
  samples.push({
    pos: uniqueVertices[firstIdx].clone(),
    normal: (vertexNormals.get(firstIdx) || new THREE.Vector3(0, 0, 1)).clone(),
  });

  let seqIdx = 0;
  let neededSpacing = sequence[0];
  let accumulatedDist = 0;

  for (let i = 0; i < indices.length - 1; i++) {
    const idx0 = indices[i];
    const idx1 = indices[i + 1];
    const p0 = uniqueVertices[idx0];
    const p1 = uniqueVertices[idx1];
    const n0 = vertexNormals.get(idx0) || new THREE.Vector3(0, 0, 1);
    const n1 = vertexNormals.get(idx1) || new THREE.Vector3(0, 0, 1);

    const segDir = new THREE.Vector3().subVectors(p1, p0);
    const segLen = segDir.length();
    if (segLen === 0) continue;
    segDir.normalize();

    let tSeg = 0;
    while (accumulatedDist + (segLen - tSeg * segLen) >= neededSpacing) {
      const needed = neededSpacing - accumulatedDist;
      tSeg += needed / segLen;
      const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
      samples.push({ pos, normal });
      
      seqIdx++;
      neededSpacing = sequence[seqIdx] !== undefined ? sequence[seqIdx] : sequence[sequence.length - 1];
      accumulatedDist = 0;
    }
    accumulatedDist += segLen * (1 - tSeg);
  }

  return samples;
}

function resampleLoopUniformly(
  vertices: THREE.Vector3[],
  normals: THREE.Vector3[],
  stepSizeMm: number
): { vertices: THREE.Vector3[]; normals: THREE.Vector3[] } {
  if (vertices.length < 2) return { vertices: [...vertices], normals: [...normals] };

  const resampledVertices: THREE.Vector3[] = [vertices[0].clone()];
  const resampledNormals: THREE.Vector3[] = [normals[0].clone()];

  let currentPt = vertices[0].clone();
  let currentNormal = normals[0].clone();
  let nextIdx = 1;

  while (nextIdx < vertices.length) {
    const nextPt = vertices[nextIdx];
    const nextNormal = normals[nextIdx];
    const d = currentPt.distanceTo(nextPt);

    if (d >= stepSizeMm) {
      const t = stepSizeMm / d;
      const interpPt = new THREE.Vector3().lerpVectors(currentPt, nextPt, t);
      const interpNormal = new THREE.Vector3().lerpVectors(currentNormal, nextNormal, t).normalize();

      resampledVertices.push(interpPt);
      resampledNormals.push(interpNormal);

      currentPt.copy(interpPt);
      currentNormal.copy(interpNormal);
    } else {
      currentPt.copy(nextPt);
      currentNormal.copy(nextNormal);
      nextIdx++;
    }
  }

  // Ensure closed loop has the last point matching the first
  if (resampledVertices.length > 1 && !resampledVertices[resampledVertices.length - 1].equals(resampledVertices[0])) {
    if (resampledVertices[resampledVertices.length - 1].distanceTo(resampledVertices[0]) < stepSizeMm * 0.5) {
      resampledVertices[resampledVertices.length - 1].copy(resampledVertices[0]);
      resampledNormals[resampledNormals.length - 1].copy(resampledNormals[0]);
    } else {
      resampledVertices.push(resampledVertices[0].clone());
      resampledNormals.push(resampledNormals[0].clone());
    }
  }

  return { vertices: resampledVertices, normals: resampledNormals };
}

export function insetBoundaryLoop(
  vertices3D: THREE.Vector3[],
  planeNormal: THREE.Vector3,
  planeCentroid: THREE.Vector3,
  insetDistanceMm: number,
  vertexNormalsList?: THREE.Vector3[]
): THREE.Vector3[] {
  if (insetDistanceMm <= 0.001) return [...vertices3D];

  // If vertex normals list is provided, calculate local 3D inward tangent offsets to guarantee perfect 3D symmetry
  if (vertexNormalsList && vertexNormalsList.length === vertices3D.length) {
    const len = vertices3D.length;
    const insetLoop: THREE.Vector3[] = [];
    
    const centroid = new THREE.Vector3();
    for (const p of vertices3D) centroid.add(p);
    centroid.divideScalar(len);

    for (let i = 0; i < len; i++) {
      const pi = vertices3D[i];
      const ni = vertexNormalsList[i];
      
      const prev = vertices3D[(i - 1 + len) % len];
      const next = vertices3D[(i + 1) % len];
      
      const tVec = new THREE.Vector3().subVectors(next, prev);
      if (tVec.lengthSq() < 1e-8) {
        tVec.set(1, 0, 0);
      } else {
        tVec.normalize();
      }
      
      // Perpendicular to boundary tangent and local surface normal
      const inwardTangent = new THREE.Vector3().crossVectors(tVec, ni).normalize();
      
      // Orient inward tangent towards the loop centroid
      const toCentroid = new THREE.Vector3().subVectors(centroid, pi);
      if (inwardTangent.dot(toCentroid) < 0) {
        inwardTangent.negate();
      }
      
      const offsetPt = pi.clone().addScaledVector(inwardTangent, insetDistanceMm);
      insetLoop.push(offsetPt);
    }
    return insetLoop;
  }

  // Fallback to 2D flat plane tangent projection offset using Clipper.js
  const tangentU = new THREE.Vector3(1, 0, 0).cross(planeNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(planeNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(planeNormal, tangentU).normalize();

  const SCALE = 100000;
  const path = vertices3D.map(p => {
    const rel = new THREE.Vector3().subVectors(p, planeCentroid);
    return {
      X: Math.round(rel.dot(tangentU) * SCALE),
      Y: Math.round(rel.dot(tangentV) * SCALE)
    };
  });

  const co = new ClipperLib.ClipperOffset();
  co.AddPaths([path], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  
  const solution: { X: number; Y: number }[][] = [];
  co.Execute(solution, -insetDistanceMm * SCALE);

  if (solution.length === 0 || solution[0].length === 0) {
    return [];
  }

  const insetLoop3D = solution[0].map(pt => {
    const u = pt.X / SCALE;
    const v = pt.Y / SCALE;
    return new THREE.Vector3()
      .copy(planeCentroid)
      .addScaledVector(tangentU, u)
      .addScaledVector(tangentV, v);
  });

  return insetLoop3D;
}

export function filterInsetLoopByWrapFraction(
  insetLoop: THREE.Vector3[],
  wrapFraction: number
): THREE.Vector3[] {
  if (insetLoop.length < 3 || wrapFraction >= 0.999) return insetLoop;

  let minIdx = 0;
  let minZ = insetLoop[0].z;
  for (let i = 1; i < insetLoop.length; i++) {
    if (insetLoop[i].z < minZ) {
      minZ = insetLoop[i].z;
      minIdx = i;
    }
  }

  const reordered = [...insetLoop.slice(minIdx), ...insetLoop.slice(0, minIdx)];
  reordered.push(reordered[0]);

  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i < reordered.length - 1; i++) {
    const len = reordered[i].distanceTo(reordered[i + 1]);
    segmentLengths.push(len);
    totalLength += len;
  }

  const maxAllowedDistance = totalLength * wrapFraction;
  const filteredLoop: THREE.Vector3[] = [reordered[0]];

  let accumulatedDist = 0;
  for (let i = 0; i < reordered.length - 1; i++) {
    accumulatedDist += segmentLengths[i];
    if (accumulatedDist <= maxAllowedDistance) {
      filteredLoop.push(reordered[i + 1]);
    } else {
      break;
    }
  }

  return filteredLoop;
}

export function calculateZHeightDensitySpacing(
  pointZ: number,
  minimaZ: number,
  maximaZ: number,
  op: CustomSupportOperation,
  activeTrunkDiameter: number
): number {
  if (!op.enableZHeightDensity) return op.spacing.baseSpacingMm;

  const zRel = pointZ - minimaZ;
  const zSpanROI = maximaZ - minimaZ;

  // Convert Z-offset percentages (0-100%) to float fractions (0.0 to 1.0)
  const fStart = Math.max(0.0, Math.min(1.0, (op.minimaStartInterval ?? 0) / 100.0));
  const fEnd = (op.minimaEndInterval === 'auto' || op.minimaEndInterval === undefined)
    ? 1.0
    : Math.max(0.0, Math.min(1.0, (op.minimaEndInterval as number) / 100.0));

  const zStart = fStart * zSpanROI;
  const zEnd = fEnd * zSpanROI;

  const sStart = op.spacing.baseSpacingMm;
  const sEnd = op.endSpacingMm ?? (activeTrunkDiameter * 4.0);

  if (zEnd <= zStart) {
    return sStart;
  }

  if (zRel <= zStart) {
    return sStart;
  }

  if (zRel >= zEnd) {
    return sEnd;
  }

  const t = Math.max(0.0, Math.min(1.0, (zRel - zStart) / (zEnd - zStart)));
  let curveVal = t;

  if (op.zFactorCurve === 'sigmoid') {
    curveVal = 3 * t * t - 2 * t * t * t;
  } else if (op.zFactorCurve === 'parabolic') {
    curveVal = t * t;
  }

  // Direct, smooth interpolation between Starting Spacing and Ending Spacing
  return sStart + curveVal * (sEnd - sStart);
}

export function samplePoissonDiscWarped(
  region: ROIRegion,
  minZ: number,
  maxZ: number,
  op: CustomSupportOperation,
  triangles: WeldedTriangle[],
  opTrunkWidth: number
): BasicSampledPoint[] {
  const baseSpacing = Math.max(0.25, op.spacing.baseSpacingMm);
  const r = baseSpacing; // uniform radius in warped space

  // 1. Calculate the 2D centroid/center of the ROI to prevent global coordinate shift during warping
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const triId of region.triangleIds) {
    const tri = triangles[triId];
    if (!tri) continue;
    sumX += tri.v0.x + tri.v1.x + tri.v2.x;
    sumY += tri.v0.y + tri.v1.y + tri.v2.y;
    count += 3;
  }
  const centerX = count > 0 ? sumX / count : 0;
  const centerY = count > 0 ? sumY / count : 0;

  const warpedTriangles: {
    id: number;
    v0: THREE.Vector2; // warped
    v1: THREE.Vector2; // warped
    v2: THREE.Vector2; // warped
    tri: WeldedTriangle;
  }[] = [];

  const minWarped = new THREE.Vector2(Infinity, Infinity);
  const maxWarped = new THREE.Vector2(-Infinity, -Infinity);

  const getWarpScale = (z: number): number => {
    if (!op.enableZHeightDensity) return 1.0;
    const s = calculateZHeightDensitySpacing(z, minZ, maxZ, op, opTrunkWidth);
    return baseSpacing / Math.max(0.1, s);
  };

  for (const triId of region.triangleIds) {
    const tri = triangles[triId];
    if (!tri) continue;

    const w0 = getWarpScale(tri.v0.z);
    const w1 = getWarpScale(tri.v1.z);
    const w2 = getWarpScale(tri.v2.z);

    // Warp coordinates relative to the ROI's 2D center
    const pv0 = new THREE.Vector2((tri.v0.x - centerX) * w0 + centerX, (tri.v0.y - centerY) * w0 + centerY);
    const pv1 = new THREE.Vector2((tri.v1.x - centerX) * w1 + centerX, (tri.v1.y - centerY) * w1 + centerY);
    const pv2 = new THREE.Vector2((tri.v2.x - centerX) * w2 + centerX, (tri.v2.y - centerY) * w2 + centerY);

    warpedTriangles.push({
      id: triId,
      v0: pv0,
      v1: pv1,
      v2: pv2,
      tri
    });

    for (const pv of [pv0, pv1, pv2]) {
      minWarped.x = Math.min(minWarped.x, pv.x);
      minWarped.y = Math.min(minWarped.y, pv.y);
      maxWarped.x = Math.max(maxWarped.x, pv.x);
      maxWarped.y = Math.max(maxWarped.y, pv.y);
    }
  }

  if (warpedTriangles.length === 0) return [];

  // 2D Spatial Grid of Triangles in warped space
  const binSize = Math.max(2.0, 3.0 * r);
  const cols = Math.ceil((maxWarped.x - minWarped.x) / binSize) || 1;
  const rows = Math.ceil((maxWarped.y - minWarped.y) / binSize) || 1;
  const triGrid: number[][][] = Array.from({ length: cols }, () =>
    Array.from({ length: rows }, () => [])
  );

  const getGridIndices = (pv: THREE.Vector2) => {
    const cx = Math.max(0, Math.min(cols - 1, Math.floor((pv.x - minWarped.x) / binSize)));
    const cy = Math.max(0, Math.min(rows - 1, Math.floor((pv.y - minWarped.y) / binSize)));
    return { cx, cy };
  };

  for (let i = 0; i < warpedTriangles.length; i++) {
    const wt = warpedTriangles[i];
    const minX = Math.min(wt.v0.x, wt.v1.x, wt.v2.x);
    const maxX = Math.max(wt.v0.x, wt.v1.x, wt.v2.x);
    const minY = Math.min(wt.v0.y, wt.v1.y, wt.v2.y);
    const maxY = Math.max(wt.v0.y, wt.v1.y, wt.v2.y);

    const minIdx = getGridIndices(new THREE.Vector2(minX, minY));
    const maxIdx = getGridIndices(new THREE.Vector2(maxX, maxY));

    for (let cx = minIdx.cx; cx <= maxIdx.cx; cx++) {
      for (let cy = minIdx.cy; cy <= maxIdx.cy; cy++) {
        triGrid[cx][cy].push(i);
      }
    }
  }

  const testPointInDomain = (px: number, py: number) => {
    const { cx, cy } = getGridIndices(new THREE.Vector2(px, py));
    const bIndices = triGrid[cx][cy];

    let bestZ = -Infinity;
    let bestResult: {
      wt: typeof warpedTriangles[0];
      u: number;
      v: number;
      w: number;
    } | null = null;

    for (const idx of bIndices) {
      const wt = warpedTriangles[idx];
      const res = pointInTriangle2D(px, py, wt.v0.x, wt.v0.y, wt.v1.x, wt.v1.y, wt.v2.x, wt.v2.y);
      if (res.in) {
        const z = wt.tri.v0.z * res.w + wt.tri.v1.z * res.v + wt.tri.v2.z * res.u;
        if (z > bestZ) {
          bestZ = z;
          bestResult = { wt, u: res.u, v: res.v, w: res.w };
        }
      }
    }
    return bestResult;
  };

  // Bridson's Poisson Disc Sampler in 2D warped space
  const cellSize = r / Math.sqrt(2);
  const pCols = Math.ceil((maxWarped.x - minWarped.x) / cellSize) || 1;
  const pRows = Math.ceil((maxWarped.y - minWarped.y) / cellSize) || 1;
  const pGrid: (THREE.Vector2 | null)[][] = Array.from({ length: pCols }, () =>
    Array.from({ length: pRows }, () => null)
  );

  const getPGridIndices = (pv: THREE.Vector2) => {
    const cx = Math.max(0, Math.min(pCols - 1, Math.floor((pv.x - minWarped.x) / cellSize)));
    const cy = Math.max(0, Math.min(pRows - 1, Math.floor((pv.y - minWarped.y) / cellSize)));
    return { cx, cy };
  };

  const sampledWarpedPoints: {
    pos: THREE.Vector2;
    wt: typeof warpedTriangles[0];
    u: number;
    v: number;
    w: number;
  }[] = [];
  const unwarpedPoints: BasicSampledPoint[] = [];
  const activeList: number[] = [];

  let seedPoint: THREE.Vector2 | null = null;
  let seedWt: typeof warpedTriangles[0] | null = null;
  let seedU = 0, seedV = 0, seedW = 0;

  for (const wt of warpedTriangles) {
    const cx = (wt.v0.x + wt.v1.x + wt.v2.x) / 3;
    const cy = (wt.v0.y + wt.v1.y + wt.v2.y) / 3;
    const domainTest = testPointInDomain(cx, cy);
    if (domainTest) {
      seedPoint = new THREE.Vector2(cx, cy);
      seedWt = domainTest.wt;
      seedU = domainTest.u;
      seedV = domainTest.v;
      seedW = domainTest.w;
      break;
    }
  }

  if (!seedPoint && warpedTriangles.length > 0) {
    const wt = warpedTriangles[0];
    const cx = wt.v0.x + 1e-4 * (wt.v1.x - wt.v0.x);
    const cy = wt.v0.y + 1e-4 * (wt.v1.y - wt.v0.y);
    const domainTest = testPointInDomain(cx, cy);
    if (domainTest) {
      seedPoint = new THREE.Vector2(cx, cy);
      seedWt = domainTest.wt;
      seedU = domainTest.u;
      seedV = domainTest.v;
      seedW = domainTest.w;
    }
  }

  if (seedPoint && seedWt) {
    sampledWarpedPoints.push({ pos: seedPoint, wt: seedWt, u: seedU, v: seedV, w: seedW });

    const tri = seedWt.tri;
    const px = tri.v0.x * seedW + tri.v1.x * seedV + tri.v2.x * seedU;
    const py = tri.v0.y * seedW + tri.v1.y * seedV + tri.v2.y * seedU;
    const pz = tri.v0.z * seedW + tri.v1.z * seedV + tri.v2.z * seedU;
    unwarpedPoints.push({
      pos: new THREE.Vector3(px, py, pz),
      normal: tri.normal.clone(),
    });

    const { cx, cy } = getPGridIndices(seedPoint);
    pGrid[cx][cy] = seedPoint;
    activeList.push(0);
  }

  const k = 30;

  while (activeList.length > 0) {
    const randIdx = Math.floor(Math.random() * activeList.length);
    const activeIdx = activeList[randIdx];
    const activePt = sampledWarpedPoints[activeIdx];

    let found = false;
    for (let attempt = 0; attempt < k; attempt++) {
      const angle = Math.random() * 2 * Math.PI;
      const radius = r + Math.random() * r;
      const candidateX = activePt.pos.x + radius * Math.cos(angle);
      const candidateY = activePt.pos.y + radius * Math.sin(angle);

      const domainTest = testPointInDomain(candidateX, candidateY);
      if (!domainTest) continue;

      const candidatePos = new THREE.Vector2(candidateX, candidateY);

      const { cx, cy } = getPGridIndices(candidatePos);
      let tooCloseWarped = false;

      for (let dx = -2; dx <= 2 && !tooCloseWarped; dx++) {
        for (let dy = -2; dy <= 2 && !tooCloseWarped; dy++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < pCols && ny >= 0 && ny < pRows) {
            const neighbor = pGrid[nx][ny];
            if (neighbor && neighbor.distanceTo(candidatePos) < r) {
              tooCloseWarped = true;
            }
          }
        }
      }

      if (tooCloseWarped) continue;

      const tri = domainTest.wt.tri;
      const px = tri.v0.x * domainTest.w + tri.v1.x * domainTest.v + tri.v2.x * domainTest.u;
      const py = tri.v0.y * domainTest.w + tri.v1.y * domainTest.v + tri.v2.y * domainTest.u;
      const pz = tri.v0.z * domainTest.w + tri.v1.z * domainTest.v + tri.v2.z * domainTest.u;
      const candidate3D = new THREE.Vector3(px, py, pz);

      const minAllowed = calculateZHeightDensitySpacing(pz, minZ, maxZ, op as any, opTrunkWidth);
      let tooClosePhysical = false;

      for (const accepted of unwarpedPoints) {
        if (candidate3D.distanceTo(accepted.pos) < minAllowed) {
          tooClosePhysical = true;
          break;
        }
      }

      if (!tooClosePhysical) {
        const newIdx = sampledWarpedPoints.length;
        sampledWarpedPoints.push({
          pos: candidatePos,
          wt: domainTest.wt,
          u: domainTest.u,
          v: domainTest.v,
          w: domainTest.w
        });
        unwarpedPoints.push({
          pos: candidate3D,
          normal: tri.normal.clone(),
        });
        pGrid[cx][cy] = candidatePos;
        activeList.push(newIdx);
        found = true;
        break;
      }
    }

    if (!found) {
      activeList.splice(randIdx, 1);
    }
  }

  return unwarpedPoints;
}

export function solvePerimeterWithInflections(
  indices: number[],
  baseSpacing: number,
  solverMode: 'standard' | 'closest' | 'add' | 'remove',
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>,
  zDensityParams?: {
    minimaZ: number;
    maximaZ: number;
    op: CustomSupportOperation;
    activeTrunkDiameter: number;
  }
): BasicSampledPoint[] {
  if (indices.length < 2) return [];

  // A. Resample the loop uniformly at 1.0mm steps to make it resolution-independent and filter false inflections
  const rawVerts = indices.map(idx => uniqueVertices[idx]);
  const rawNorms = indices.map(idx => vertexNormals.get(idx) || new THREE.Vector3(0, 0, 1));
  
  const { vertices: resampledVertices, normals: resampledNormals } = resampleLoopUniformly(
    rawVerts,
    rawNorms,
    1.0
  );

  const mockIndices = Array.from({ length: resampledVertices.length }, (_, i) => i);
  const mockVertexNormals = new Map<number, THREE.Vector3>();
  resampledNormals.forEach((n, i) => mockVertexNormals.set(i, n));

  // B. Project boundary loop coordinates onto horizontal XY plane
  const q = mockIndices.map(idx => new THREE.Vector2(resampledVertices[idx].x, resampledVertices[idx].y));

  // C. Run q through a running 1D Gaussian kernel to suppress high-frequency noise
  const qSmoothed: THREE.Vector2[] = [];
  const w = 2; // window span
  const sigma = 1.0;
  const weights = [-2, -1, 0, 1, 2].map(j => Math.exp(-(j * j) / (2 * sigma * sigma)));
  const sumWeights = weights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < q.length; i++) {
    let sx = 0, sy = 0;
    for (let j = -w; j <= w; j++) {
      const idx = (i + j + q.length) % q.length;
      sx += q[idx].x * weights[j + w];
      sy += q[idx].y * weights[j + w];
    }
    qSmoothed.push(new THREE.Vector2(sx / sumWeights, sy / sumWeights));
  }

  // D. Calculate 2D signed curvature angles between adjacent tangents
  const angles: number[] = [];
  for (let i = 0; i < qSmoothed.length; i++) {
    const prev = qSmoothed[(i - 1 + qSmoothed.length) % qSmoothed.length];
    const curr = qSmoothed[i];
    const next = qSmoothed[(i + 1) % qSmoothed.length];

    const diffVec1 = new THREE.Vector2().subVectors(curr, prev);
    const t1 = diffVec1.lengthSq() < 1e-8 ? new THREE.Vector2(1, 0) : diffVec1.normalize();
    
    const diffVec2 = new THREE.Vector2().subVectors(next, curr);
    const t2 = diffVec2.lengthSq() < 1e-8 ? new THREE.Vector2(1, 0) : diffVec2.normalize();

    let diff = Math.atan2(t2.y, t2.x) - Math.atan2(t1.y, t1.x);
    if (diff < -Math.PI) diff += 2 * Math.PI;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    angles.push(diff);
  }

  // E. Find inflection points where curvature signs change
  const inflections: number[] = [0]; // Always anchor at starting vertical minima
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] * angles[i - 1] < 0 && Math.abs(angles[i] - angles[i - 1]) > 0.02) {
      inflections.push(i);
    }
  }
  // Make sure we include the end of the loop
  if (inflections[inflections.length - 1] !== mockIndices.length - 1) {
    inflections.push(mockIndices.length - 1);
  }

  // F. Solve even spacing segment-by-segment
  const samples: BasicSampledPoint[] = [];
  for (let s = 0; s < inflections.length - 1; s++) {
    const startIdx = inflections[s];
    const endIdx = inflections[s + 1];

    const segIndices = mockIndices.slice(startIdx, endIdx + 1);
    const L = getSegmentLength(segIndices, resampledVertices);
    if (L < 0.1) continue;

    // Apply Z-Height Spacing Density Solver if enabled
    const startPt = resampledVertices[segIndices[0]];
    const endPt = resampledVertices[segIndices[segIndices.length - 1]];
    const avgZ = (startPt.z + endPt.z) / 2;
    const scaledSpacing = zDensityParams
      ? calculateZHeightDensitySpacing(avgZ, zDensityParams.minimaZ, zDensityParams.maximaZ, zDensityParams.op, zDensityParams.activeTrunkDiameter)
      : baseSpacing;

    const N = L / scaledSpacing;
    let NPrime = Math.round(N);
    if (solverMode === 'add') NPrime = Math.ceil(N);
    if (solverMode === 'remove') NPrime = Math.floor(N);
    NPrime = Math.max(1, NPrime);

    const targetSpacing = L / NPrime;

    // Linearly distribute NPrime supports evenly inside this segment
    const segSamples = sampleSegmentEvenly(segIndices, targetSpacing, NPrime, resampledVertices, mockVertexNormals);
    
    // Append to samples, skipping duplicate boundary vertices between segments
    if (samples.length > 0 && segSamples.length > 0) {
      samples.pop(); // Remove duplicate overlap endpoint
    }
    samples.push(...segSamples);
  }

  return samples;
}

export function simplifyLoopEuclidean(
  vertexIds: number[],
  uniqueVertices: THREE.Vector3[],
  tolerance: number
): number[] {
  if (vertexIds.length <= 3) return [...vertexIds];

  const decimated: number[] = [];
  decimated.push(vertexIds[0]);

  let lastPos = uniqueVertices[vertexIds[0]];
  const isClosed = vertexIds[0] === vertexIds[vertexIds.length - 1];
  const len = isClosed ? vertexIds.length - 1 : vertexIds.length;

  for (let i = 1; i < len; i++) {
    const pos = uniqueVertices[vertexIds[i]];
    if (lastPos.distanceTo(pos) >= tolerance) {
      decimated.push(vertexIds[i]);
      lastPos = pos;
    }
  }

  if (isClosed) {
    if (decimated.length < 3) {
      return [...vertexIds];
    }
    decimated.push(decimated[0]);
  }

  return decimated;
}

export function applyAlphaShapeToLoops(
  loops: VoxlROIBoundaryLoop[],
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>,
  alpha: number
): VoxlROIBoundaryLoop[] {
  if (loops.length === 0) return [];

  const vertexIndicesSet = new Set<number>();
  for (const loop of loops) {
    for (const vid of loop.vertexIds) {
      vertexIndicesSet.add(vid);
    }
  }
  const vertexIndices = Array.from(vertexIndicesSet);
  if (vertexIndices.length < 3) return loops;

  const avgCentroid = new THREE.Vector3();
  const avgNormal = new THREE.Vector3();
  let validNormCount = 0;

  for (const vid of vertexIndices) {
    avgCentroid.add(uniqueVertices[vid]);
    const vNorm = vertexNormals.get(vid);
    if (vNorm) {
      avgNormal.add(vNorm);
      validNormCount++;
    }
  }
  avgCentroid.divideScalar(vertexIndices.length);

  if (validNormCount > 0) {
    avgNormal.normalize();
  } else {
    avgNormal.set(0, 0, 1);
  }

  const tangentU = new THREE.Vector3(1, 0, 0).cross(avgNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(avgNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(avgNormal, tangentU).normalize();

  const pts2D = vertexIndices.map(vid => {
    const rel = new THREE.Vector3().subVectors(uniqueVertices[vid], avgCentroid);
    return {
      u: rel.dot(tangentU),
      v: rel.dot(tangentV)
    };
  });

  const alphaEdges: [number, number][] = [];
  const alpha2 = alpha * alpha;
  const eps = 1e-5;

  for (let i = 0; i < pts2D.length; i++) {
    const pi = pts2D[i];
    for (let j = i + 1; j < pts2D.length; j++) {
      const pj = pts2D[j];
      const dx = pj.u - pi.u;
      const dy = pj.v - pi.v;
      const distSq = dx * dx + dy * dy;
      const dist = Math.sqrt(distSq);

      if (dist > 2 * alpha) continue;

      const mx = (pi.u + pj.u) / 2;
      const my = (pi.v + pj.v) / 2;

      const hSq = alpha2 - distSq / 4;
      const h = hSq > 0 ? Math.sqrt(hSq) : 0;

      const nx = -dy / dist;
      const ny = dx / dist;

      const c1 = { u: mx + h * nx, v: my + h * ny };
      const c2 = { u: mx - h * nx, v: my - h * ny };

      let c1Empty = true;
      let c2Empty = true;

      for (let k = 0; k < pts2D.length; k++) {
        if (k === i || k === j) continue;
        const pk = pts2D[k];

        if (c1Empty) {
          const d1Sq = (pk.u - c1.u) * (pk.u - c1.u) + (pk.v - c1.v) * (pk.v - c1.v);
          if (d1Sq < alpha2 - eps) {
            c1Empty = false;
          }
        }
        if (c2Empty) {
          const d2Sq = (pk.u - c2.u) * (pk.u - c2.u) + (pk.v - c2.v) * (pk.v - c2.v);
          if (d2Sq < alpha2 - eps) {
            c2Empty = false;
          }
        }
        if (!c1Empty && !c2Empty) break;
      }

      if (c1Empty || c2Empty) {
        alphaEdges.push([i, j]);
      }
    }
  }

  const adjMap = new Map<number, number[]>();
  for (const [u, w] of alphaEdges) {
    if (!adjMap.has(u)) adjMap.set(u, []);
    if (!adjMap.has(w)) adjMap.set(w, []);
    adjMap.get(u)!.push(w);
    adjMap.get(w)!.push(u);
  }

  const visited = new Set<number>();
  const newLoops: VoxlROIBoundaryLoop[] = [];

  for (const startIdx of adjMap.keys()) {
    if (visited.has(startIdx)) continue;

    const path: number[] = [startIdx];
    visited.add(startIdx);

    let current = startIdx;
    let prev = -1;
    let closed = false;

    while (true) {
      const neighbors = adjMap.get(current) || [];
      let nextIdx = -1;
      for (const n of neighbors) {
        if (n === prev) continue;
        if (n === startIdx && path.length > 2) {
          closed = true;
          nextIdx = n;
          break;
        }
        if (!visited.has(n)) {
          nextIdx = n;
          break;
        }
      }

      if (nextIdx !== -1) {
        if (nextIdx === startIdx) {
          path.push(nextIdx);
          break;
        }
        path.push(nextIdx);
        visited.add(nextIdx);
        prev = current;
        current = nextIdx;
      } else {
        break;
      }
    }

    if (closed && path.length > 3) {
      newLoops.push({
        type: 'outer',
        vertexIds: path.map(idx => vertexIndices[idx]),
      });
    }
  }

  if (newLoops.length === 0) {
    return loops;
  }
  return newLoops;
}

function sampleSpineWithNormals(
  points: THREE.Vector3[],
  normals: THREE.Vector3[],
  spacing: number,
  zDensityParams?: {
    minimaZ: number;
    maximaZ: number;
    op: CustomSupportOperation;
    activeTrunkDiameter: number;
  }
): BasicSampledPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    return [{ pos: points[0].clone(), normal: normals[0].clone() }];
  }

  const samples: BasicSampledPoint[] = [];
  // Always add first point
  samples.push({ pos: points[0].clone(), normal: normals[0].clone() });

  let accumulatedDist = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const n0 = normals[i];
    const n1 = normals[i + 1];

    const segDir = new THREE.Vector3().subVectors(p1, p0);
    const segLen = segDir.length();
    if (segLen === 0) continue;
    segDir.normalize();

    let tSeg = 0;
    while (true) {
      const currentPos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const currentSpacing = zDensityParams
        ? calculateZHeightDensitySpacing(currentPos.z, zDensityParams.minimaZ, zDensityParams.maximaZ, zDensityParams.op, zDensityParams.activeTrunkDiameter)
        : spacing;

      if (accumulatedDist + (segLen - tSeg * segLen) >= currentSpacing) {
        const needed = currentSpacing - accumulatedDist;
        tSeg += needed / segLen;
        const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
        const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
        samples.push({ pos, normal });
        accumulatedDist = 0;
      } else {
        break;
      }
    }
    accumulatedDist += segLen * (1 - tSeg);
  }

  return samples;
}

/**
 * High-performance support generator that parses painted regions and outputs physical columns.
 */
export async function generateSupportsFromPainter(
  modelId: string,
  mesh: THREE.Mesh,
  regions: ROIRegion[]
): Promise<void> {
  if (!mesh || !regions || regions.length === 0) return;
  supportPainterStore.clearFailedCandidates();

  // ─── Spacing Override Core Configuration [SPACING_OVERRIDES] ───
  // [AGENT_NOTE] Spacing is fetched from supportPainterStore. If null, falls back to dynamic 4.0 * shaftDiameter.
  const state = supportPainterStore.getSnapshot();
  const trunkWidth = getShaftProfile()?.diameterMm ?? 1.5;
  const defaultSpacing = trunkWidth * 4.0; // center-to-center interval

  const perimeterSpacing = state.perimeterSpacingOverride !== null ? state.perimeterSpacingOverride : defaultSpacing;
  const infillSpacing = state.infillSpacingOverride !== null ? state.infillSpacingOverride : defaultSpacing;
  const minimaSuppressionRadius = defaultSpacing; // Z-minima keeps its default spacing for local stability
  const suppressionSettings = state.suppressionSettings;

  const distance2D = (a: THREE.Vector3, b: THREE.Vector3) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // 1. Capture snapshot before execution for single-stroke history undo
  const beforeState = getSupportSnapshot();
  const beforeRegions = new Map(supportPainterStore.getSnapshot().regions);

  // Ensure matrixWorld is fully up to date
  mesh.updateMatrixWorld(true);

  // 2. Expand geometry and weld coincident vertices to construct topological maps
  const geometry = mesh.geometry;
  const soup = expandGeometryToTriangleSoup(geometry);

  const uniqueVertices: THREE.Vector3[] = [];
  const vertexKeyMap = new Map<string, number>();

  const getWeldedIndex = (x: number, y: number, z: number): number => {
    // Local coordinates transformed to world space
    const localPos = new THREE.Vector3(x, y, z);
    const worldPos = localPos.clone().applyMatrix4(mesh.matrixWorld);

    // Quantize world coordinates to 1e-5 mm tolerance (5 decimal places) for welding
    const key = `${Math.round(worldPos.x * 100000)},${Math.round(worldPos.y * 100000)},${Math.round(worldPos.z * 100000)}`;
    let idx = vertexKeyMap.get(key);
    if (idx === undefined) {
      idx = uniqueVertices.length;
      uniqueVertices.push(worldPos);
      vertexKeyMap.set(key, idx);
    }
    return idx;
  };

  const numTriangles = soup.length / 9;
  const triangles: WeldedTriangle[] = [];

  for (let i = 0; i < numTriangles; i++) {
    // Yield to the event loop every 10,000 triangles to prevent RAF stalls during large model indexing
    if (i > 0 && i % 10000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const x0 = soup[i * 9], y0 = soup[i * 9 + 1], z0 = soup[i * 9 + 2];
    const x1 = soup[i * 9 + 3], y1 = soup[i * 9 + 4], z1 = soup[i * 9 + 5];
    const x2 = soup[i * 9 + 6], y2 = soup[i * 9 + 7], z2 = soup[i * 9 + 8];

    const idx0 = getWeldedIndex(x0, y0, z0);
    const idx1 = getWeldedIndex(x1, y1, z1);
    const idx2 = getWeldedIndex(x2, y2, z2);

    const v0 = uniqueVertices[idx0];
    const v1 = uniqueVertices[idx1];
    const v2 = uniqueVertices[idx2];

    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
    const centroid = new THREE.Vector3(
      (v0.x + v1.x + v2.x) / 3,
      (v0.y + v1.y + v2.y) / 3,
      (v0.z + v1.z + v2.z) / 3
    );

    triangles.push({
      id: i,
      v0, v1, v2,
      idx0, idx1, idx2,
      normal,
      centroid,
    });
  }

  // ─── Raw Unfiltered Candidates Collections ───
  // [AGENT_NOTE] Collected first across all ROIs without immediate suppression.
  const rawMinima: SampledPoint[] = [];
  const rawPerimeter: SampledPoint[] = [];
  const rawInfill: SampledPoint[] = [];
  const rawCenterline: SampledPoint[] = [];

  const regionVertexNormals = new Map<string, Map<number, THREE.Vector3>>();
  const regionBoundaryLoops = new Map<string, VoxlROIBoundaryLoop[]>();
  const regionSpines = new Map<string, { points: THREE.Vector3[]; normals: THREE.Vector3[] }>();
  const regionMinimaPoints = new Map<string, { pos: THREE.Vector3; idx: number }[]>();

  const allRegions = new Map<string, ROIRegion>(regions.map(r => [r.id, r]));

  // A. Precompute topological structures and metadata for each region
  for (const region of regions) {
    const triangleIds = region.triangleIds;
    if (triangleIds.size === 0) continue;

    const regionLoops: VoxlROIBoundaryLoop[] = [];

    // Pre-calculate average vertex normals inside this ROI
    const vertexNormals = new Map<number, THREE.Vector3>();
    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (!tri) continue;

      const idxs = [tri.idx0, tri.idx1, tri.idx2];
      for (const idx of idxs) {
        let norm = vertexNormals.get(idx);
        if (!norm) {
          norm = new THREE.Vector3();
          vertexNormals.set(idx, norm);
        }
        norm.add(tri.normal);
      }
    }
    for (const idx of vertexNormals.keys()) {
      /* ORIGINAL:
      vertexNormals.get(idx)!.normalize();
      */
      const norm = vertexNormals.get(idx)!;
      if (norm.lengthSq() < 1e-8) {
        norm.set(0, 0, 1);
      } else {
        norm.normalize();
      }
    }
    regionVertexNormals.set(region.id, vertexNormals);

    let spineData: { points: THREE.Vector3[]; normals: THREE.Vector3[] } | null = null;

    const isPointPathLine = region.brushType === 'PointPath' && (
      (region.brush?.parameters?.pointPathMode === 'line') ||
      (region.brush === undefined && state.pointPathMode === 'line' && !state.pointPathClosed)
    );

    if (region.brushType === 'MinimaIslands') {
      // MinimaIslands does not need boundary loops or spines
    } else if (region.brushType === 'SoftRidge' || region.brushType === 'Ridge' || isPointPathLine) {
      // 1D Topological Graph Diameter BFS crease/spine solver
      const regionAdj = new Map<number, number[]>();
      const addRegionAdj = (ta: number, tb: number) => {
        let list = regionAdj.get(ta);
        if (!list) { regionAdj.set(ta, list = []); }
        list.push(tb);
      };

      const edgeMap = new Map<string, number[]>();
      for (const triId of triangleIds) {
        const tri = triangles[triId];
        if (!tri) continue;
        const edges = [
          tri.idx0 < tri.idx1 ? `${tri.idx0}|${tri.idx1}` : `${tri.idx1}|${tri.idx0}`,
          tri.idx1 < tri.idx2 ? `${tri.idx1}|${tri.idx2}` : `${tri.idx2}|${tri.idx1}`,
          tri.idx2 < tri.idx0 ? `${tri.idx2}|${tri.idx0}` : `${tri.idx0}|${tri.idx2}`
        ];
        for (const ek of edges) {
          let list = edgeMap.get(ek);
          if (!list) { edgeMap.set(ek, list = []); }
          list.push(triId);
        }
      }

      for (const list of edgeMap.values()) {
        if (list.length === 2) {
          addRegionAdj(list[0], list[1]);
          addRegionAdj(list[1], list[0]);
        }
      }

      // BFS helper to find the topologically furthest node and its parent map
      const runBFS = (startId: number): { furthestId: number; parentMap: Map<number, number> } => {
        const queue: number[] = [startId];
        const visited = new Set<number>([startId]);
        const parentMap = new Map<number, number>();
        let furthestId = startId;

        while (queue.length > 0) {
          const curr = queue.shift()!;
          furthestId = curr;

          const neighbors = regionAdj.get(curr) || [];
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              parentMap.set(neighbor, curr);
              queue.push(neighbor);
            }
          }
        }
        return { furthestId, parentMap };
      };

      const startTri = Array.from(triangleIds)[0];
      const { furthestId: endA } = runBFS(startTri);
      const { furthestId: endB, parentMap } = runBFS(endA);

      const orderedFaces: number[] = [];
      let curr = endB;
      while (curr !== endA) {
        orderedFaces.push(curr);
        const parent = parentMap.get(curr);
        if (parent === undefined) break;
        curr = parent;
      }
      orderedFaces.push(endA);
      orderedFaces.reverse(); // Standard orientation from A to B

      const spinePoints: THREE.Vector3[] = [];
      const spineNormals: THREE.Vector3[] = [];
      for (const f of orderedFaces) {
        const tri = triangles[f];
        if (tri) {
          spinePoints.push(tri.centroid);
          spineNormals.push(tri.normal);
        }
      }

      regionLoops.push({
        type: 'outer',
        vertexIds: orderedFaces.map(f => triangles[f].idx0),
      });

      spineData = { points: spinePoints, normals: spineNormals };
      regionSpines.set(region.id, spineData);
    } else {
      // Identify boundary edges (Standard 2D Loop sampling)
      const edgeCount = new Map<string, number>();
      const edgeToVertices = new Map<string, [number, number]>();

      for (const triId of triangleIds) {
        const tri = triangles[triId];
        if (!tri) continue;

        const edges = [
          [tri.idx0, tri.idx1],
          [tri.idx1, tri.idx2],
          [tri.idx2, tri.idx0],
        ] as const;

        for (const [idxA, idxB] of edges) {
          const key = idxA < idxB ? `${idxA}|${idxB}` : `${idxB}|${idxA}`;
          edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
          if (!edgeToVertices.has(key)) {
            edgeToVertices.set(key, [idxA, idxB]);
          }
        }
      }

      const boundaryEdges = new Set<string>();
      for (const [key, count] of edgeCount.entries()) {
        if (count === 1) {
          boundaryEdges.add(key);
        }
      }

      // Assemble boundary loops
      const adj = new Map<number, number[]>();
      const addAdj = (a: number, b: number) => {
        let list = adj.get(a);
        if (!list) {
          list = [];
          adj.set(a, list);
        }
        list.push(b);
      };

      for (const key of boundaryEdges) {
        const [a, b] = edgeToVertices.get(key)!;
        addAdj(a, b);
        addAdj(b, a);
      }

      const visitedEdges = new Set<string>();

      for (const key of boundaryEdges) {
        if (visitedEdges.has(key)) continue;

        const [start, next] = edgeToVertices.get(key)!;
        const path: number[] = [start, next];
        visitedEdges.add(key);

        let current = next;
        let prev = start;

        while (true) {
          const neighbors = adj.get(current) || [];
          let nextVertex: number | null = null;
          let nextEdgeKey = '';

          for (const n of neighbors) {
            if (n === prev) continue;
            const ek = current < n ? `${current}|${n}` : `${n}|${current}`;
            if (boundaryEdges.has(ek) && !visitedEdges.has(ek)) {
              nextVertex = n;
              nextEdgeKey = ek;
              break;
            }
          }

          if (nextVertex !== null) {
            visitedEdges.add(nextEdgeKey);
            if (nextVertex === start) {
              path.push(nextVertex);
              break;
            }
            path.push(nextVertex);
            prev = current;
            current = nextVertex;
          } else {
            break;
          }
        }

        // Perimeter Minima Alignment
        const isClosed = path.length > 1 && path[0] === path[path.length - 1];
        let finalPath = path;

        if (isClosed && path.length > 2) {
          const loopVertices = path.slice(0, -1);
          let minZIndex = 0;
          let minZ = Infinity;
          for (let j = 0; j < loopVertices.length; j++) {
            const z = uniqueVertices[loopVertices[j]].z;
            if (z < minZ) {
              minZ = z;
              minZIndex = j;
            }
          }
          const rotated = [
            ...loopVertices.slice(minZIndex),
            ...loopVertices.slice(0, minZIndex)
          ];
          rotated.push(rotated[0]);
          finalPath = rotated;
        }

        regionLoops.push({
          type: 'outer',
          vertexIds: [...finalPath],
        });
      }
      if (region.brushType === 'MacroFace' || region.brushType === 'TexturedFace' || region.brushType === 'Marker' || region.brushType === 'Unk Legacy Brush' || region.brushType === 'ManualCircle' || region.brushType === 'ManualSquare' || (region.brushType === 'PointPath' && !isPointPathLine)) {
        const blobSpine = getBlobCenterlineSpine(triangleIds, uniqueVertices, triangles, vertexNormals);
        if (blobSpine) {
          regionSpines.set(region.id, blobSpine);
        }
      }
    }
    regionBoundaryLoops.set(region.id, regionLoops);

    // Compute Local Z-Minima points
    const minimaPoints: { pos: THREE.Vector3; idx: number }[] = [];
    const vertexAdj = new Map<number, Set<number>>();
    const addVertexAdj = (a: number, b: number) => {
      let set = vertexAdj.get(a);
      if (!set) {
        set = new Set();
        vertexAdj.set(a, set);
      }
      set.add(b);
    };

    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (!tri) continue;
      addVertexAdj(tri.idx0, tri.idx1);
      addVertexAdj(tri.idx1, tri.idx2);
      addVertexAdj(tri.idx2, tri.idx0);
      addVertexAdj(tri.idx1, tri.idx0);
      addVertexAdj(tri.idx2, tri.idx1);
      addVertexAdj(tri.idx0, tri.idx2);
    }

    for (const idx of vertexAdj.keys()) {
      const pos = uniqueVertices[idx];
      const neighbors = vertexAdj.get(idx)!;
      let isMin = true;
      for (const nIdx of neighbors) {
        if (pos.z > uniqueVertices[nIdx].z) {
          isMin = false;
          break;
        }
      }
      if (isMin) {
        minimaPoints.push({ pos: pos.clone(), idx });
      }
    }
    regionMinimaPoints.set(region.id, minimaPoints);

    // Version 2 persistent serialization elements and metadata
    const rleSpans = compressRLE(Array.from(region.triangleIds));

    const brush: BrushMetadata = {
      brushType: region.brushType,
      parameters: {
        coplanarityAngleDeg: (region.brushType === 'MacroFace' || region.brushType === 'TexturedFace') ? 15 : undefined,
        creaseAngleDeg: region.brushType === 'Ridge' ? 30 : undefined,
        radiusMm: region.brushType === 'Point' ? 5 : undefined,
        pointPathMode: region.brushType === 'PointPath' ? state.pointPathMode : undefined,
        pointPathClosed: region.brushType === 'PointPath' ? state.pointPathClosed : undefined,
      },
    };

    const activeSettings = getSettings();
    const support: SupportGenerationMetadata = {
      presetId: 'default',
      presetName: 'Default Preset',
      parameters: {
        shaftDiameterMm: trunkWidth,
        perimeterSpacingMm: perimeterSpacing,
        infillSpacingMm: infillSpacing,
        minimaSuppressionRadiusMm: minimaSuppressionRadius,
        suppressionSettings: {
          minima: { ...suppressionSettings.minima },
          perimeter: { ...suppressionSettings.perimeter },
          infill: { ...suppressionSettings.infill },
          centerline: { ...suppressionSettings.centerline },
        },
        tipContactDiameterMm: activeSettings.tip.contactDiameterMm,
        tipBodyDiameterMm: activeSettings.tip.bodyDiameterMm,
        tipLengthMm: activeSettings.tip.lengthMm,
        tipConeAngleDeg: activeSettings.tip.coneAngleDeg,
        rootsDiameterMm: activeSettings.roots.diameterMm,
        rootsDiskHeightMm: activeSettings.roots.diskHeightMm,
        rootsConeHeightMm: activeSettings.roots.coneHeightMm,
        baseFlareEnabled: activeSettings.baseFlare.enabled,
        baseFlareDiameterMm: activeSettings.baseFlare.diameterMm,
        baseFlareHeightMm: activeSettings.baseFlare.heightMm,
        shaftMaxAngleDeg: activeSettings.shaft.maxAngleDeg,
      },
    };

    region.loops = regionLoops;
    region.rleSpans = rleSpans;
    region.brush = brush;
    region.support = support;
  }

  // Save mutated regions with loops, RLE spans, and metadata back to the store
  const currentRegions = new Map(supportPainterStore.getSnapshot().regions);
  for (const r of regions) {
    currentRegions.set(r.id, r);
  }
  supportPainterStore.restoreRegions(currentRegions);

  // ─── Configurable Stage-Based Suppression Sequencer [SUPPRESSION_SEQUENCER] ───
  const acceptedMinima: SampledPoint[] = [];
  const acceptedPerimeter: SampledPoint[] = [];
  const acceptedInfill: SampledPoint[] = [];
  const acceptedCenterline: SampledPoint[] = [];

  const acceptedPoints = () => [...acceptedMinima, ...acceptedPerimeter, ...acceptedInfill, ...acceptedCenterline];

  const areRegionsIntersecting = (r1: ROIRegion, r2: ROIRegion): boolean => {
    for (const triId of r1.triangleIds) {
      if (r2.triangleIds.has(triId)) return true;
    }
    return false;
  };

  const getRegionSuppressionRule = (
    region: ROIRegion,
    stage: 'minima' | 'perimeter' | 'infill' | 'centerline'
  ) => {
    const resolvedOps = region.customBrush?.operations || upgradePipeline(undefined, region.brushType, defaultSpacing);
    const op = resolvedOps.find(o => o.type === stage && o.enabled);
    if (op) {
      const isLockedInfillZ = stage === 'infill' && op.enableZHeightDensity;
      const isEnabled = isLockedInfillZ || op.suppression?.enabled;
      const dist = isLockedInfillZ ? 0.1 : (op.suppression?.distanceMm ?? 0);
      if (isEnabled) {
        return {
          enabled: true,
          distanceMm: dist,
          types: op.suppression?.suppressAgainst ?? [],
          mode: 'all' as 'none' | 'current' | 'all',
        };
      }
    }
    return {
      enabled: false,
      distanceMm: 0,
      types: [] as ('minima' | 'perimeter' | 'infill' | 'centerline')[],
      mode: 'none' as 'none' | 'current' | 'all',
    };
  };

  const evaluateSuppression = (cand: SampledPoint, accepted: SampledPoint[]): boolean => {
    const region = allRegions.get(cand.regionId);
    if (!region) return false;

    let combinedEnabled = false;
    let maxDistance = 0;
    const combinedTypes = new Set<'minima' | 'perimeter' | 'infill' | 'centerline'>();
    let combinedMode: 'none' | 'current' | 'all' = 'none';

    for (const r of regions) {
      if (r.id === cand.regionId || areRegionsIntersecting(region, r)) {
        const rule = getRegionSuppressionRule(r, cand.stage);
        if (rule.enabled) {
          combinedEnabled = true;
          maxDistance = Math.max(maxDistance, rule.distanceMm);
          for (const t of rule.types) {
            combinedTypes.add(t);
          }
          if (rule.mode === 'all') {
            combinedMode = 'all';
          } else if (rule.mode === 'current' && combinedMode !== 'all') {
            combinedMode = 'current';
          }
        }
      }
    }

    if (!combinedEnabled) return false;

    const getRegionZBounds = (r: ROIRegion): { minZ: number; maxZ: number } => {
      let minZ = Infinity;
      let maxZ = -Infinity;
      if (r.triangleIds && r.triangleIds.size > 0) {
        for (const triId of r.triangleIds) {
          const tri = triangles[triId];
          if (!tri) continue;
          minZ = Math.min(minZ, tri.v0.z, tri.v1.z, tri.v2.z);
          maxZ = Math.max(maxZ, tri.v0.z, tri.v1.z, tri.v2.z);
        }
      }
      if (minZ === Infinity) return { minZ: 0.0, maxZ: 1.0 };
      return { minZ, maxZ };
    };

    for (const acc of accepted) {
      if (combinedTypes.has(acc.stage)) {
        if (combinedMode === 'all' || (combinedMode === 'current' && acc.regionId === cand.regionId)) {
          let effectiveRadius = maxDistance;
          if (cand.regionType === 'RoughEdge' || acc.regionType === 'RoughEdge' ||
              cand.regionType === 'SoftRidge' || acc.regionType === 'SoftRidge') {
            effectiveRadius = Math.max(effectiveRadius, trunkWidth * 3.0);
          } else {
            // Apply Z-density dynamic scaling to suppression distance if enabled
            const resolvedOps = region.customBrush?.operations || upgradePipeline(undefined, region.brushType, defaultSpacing);
            const op = resolvedOps.find((o: CustomSupportOperation) => o.type === cand.stage && o.enabled);
            if (op && op.enableZHeightDensity) {
              const { minZ, maxZ } = getRegionZBounds(region);
              const preset = op.supportPresetId ? getPresetById(op.supportPresetId) : undefined;
              const opTrunkWidth = preset ? preset.settings.shaft.diameterMm : getSettings().shaft.diameterMm;
              
              const baseOp = {
                ...op,
                spacing: {
                  ...op.spacing,
                  baseSpacingMm: maxDistance,
                }
              };
              effectiveRadius = calculateZHeightDensitySpacing(cand.pos.z, minZ, maxZ, baseOp, opTrunkWidth);
            }
          }

          if (distance2D(cand.pos, acc.pos) < effectiveRadius) {
            return true;
          }
        }
      }
    }

    return false;
  };

  // Pipeline execution for each region
  for (const region of regions) {
    const vertexNormals = regionVertexNormals.get(region.id);
    if (!vertexNormals) continue;

    // Scan all vertices of the region's triangles to find absolute ROI Z span boundaries once per region
    let regionMinZ = Infinity;
    let regionMaxZ = -Infinity;
    if (region.triangleIds && region.triangleIds.size > 0) {
      for (const triId of region.triangleIds) {
        const tri = triangles[triId];
        if (!tri) continue;
        regionMinZ = Math.min(regionMinZ, tri.v0.z, tri.v1.z, tri.v2.z);
        regionMaxZ = Math.max(regionMaxZ, tri.v0.z, tri.v1.z, tri.v2.z);
      }
    }
    if (regionMinZ === Infinity) regionMinZ = 0.0;
    if (regionMaxZ === -Infinity) regionMaxZ = 1.0;

    const pipeline: {
      type: 'minima' | 'perimeter' | 'infill' | 'centerline';
      enabled: boolean;
      supportPresetId?: string;
      endSpacingMm?: number;
      spacing: {
        baseSpacingMm: number;
        sequence?: number[];
        solverMode?: 'standard' | 'closest' | 'add' | 'remove';
        useInflectionPoints?: boolean;
        infillPattern?: 'PoissonDisc' | 'Grid' | 'Honeycomb' | 'Concentric';
        seedFromMinima?: boolean;
        attemptLeafCreation?: boolean;
      };
    }[] = [];

    const resolvedOps = region.customBrush?.operations || upgradePipeline(undefined, region.brushType, defaultSpacing);
    for (const op of resolvedOps) {
      pipeline.push({
        type: op.type,
        enabled: op.enabled !== false,
        supportPresetId: op.supportPresetId,
        insetDistanceMm: op.insetDistanceMm,
        wrapFraction: op.wrapFraction,
        enableZHeightDensity: op.enableZHeightDensity,
        minimaStartInterval: op.minimaStartInterval,
        minimaEndInterval: op.minimaEndInterval,
        endSpacingMm: op.endSpacingMm,
        zFactor: op.zFactor,
        zFactorCurve: op.zFactorCurve,
        spacing: { ...op.spacing },
      } as any);
    }

    for (const stage of pipeline) {
      if (!stage.enabled) continue;

      const preset = stage.supportPresetId ? getPresetById(stage.supportPresetId) : undefined;
      const activeTrunkDiameter = preset ? preset.settings.shaft.diameterMm : getSettings().shaft.diameterMm;
      const candidates: SampledPoint[] = [];

      if (stage.type === 'minima') {
        const minimaPoints = regionMinimaPoints.get(region.id) || [];
        for (const m of minimaPoints) {
          candidates.push({
            pos: m.pos.clone(),
            normal: (vertexNormals.get(m.idx) || new THREE.Vector3(0, 0, 1)).clone(),
            regionId: region.id,
            regionType: region.brushType,
            regionTriCount: region.triangleIds.size,
            stage: 'minima',
            attemptLeafCreation: stage.spacing.attemptLeafCreation,
            leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
            supportPresetId: stage.supportPresetId,
          });
        }
        candidates.sort((a, b) => a.pos.z - b.pos.z);
        rawMinima.push(...candidates);
      } else if (stage.type === 'perimeter') {
        const loops = regionBoundaryLoops.get(region.id) || [];
        
        // 1. Alpha-Shape Envelope bypassed to preserve high-fidelity boundaries and prevent air bridging
        const bridgedLoops = loops;
        
        // 2. Dynamic Euclidean Decimation Filter
        const spacing = Math.max(0.1, stage.spacing.baseSpacingMm);
        const tolerance = Math.max(0.5, spacing * 0.2);

        for (const loop of bridgedLoops) {
          if (loop.vertexIds.length < 2) continue;

          // Project loop point positions for geometric offseting
          let loopPts = loop.vertexIds.map(idx => uniqueVertices[idx].clone());

          // A. Multi-Perimeter Inboard Insetting (Clipper.js Offset)
          const insetDistance = (stage as any).insetDistanceMm ?? 0.0;
          if (insetDistance > 0.001) {
            const planeCentroid = new THREE.Vector3();
            loopPts.forEach(p => planeCentroid.add(p));
            planeCentroid.divideScalar(loopPts.length);

            const planeNormal = new THREE.Vector3();
            loop.vertexIds.forEach(idx => {
              const norm = vertexNormals.get(idx);
              if (norm) planeNormal.add(norm);
            });
            if (planeNormal.lengthSq() < 1e-4) {
              planeNormal.set(0, 0, 1);
            } else {
              planeNormal.normalize();
            }

            const loopNorms = loop.vertexIds.map(idx => vertexNormals.get(idx) || new THREE.Vector3(0, 0, 1));
            loopPts = insetBoundaryLoop(loopPts, planeNormal, planeCentroid, insetDistance, loopNorms);
          }

          if (loopPts.length < 2) continue;

          // B. Wrap Fraction Truncation Loop Filtering bypassed to avoid artificial open-loop bridging.
          // Filtering is now performed post-sampling using the Z-height cutoff relative to the ROI.

          // C. Re-register points into uniqueVertices and vertexNormals
          const loopIndices: number[] = [];
          for (const pt of loopPts) {
            const newIdx = uniqueVertices.length;
            uniqueVertices.push(pt);
            
            let closestNorm = new THREE.Vector3(0, 0, 1);
            let minDistSq = Infinity;
            for (const origIdx of loop.vertexIds) {
              const dSq = uniqueVertices[origIdx].distanceToSquared(pt);
              if (dSq < minDistSq) {
                minDistSq = dSq;
                const norm = vertexNormals.get(origIdx);
                if (norm) closestNorm = norm;
              }
            }
            vertexNormals.set(newIdx, closestNorm.clone());
            loopIndices.push(newIdx);
          }

          if (loopIndices.length > 1 && loopIndices[0] !== loopIndices[loopIndices.length - 1]) {
            loopIndices.push(loopIndices[0]);
          }

          // D. Decimate loop points
          const simplifiedIndices = simplifyLoopEuclidean(loopIndices, uniqueVertices, tolerance);
          let samples: BasicSampledPoint[] = [];

          // Setup Z-height density spacing parameters lookup windowed/normalized to region Z bounds
          let zDensityParams: any = undefined;
          if ((stage as any).enableZHeightDensity) {
            zDensityParams = {
              minimaZ: regionMinZ,
              maximaZ: regionMaxZ,
              op: stage,
              activeTrunkDiameter: activeTrunkDiameter || 1.0,
            };
          }

          if (stage.spacing.useInflectionPoints) {
            const solverMode = stage.spacing.solverMode || 'standard';
            samples = solvePerimeterWithInflections(
              simplifiedIndices,
              spacing,
              solverMode,
              uniqueVertices,
              vertexNormals,
              zDensityParams
            );
          } else {
            samples = samplePolylineWithNormals(
              simplifiedIndices,
              spacing,
              uniqueVertices,
              vertexNormals,
              zDensityParams
            );
          }

          // E. Filter samples by Wrap Limit Percentage (Z Cutoff)
          const rawWrap = (stage as any).wrapFraction ?? 100;
          // Support backward compatibility (if <= 1.0, treat as float, e.g. 0.5 -> 50%)
          const wFrac = typeof rawWrap === 'number' ? (rawWrap > 1.0 ? rawWrap / 100.0 : rawWrap) : 1.0;

          const zSpan = regionMaxZ - regionMinZ;
          const zThreshold = regionMinZ + wFrac * zSpan;

          for (const sample of samples) {
            const zRel = sample.pos.z - regionMinZ;

            // Only keep supports within the Wrap Limit Z span
            if (zSpan <= 0.001 || sample.pos.z <= zThreshold + 1e-4) {
              candidates.push({
                pos: sample.pos,
                normal: sample.normal,
                regionId: region.id,
                regionType: region.brushType,
                regionTriCount: region.triangleIds.size,
                stage: 'perimeter',
                attemptLeafCreation: stage.spacing.attemptLeafCreation,
                leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
                supportPresetId: stage.supportPresetId,
              });
            }
          }
        }
        rawPerimeter.push(...candidates);
      } else if (stage.type === 'centerline') {
        const spine = regionSpines.get(region.id);
        if (spine && spine.points.length > 0) {
          const spacing = Math.max(0.1, stage.spacing.baseSpacingMm);
          let samples: BasicSampledPoint[] = [];

          if (stage.spacing.seedFromMinima) {
            // Find the point along the spine with the absolute lowest Z-coordinate
            let minZIdx = 0;
            let minZ = Infinity;
            for (let j = 0; j < spine.points.length; j++) {
              if (spine.points[j].z < minZ) {
                minZ = spine.points[j].z;
                minZIdx = j;
              }
            }

            // Split spine into two sub-paths starting at minZIdx
            // Segment A: backwards from M to 0
            const ptsA: THREE.Vector3[] = [];
            const normsA: THREE.Vector3[] = [];
            for (let j = minZIdx; j >= 0; j--) {
              ptsA.push(spine.points[j]);
              normsA.push(spine.normals[j]);
            }

            // Segment B: forwards from M to len-1
            const ptsB: THREE.Vector3[] = [];
            const normsB: THREE.Vector3[] = [];
            for (let j = minZIdx; j < spine.points.length; j++) {
              ptsB.push(spine.points[j]);
              normsB.push(spine.normals[j]);
            }

            // Setup Z-height density spacing parameters lookup windowed/normalized to region Z bounds
            let zDensityParams: any = undefined;
            if ((stage as any).enableZHeightDensity) {
              zDensityParams = {
                minimaZ: regionMinZ,
                maximaZ: regionMaxZ,
                op: stage,
                activeTrunkDiameter: activeTrunkDiameter || 1.0,
              };
            }

            // Sample both segments symmetrically outward from M
            const samplesA = sampleSpineWithNormals(ptsA, normsA, spacing, zDensityParams);
            const samplesB = sampleSpineWithNormals(ptsB, normsB, spacing, zDensityParams);

            // Merge results, skipping the duplicate starting point of samplesB
            samples.push(...samplesA);
            if (samplesB.length > 1) {
              samples.push(...samplesB.slice(1));
            }
          } else {
            // Setup Z-height density spacing parameters lookup windowed/normalized to region Z bounds
            let zDensityParams: any = undefined;
            if ((stage as any).enableZHeightDensity) {
              zDensityParams = {
                minimaZ: regionMinZ,
                maximaZ: regionMaxZ,
                op: stage,
                activeTrunkDiameter: activeTrunkDiameter || 1.0,
              };
            }

            // Standard sequential walk from tip to tip
            samples = sampleSpineWithNormals(spine.points, spine.normals, spacing, zDensityParams);
          }

          for (const sample of samples) {
            candidates.push({
              pos: sample.pos,
              normal: sample.normal,
              regionId: region.id,
              regionType: region.brushType,
              regionTriCount: region.triangleIds.size,
              stage: 'centerline',
              attemptLeafCreation: stage.spacing.attemptLeafCreation,
              leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
              supportPresetId: stage.supportPresetId,
            });
          }
        }
        rawCenterline.push(...candidates);
      } else if (stage.type === 'infill') {
        if (region.triangleIds.size > 0) {
          const spacing = Math.max(0.1, stage.spacing.baseSpacingMm);
          const minXY = new THREE.Vector2(Infinity, Infinity);
          const maxXY = new THREE.Vector2(-Infinity, -Infinity);

          for (const triId of region.triangleIds) {
            const tri = triangles[triId];
            if (!tri) continue;
            for (const v of [tri.v0, tri.v1, tri.v2]) {
              minXY.x = Math.min(minXY.x, v.x);
              minXY.y = Math.min(minXY.y, v.y);
              maxXY.x = Math.max(maxXY.x, v.x);
              maxXY.y = Math.max(maxXY.y, v.y);
            }
          }

          let offsetX = 0;
          let offsetY = 0;
          let useSeeding = false;

          const minimaPoints = regionMinimaPoints.get(region.id) || [];
          if (stage.spacing.seedFromMinima && minimaPoints.length > 0) {
            const sorted = [...minimaPoints].sort((a, b) => a.pos.z - b.pos.z);
            offsetX = sorted[0].pos.x;
            offsetY = sorted[0].pos.y;
            useSeeding = true;
          }

          const pattern = stage.spacing.infillPattern || 'PoissonDisc';

          if (pattern === 'Grid') {
            const startX = useSeeding ? offsetX + Math.ceil((minXY.x - offsetX) / spacing) * spacing : minXY.x + spacing / 2;
            const startY = useSeeding ? offsetY + Math.ceil((minXY.y - offsetY) / spacing) * spacing : minXY.y + spacing / 2;

            for (let gx = startX; gx <= maxXY.x; gx += spacing) {
              for (let gy = startY; gy <= maxXY.y; gy += spacing) {
                const px = gx;
                const py = gy;

                let bestZ = -Infinity;
                let matchingTri: WeldedTriangle | null = null;
                let bary: { u: number; v: number; w: number } | null = null;

                for (const triId of region.triangleIds) {
                  const tri = triangles[triId];
                  if (!tri) continue;

                  const res = pointInTriangle2D(px, py, tri.v0.x, tri.v0.y, tri.v1.x, tri.v1.y, tri.v2.x, tri.v2.y);
                  if (res.in) {
                    const z = tri.v0.z * res.w + tri.v1.z * res.v + tri.v2.z * res.u;
                    if (z > bestZ) {
                      bestZ = z;
                      matchingTri = tri;
                      bary = res;
                    }
                  }
                }

                if (matchingTri && bary) {
                  candidates.push({
                    pos: new THREE.Vector3(px, py, bestZ),
                    normal: matchingTri.normal.clone(),
                    regionId: region.id,
                    regionType: region.brushType,
                    regionTriCount: region.triangleIds.size,
                    stage: 'infill',
                    attemptLeafCreation: stage.spacing.attemptLeafCreation,
                    leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
                    supportPresetId: stage.supportPresetId,
                  });
                }
              }
            }
          } else if (pattern === 'Honeycomb') {
            const rowHeight = spacing * 0.8660254;
            const startY = useSeeding ? offsetY + Math.ceil((minXY.y - offsetY) / rowHeight) * rowHeight : minXY.y + rowHeight / 2;

            for (let gy = startY; gy <= maxXY.y; gy += rowHeight) {
              const j = useSeeding ? Math.round((gy - offsetY) / rowHeight) : Math.round((gy - minXY.y) / rowHeight);
              const shiftX = (j % 2 === 0) ? 0 : spacing / 2;

              const startX = useSeeding ? offsetX + shiftX + Math.ceil((minXY.x - offsetX - shiftX) / spacing) * spacing : minXY.x + shiftX + spacing / 2;

              for (let gx = startX; gx <= maxXY.x; gx += spacing) {
                const px = gx;
                const py = gy;

                let bestZ = -Infinity;
                let matchingTri: WeldedTriangle | null = null;
                let bary: { u: number; v: number; w: number } | null = null;

                for (const triId of region.triangleIds) {
                  const tri = triangles[triId];
                  if (!tri) continue;

                  const res = pointInTriangle2D(px, py, tri.v0.x, tri.v0.y, tri.v1.x, tri.v1.y, tri.v2.x, tri.v2.y);
                  if (res.in) {
                    const z = tri.v0.z * res.w + tri.v1.z * res.v + tri.v2.z * res.u;
                    if (z > bestZ) {
                      bestZ = z;
                      matchingTri = tri;
                      bary = res;
                    }
                  }
                }

                if (matchingTri && bary) {
                  candidates.push({
                    pos: new THREE.Vector3(px, py, bestZ),
                    normal: matchingTri.normal.clone(),
                    regionId: region.id,
                    regionType: region.brushType,
                    regionTriCount: region.triangleIds.size,
                    stage: 'infill',
                    attemptLeafCreation: stage.spacing.attemptLeafCreation,
                    leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
                    supportPresetId: stage.supportPresetId,
                  });
                }
              }
            }
          } else if (pattern === 'PoissonDisc') {
            const preset = stage.supportPresetId ? getPresetById(stage.supportPresetId) : undefined;
            const opTrunkWidth = preset ? preset.settings.shaft.diameterMm : getSettings().shaft.diameterMm;

            const results3D = samplePoissonDiscWarped(
              region,
              regionMinZ,
              regionMaxZ,
              stage as any,
              triangles,
              opTrunkWidth
            );

            for (const pt of results3D) {
              candidates.push({
                pos: pt.pos,
                normal: pt.normal,
                regionId: region.id,
                regionType: region.brushType,
                regionTriCount: region.triangleIds.size,
                stage: 'infill',
                attemptLeafCreation: stage.spacing.attemptLeafCreation,
                leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
                supportPresetId: stage.supportPresetId,
              });
            }
          } else {
            const startX = useSeeding ? offsetX + Math.ceil((minXY.x - offsetX) / spacing) * spacing : minXY.x + spacing / 2;
            const startY = useSeeding ? offsetY + Math.ceil((minXY.y - offsetY) / spacing) * spacing : minXY.y + spacing / 2;

            for (let gx = startX; gx <= maxXY.x; gx += spacing) {
              for (let gy = startY; gy <= maxXY.y; gy += spacing) {
                const jitterX = (Math.random() - 0.5) * spacing * 0.3;
                const jitterY = (Math.random() - 0.5) * spacing * 0.3;
                const px = gx + jitterX;
                const py = gy + jitterY;

                let bestZ = -Infinity;
                let matchingTri: WeldedTriangle | null = null;
                let bary: { u: number; v: number; w: number } | null = null;

                for (const triId of region.triangleIds) {
                  const tri = triangles[triId];
                  if (!tri) continue;

                  const res = pointInTriangle2D(px, py, tri.v0.x, tri.v0.y, tri.v1.x, tri.v1.y, tri.v2.x, tri.v2.y);
                  if (res.in) {
                    const z = tri.v0.z * res.w + tri.v1.z * res.v + tri.v2.z * res.u;
                    if (z > bestZ) {
                      bestZ = z;
                      matchingTri = tri;
                      bary = res;
                    }
                  }
                }

                if (matchingTri && bary) {
                  candidates.push({
                    pos: new THREE.Vector3(px, py, bestZ),
                    normal: matchingTri.normal.clone(),
                    regionId: region.id,
                    regionType: region.brushType,
                    regionTriCount: region.triangleIds.size,
                    stage: 'infill',
                    attemptLeafCreation: stage.spacing.attemptLeafCreation,
                    leafInterval: stage.spacing.leafInterval ?? stage.spacing.baseSpacingMm,
                    supportPresetId: stage.supportPresetId,
                  });
                }
              }
            }
          }
        }
        candidates.sort((a, b) => a.pos.z - b.pos.z);
        rawInfill.push(...candidates);
      }

      for (const cand of candidates) {
        if (!evaluateSuppression(cand, acceptedPoints())) {
          if (stage.type === 'minima') {
            acceptedMinima.push(cand);
          } else if (stage.type === 'perimeter') {
            acceptedPerimeter.push(cand);
          } else if (stage.type === 'infill') {
            acceptedInfill.push(cand);
          } else if (stage.type === 'centerline') {
            acceptedCenterline.push(cand);
          }
        }
      }
    }
  }

  // 4. Helper function to project perturbed horizontal coordinates back onto the local surface sheet
  function findSurfaceProjectedPoint(
    mesh: THREE.Mesh,
    targetX: number,
    targetY: number,
    approxZ: number,
    originalNormal: THREE.Vector3
  ): { pos: THREE.Vector3; normal: THREE.Vector3 } | null {
    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3(targetX, targetY, approxZ + 10);
    const direction = new THREE.Vector3(0, 0, -1);
    raycaster.set(origin, direction);
    raycaster.far = 20;

    const hits = raycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;

    let bestHit: THREE.Intersection | null = null;
    let minDistance = Infinity;

    for (const hit of hits) {
      const dist = Math.abs(hit.point.z - approxZ);
      if (dist < minDistance && hit.face) {
        minDistance = dist;
        bestHit = hit;
      }
    }

    if (!bestHit || !bestHit.face) return null;

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const normal = bestHit.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();

    return {
      pos: bestHit.point.clone(),
      normal,
    };
  }

  // Project perturbed coordinates back onto the local surface sheet along surface normal
  function findSurfaceProjectedPointTangent(
    mesh: THREE.Mesh,
    perturbedPos: THREE.Vector3,
    originalNormal: THREE.Vector3
  ): { pos: THREE.Vector3; normal: THREE.Vector3 } | null {
    const raycaster = new THREE.Raycaster();
    const envelope = 2.0; // 2mm safety envelope
    const origin = perturbedPos.clone().addScaledVector(originalNormal, envelope);
    const direction = originalNormal.clone().negate(); // Cast ray opposite to normal
    
    raycaster.set(origin, direction);
    raycaster.far = envelope * 2; // Look up to 2mm deep (4mm total sweep)

    const hits = raycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;

    let bestHit: THREE.Intersection | null = null;
    let minDistance = Infinity;

    for (const hit of hits) {
      const dist = hit.point.distanceTo(perturbedPos);
      if (dist < minDistance && hit.face) {
        minDistance = dist;
        bestHit = hit;
      }
    }

    if (!bestHit || !bestHit.face) return null;

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const normal = bestHit.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();

    return {
      pos: bestHit.point.clone(),
      normal,
    };
  }

  // High-performance dual PCA/Geodesic centerline solver for 2D blob brushes
  function getBlobCenterlineSpine(
    triangleIds: Set<number>,
    uniqueVertices: THREE.Vector3[],
    triangles: WeldedTriangle[],
    vertexNormals: Map<number, THREE.Vector3>
  ): { points: THREE.Vector3[]; normals: THREE.Vector3[] } | null {
    if (triangleIds.size === 0) return null;

    // 1. Gather all centroids and calculate region average normal
    const centroids: THREE.Vector3[] = [];
    const avgNormal = new THREE.Vector3();
    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (tri) {
        centroids.push(tri.centroid);
        avgNormal.add(tri.normal);
      }
    }
    if (centroids.length === 0) return null;
    avgNormal.normalize();

    // 2. Build local coordinate frame tangent plane
    const tangentU = new THREE.Vector3();
    if (Math.abs(avgNormal.x) > Math.abs(avgNormal.z)) {
      tangentU.set(-avgNormal.y, avgNormal.x, 0).normalize();
    } else {
      tangentU.set(0, -avgNormal.z, avgNormal.y).normalize();
    }
    const tangentV = new THREE.Vector3().crossVectors(avgNormal, tangentU).normalize();

    // Project centroids onto local 2D tangent plane
    const proj2D = centroids.map((c) => {
      const diff = c.clone().sub(centroids[0]);
      return new THREE.Vector2(diff.dot(tangentU), diff.dot(tangentV));
    });

    // Calculate 2D centroid of projected points
    const mean = new THREE.Vector2(0, 0);
    for (const p of proj2D) {
      mean.add(p);
    }
    mean.divideScalar(proj2D.length);

    // Compute covariance matrix
    let covXX = 0, covYY = 0, covXY = 0;
    for (const p of proj2D) {
      const dx = p.x - mean.x;
      const dy = p.y - mean.y;
      covXX += dx * dx;
      covYY += dy * dy;
      covXY += dx * dy;
    }
    covXX /= proj2D.length;
    covYY /= proj2D.length;
    covXY /= proj2D.length;

    // Solve for eigenvalues
    const trace = covXX + covYY;
    const det = covXX * covYY - covXY * covXY;
    const term = Math.sqrt(Math.max(0, trace * trace - 4 * det));
    const L1 = (trace + term) / 2;
    const L2 = Math.max(1e-8, (trace - term) / 2);

    const aspectRatio = Math.sqrt(L1 / L2);

    // Check elongation: if elongated (aspectRatio >= 1.5), use PCA
    if (aspectRatio >= 1.5) {
      // Find major eigenvector corresponding to L1
      const majorVec = new THREE.Vector2();
      if (Math.abs(covXY) > 1e-8) {
        majorVec.set(L1 - covYY, covXY).normalize();
      } else {
        if (covXX > covYY) {
          majorVec.set(1, 0);
        } else {
          majorVec.set(0, 1);
        }
      }

      // Project projected 2D points onto major axis to find extents
      let minT = Infinity;
      let maxT = -Infinity;
      for (const p of proj2D) {
        const t = (p.x - mean.x) * majorVec.x + (p.y - mean.y) * majorVec.y;
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }

      // 3D segment endpoints
      const minT3D = centroids[0].clone()
        .addScaledVector(tangentU, mean.x)
        .addScaledVector(tangentV, mean.y)
        .addScaledVector(tangentU, majorVec.x * minT)
        .addScaledVector(tangentV, majorVec.y * minT);
      const maxT3D = centroids[0].clone()
        .addScaledVector(tangentU, mean.x)
        .addScaledVector(tangentV, mean.y)
        .addScaledVector(tangentU, majorVec.x * maxT)
        .addScaledVector(tangentV, majorVec.y * maxT);

      // Sample segment evenly
      const spacing = 4.0; // fallback spacing
      const dist = minT3D.distanceTo(maxT3D);
      const K = Math.max(2, Math.round(dist / spacing));
      const spinePoints: THREE.Vector3[] = [];
      const spineNormals: THREE.Vector3[] = [];

      for (let i = 0; i < K; i++) {
        const t = i / (K - 1);
        const interpPos = new THREE.Vector3().lerpVectors(minT3D, maxT3D, t);
        
        // Tangent project back onto mesh surface using standard safety envelope
        const proj = findSurfaceProjectedPointTangent(mesh, interpPos, avgNormal);
        if (proj) {
          spinePoints.push(proj.pos);
          spineNormals.push(proj.normal);
        } else {
          // Fallback to interpolated pos if raycast fails
          spinePoints.push(interpPos);
          spineNormals.push(avgNormal.clone());
        }
      }

      return { points: spinePoints, normals: spineNormals };
    }

    // FALLBACK: Geodesic Distance Transform / Medial Axis walk
    // 1. Identify boundary edges
    const edgeCount = new Map<string, number>();
    const edgeToVertices = new Map<string, [number, number]>();

    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (!tri) continue;
      const edges = [
        [tri.idx0, tri.idx1],
        [tri.idx1, tri.idx2],
        [tri.idx2, tri.idx0],
      ] as const;
      for (const [idxA, idxB] of edges) {
        const key = idxA < idxB ? `${idxA}|${idxB}` : `${idxB}|${idxA}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        if (!edgeToVertices.has(key)) {
          edgeToVertices.set(key, [idxA, idxB]);
        }
      }
    }

    const boundaryVertices = new Set<number>();
    for (const [key, count] of edgeCount.entries()) {
      if (count === 1) {
        const [a, b] = edgeToVertices.get(key)!;
        boundaryVertices.add(a);
        boundaryVertices.add(b);
      }
    }

    if (boundaryVertices.size === 0) {
      // Loop-free region fallback: just use arbitrary starting point
      const firstTri = triangles[Array.from(triangleIds)[0]];
      if (firstTri) {
        boundaryVertices.add(firstTri.idx0);
      }
    }

    // 2. Multi-source Dijkstra walk inside the sub-graph
    // Build region local adjacency map of faces to faces
    const faceAdj = new Map<number, number[]>();
    const addFaceAdj = (fa: number, fb: number) => {
      let list = faceAdj.get(fa);
      if (!list) { faceAdj.set(fa, list = []); }
      list.push(fb);
    };

    const edgeMap = new Map<string, number[]>();
    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (!tri) continue;
      const edges = [
        tri.idx0 < tri.idx1 ? `${tri.idx0}|${tri.idx1}` : `${tri.idx1}|${tri.idx0}`,
        tri.idx1 < tri.idx2 ? `${tri.idx1}|${tri.idx2}` : `${tri.idx2}|${tri.idx1}`,
        tri.idx2 < tri.idx0 ? `${tri.idx2}|${tri.idx0}` : `${tri.idx0}|${tri.idx2}`
      ];
      for (const ek of edges) {
        let list = edgeMap.get(ek);
        if (!list) { edgeMap.set(ek, list = []); }
        list.push(triId);
      }
    }

    for (const list of edgeMap.values()) {
      if (list.length === 2) {
        addFaceAdj(list[0], list[1]);
        addFaceAdj(list[1], list[0]);
      }
    }

    // Run Multi-source Dijkstra
    const dists = new Map<number, number>();
    interface DijkstraState {
      cost: number;
      face: number;
    }
    const queue: DijkstraState[] = [];

    // Seed faces containing boundary vertices get cost = 0
    for (const triId of triangleIds) {
      const tri = triangles[triId];
      if (!tri) continue;
      if (boundaryVertices.has(tri.idx0) || boundaryVertices.has(tri.idx1) || boundaryVertices.has(tri.idx2)) {
        dists.set(triId, 0);
        queue.push({ cost: 0, face: triId });
      }
    }

    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost);
      const { cost, face } = queue.shift()!;

      const currentBest = dists.get(face) ?? Infinity;
      if (cost > currentBest) continue;

      const neighbors = faceAdj.get(face) || [];
      for (const n of neighbors) {
        const centroidCurr = triangles[face].centroid;
        const centroidAdj = triangles[n].centroid;
        const stepCost = centroidCurr.distanceTo(centroidAdj);
        const nextCost = cost + stepCost;

        const adjBest = dists.get(n) ?? Infinity;
        if (nextCost < adjBest) {
          dists.set(n, nextCost);
          queue.push({ cost: nextCost, face: n });
        }
      }
    }

    // 3. Find Ridge Faces (local distance maxima)
    const ridges: number[] = [];
    for (const triId of triangleIds) {
      const dist = dists.get(triId) ?? 0;
      const neighbors = faceAdj.get(triId) || [];
      let isLocalMax = true;
      for (const n of neighbors) {
        if ((dists.get(n) ?? 0) > dist) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax && dist > 0.05) {
        ridges.push(triId);
      }
    }

    if (ridges.length === 0) {
      // Fallback to center-most face
      let maxDist = -1;
      let centerFace = Array.from(triangleIds)[0];
      for (const triId of triangleIds) {
        const d = dists.get(triId) ?? 0;
        if (d > maxDist) {
          maxDist = d;
          centerFace = triId;
        }
      }
      ridges.push(centerFace);
    }

    // 4. Trace the ridge faces to form a coherent spine
    // Find the two furthest ridge nodes topologically
    const runBFS = (startId: number): { furthestId: number; parentMap: Map<number, number> } => {
      const bQueue: number[] = [startId];
      const visited = new Set<number>([startId]);
      const parentMap = new Map<number, number>();
      let furthestId = startId;

      while (bQueue.length > 0) {
        const curr = bQueue.shift()!;
        furthestId = curr;

        const neighbors = (faceAdj.get(curr) || []).filter(n => ridges.includes(n));
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            parentMap.set(neighbor, curr);
            bQueue.push(neighbor);
          }
        }
      }
      return { furthestId, parentMap };
    };

    const { furthestId: endA } = runBFS(ridges[0]);
    const { furthestId: endB, parentMap } = runBFS(endA);

    const orderedFaces: number[] = [];
    let curr = endB;
    while (curr !== endA) {
      orderedFaces.push(curr);
      const parent = parentMap.get(curr);
      if (parent === undefined) break;
      curr = parent;
    }
    orderedFaces.push(endA);
    orderedFaces.reverse();

    const spinePoints: THREE.Vector3[] = [];
    const spineNormals: THREE.Vector3[] = [];
    for (const f of orderedFaces) {
      const tri = triangles[f];
      if (tri) {
        spinePoints.push(tri.centroid);
        spineNormals.push(tri.normal);
      }
    }

    return { points: spinePoints, normals: spineNormals };
  }

  // ─── Placement Statistics Tracking [STATS_TRACKING] ───
  // [AGENT_NOTE] Compiles exact attempt and placement stats mapped back to ROIs.
  const statsMap = new Map<string, {
    label: string;
    attempted: number;
    placed: number;
    stages: Record<'minima' | 'perimeter' | 'infill' | 'centerline', { attempted: number; placed: number }>;
  }>();

  const registerAttempt = (col: SampledPoint) => {
    let stats = statsMap.get(col.regionId);
    if (!stats) {
      const label = `${BRUSH_DETAILS[col.regionType]?.label || col.regionType} ${col.regionTriCount} tri`;
      stats = {
        label,
        attempted: 0,
        placed: 0,
        stages: {
          minima: { attempted: 0, placed: 0 },
          perimeter: { attempted: 0, placed: 0 },
          infill: { attempted: 0, placed: 0 },
          centerline: { attempted: 0, placed: 0 },
        }
      };
      statsMap.set(col.regionId, stats);
    }
    stats.attempted += 1;
    stats.stages[col.stage].attempted += 1;
  };

  const registerPlacement = (col: SampledPoint) => {
    const stats = statsMap.get(col.regionId);
    if (stats) {
      stats.placed += 1;
      stats.stages[col.stage].placed += 1;
    }
  };

  // 5. Perform Support Generation inside a Transaction Batch leveraging the high quality grid placement solver
  beginSupportStateBatch();

  const settings = getSettings();
  const failedList: FailedPlacementCandidate[] = [];

  const processPointPlacement = (col: SampledPoint) => {
    registerAttempt(col);

    const isMock = mesh?.name === 'mock-mesh-leaf-test';
    const effectiveMeshForPlacement = isMock ? undefined : mesh;

    const presetId = col.supportPresetId;
    const originalSettings = getSettings();
    let settingsOverridden = false;

    if (presetId) {
      const preset = getPresetById(presetId);
      if (preset) {
        const newSettings = {
          ...originalSettings,
          shaft: {
            ...originalSettings.shaft,
            diameterMm: preset.settings?.shaft?.diameterMm ?? originalSettings.shaft.diameterMm,
          },
          tip: {
            ...originalSettings.tip,
            contactDiameterMm: preset.settings?.tip?.contactDiameterMm ?? originalSettings.tip.contactDiameterMm,
            bodyDiameterMm: preset.settings?.tip?.bodyDiameterMm ?? originalSettings.tip.bodyDiameterMm,
            lengthMm: preset.settings?.tip?.lengthMm ?? originalSettings.tip.lengthMm,
            coneAngleDeg: preset.settings?.tip?.coneAngleDeg ?? originalSettings.tip.coneAngleDeg,
          },
          roots: {
            ...originalSettings.roots,
            diameterMm: preset.settings?.roots?.diameterMm ?? originalSettings.roots.diameterMm,
            diskHeightMm: preset.settings?.roots?.diskHeightMm ?? originalSettings.roots.diskHeightMm,
            coneHeightMm: preset.settings?.roots?.coneHeightMm ?? originalSettings.roots.coneHeightMm,
          }
        };
        setSettings(newSettings);
        settingsOverridden = true;
      }
    }

    let finalPos = col.pos.clone();
    let finalNormal = col.normal.clone();

    try {
      let isAccepted = validateSupportPlacement(finalPos, finalNormal, modelId, effectiveMeshForPlacement);

      if (!isAccepted && effectiveMeshForPlacement) {
        console.log(`[SupportScriptingEngine] Proposed tip at (${col.pos.x.toFixed(2)},${col.pos.y.toFixed(2)},${col.pos.z.toFixed(2)}) is unprintable or collides. Perturbing tip destination...`);
        
        let foundAcceptablePerturbation = false;

        // Scale perturbation radii dynamically based on active support stage spacing (up to 10% of spacing interval)
        let baseInterval = 2.0; // Standard fallback
        if (col.stage === 'perimeter' || col.stage === 'centerline') {
          baseInterval = perimeterSpacing;
        } else if (col.stage === 'infill') {
          baseInterval = infillSpacing;
        } else if (col.stage === 'minima') {
          baseInterval = minimaSuppressionRadius || 2.0;
        }
        const searchRadiusSteps = [0.025, 0.05, 0.075, 0.10].map(pct => baseInterval * pct);

        const searchDirections = 8;
        const angleStep = (Math.PI * 2) / searchDirections;

        perturbLoop: for (const radius of searchRadiusSteps) {
          for (let d = 0; d < searchDirections; d++) {
            const angle = d * angleStep;

            // 1. Construct local 3D tangent plane basis relative to surface normal
            const t1 = new THREE.Vector3();
            if (Math.abs(col.normal.x) > Math.abs(col.normal.z)) {
              t1.set(-col.normal.y, col.normal.x, 0).normalize();
            } else {
              t1.set(0, -col.normal.z, col.normal.y).normalize();
            }
            const t2 = new THREE.Vector3().crossVectors(col.normal, t1).normalize();

            // 2. Shift point along tangent vectors
            const shift = new THREE.Vector3()
              .addScaledVector(t1, Math.cos(angle) * radius)
              .addScaledVector(t2, Math.sin(angle) * radius);
            const perturbedPos = col.pos.clone().add(shift);

            // 3. Project back onto surface along the normal direction
            const proj = findSurfaceProjectedPointTangent(
              mesh,
              perturbedPos,
              col.normal
            );

            if (!proj) continue;

            const isValid = validateSupportPlacement(proj.pos, proj.normal, modelId, mesh);
            if (isValid) {
              console.log(`[SupportScriptingEngine] Found accepted perturbed tip at (${proj.pos.x.toFixed(2)},${proj.pos.y.toFixed(2)},${proj.pos.z.toFixed(2)}) at radius ${radius}mm!`);
              finalPos = proj.pos;
              finalNormal = proj.normal;
              isAccepted = true;
              foundAcceptablePerturbation = true;
              break perturbLoop;
            }
          }
        }

        if (!foundAcceptablePerturbation) {
          console.warn(`[SupportScriptingEngine] Could not find any valid perturbed tip. Proposing original coordinate as fallback.`);
          failedList.push({
            id: generateUuid(),
            pos: { x: col.pos.x, y: col.pos.y, z: col.pos.z },
            normal: { x: col.normal.x, y: col.normal.y, z: col.normal.z },
            stage: col.stage,
            regionId: col.regionId,
            reason: 'COLLISION_OR_UNPRINTABLE',
          });
        }
      }

      if (isAccepted && col.attemptLeafCreation && col.leafInterval) {
        const leafInterval = col.leafInterval;
        const snapshot = getSupportSnapshot();
        const trunks = Object.values(snapshot.trunks).filter(t => t.modelId === modelId);

        let bestKnotInfo: {
          trunk: Trunk;
          segment: Segment;
          segmentIndex: number;
          t: number;
          projectedPoint: THREE.Vector3;
          distance: number;
        } | null = null;
        let minDistance = Infinity;

        for (const trunk of trunks) {
          const root = snapshot.roots[trunk.rootId];
          if (!root) continue;
          for (let i = 0; i < trunk.segments.length; i++) {
            const segment = trunk.segments[i];
            const endpoints = getTrunkSegmentEndpoints(trunk, segment, i, root);
            if (!endpoints) continue;

            const A = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
            const B = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
            const P = finalPos;

            const AB = new THREE.Vector3().subVectors(B, A);
            const AP = new THREE.Vector3().subVectors(P, A);
            const abLenSq = AB.lengthSq();
            let t = 0;
            if (abLenSq > 1e-8) {
              t = AP.dot(AB) / abLenSq;
              t = Math.max(0, Math.min(1, t));
            }
            const projected = new THREE.Vector3().addVectors(A, AB.multiplyScalar(t));
            
            if (finalPos.z <= projected.z) continue;

            const dist = finalPos.distanceTo(projected);
            if (dist < leafInterval && dist < minDistance) {
              minDistance = dist;
              bestKnotInfo = {
                trunk,
                segment,
                segmentIndex: i,
                t,
                projectedPoint: projected,
                distance: dist,
              };
            }
          }
        }

        if (bestKnotInfo && mesh) {
          const { trunk, segment, t, projectedPoint } = bestKnotInfo;
          const dir = new THREE.Vector3().subVectors(projectedPoint, finalPos);
          const distance = dir.length();
          
          let clearLoS = true;
          if (distance > 0.1) {
            dir.normalize();
            const raycaster = new THREE.Raycaster();
            const rayStart = finalPos.clone().addScaledVector(dir, 0.05);
            const rayEnd = projectedPoint.clone().addScaledVector(dir, -0.05);
            const rayDist = rayStart.distanceTo(rayEnd);
            raycaster.set(rayStart, dir);
            raycaster.far = rayDist;
            const hits = raycaster.intersectObject(mesh, false);
            if (hits.length > 0) {
              clearLoS = false;
            }
          }

          if (clearLoS) {
            const knot: Knot = {
              id: generateUuid(),
              parentShaftId: segment.id,
              t,
              pos: { x: projectedPoint.x, y: projectedPoint.y, z: projectedPoint.z },
              diameter: segment.diameter + 0.1,
            };
            const leafResult = buildLeafData({
              tipPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
              surfaceNormal: { x: finalNormal.x, y: finalNormal.y, z: finalNormal.z },
              modelId,
              parentKnot: knot,
              hostDiameterMm: segment.diameter,
            });
            leafResult.leaf.roiId = col.regionId;

            addKnot(knot);
            addLeaf(leafResult.leaf);
            registerPlacement(col);
            return;
          }
        }
      }

      // Call unified placement API to route, snap, and place the support
      const res = placeSupportUnified({
        tipPos: finalPos,
        tipNormal: finalNormal,
        modelId,
        mesh: effectiveMeshForPlacement,
        roiId: col.regionId,
      });

      if (res.success) {
        registerPlacement(col);
      } else {
        failedList.push({
          id: generateUuid(),
          pos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          normal: { x: finalNormal.x, y: finalNormal.y, z: finalNormal.z },
          stage: col.stage,
          regionId: col.regionId,
          reason: res.error || 'PLACEMENT_DECISION_FAILED',
        });
      }
    } finally {
      if (settingsOverridden) {
        setSettings(originalSettings);
      }
    }
  };

  const getSpacingSettings = (
    rId: string,
    sName: 'minima' | 'perimeter' | 'infill' | 'centerline'
  ) => {
    const r = allRegions.get(rId);
    if (!r) return null;
    const resolvedOps = r.customBrush?.operations || upgradePipeline(undefined, r.brushType, defaultSpacing);
    const op = resolvedOps.find(o => o.type === sName && o.enabled);
    return op ? op.spacing : null;
  };

  function clusterPointsCentroid<T>(
    items: T[],
    getPos: (item: T) => THREE.Vector3,
    threshold: number
  ): T[][] {
    const clusters: T[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;
      
      const cluster: T[] = [items[i]];
      assigned.add(i);
      
      const centroid = getPos(items[i]).clone();
      
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < items.length; j++) {
          if (assigned.has(j)) continue;
          const pos = getPos(items[j]);
          if (pos.distanceTo(centroid) <= threshold) {
            cluster.push(items[j]);
            assigned.add(j);
            centroid.set(0, 0, 0);
            for (const item of cluster) {
              centroid.add(getPos(item));
            }
            centroid.divideScalar(cluster.length);
            changed = true;
            break;
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  function buildTipConeAndSocket(
    tipPos: THREE.Vector3,
    tipNormal: THREE.Vector3,
    modelId: string,
    settings: any
  ) {
    const { coneAxis } = resolveConeAxisPolicy({
      surfaceNormal: tipNormal,
      coneAngleMode: settings.tip.coneAngleMode ?? 'normal',
      adaptiveConeAngleOffsetDeg: settings.tip.adaptiveConeAngleOffsetDeg ?? 30,
    });
    const effectiveConeAxis = coneAxis ?? tipNormal;
    const tipProfile = {
      type: 'disk',
      contactDiameterMm: settings.tip.contactDiameterMm,
      bodyDiameterMm: settings.tip.bodyDiameterMm,
      lengthMm: settings.tip.lengthMm,
      penetrationMm: settings.tip.penetrationMm,
      diskThicknessMm: 0.1,
      maxStandoffMm: 1.5,
      standoffAngleThreshold: Math.PI / 4,
    };
    const diskThickness = tipProfile.type === 'disk'
      ? calculateDiskThickness(tipNormal, effectiveConeAxis, tipProfile as any)
      : 0;

    const coneStartPos = new THREE.Vector3()
      .copy(tipPos)
      .addScaledVector(tipNormal, diskThickness);

    const socketPos = getSocketPosition(coneStartPos, effectiveConeAxis, tipProfile as any);
    const socketJointId = generateUuid();
    const jointDiameter = getJointDiameter(settings.shaft.diameterMm);
    const socketJoint: Joint = {
      id: socketJointId,
      pos: socketPos,
      diameter: jointDiameter,
    };

    const contactCone: ContactCone = {
      id: generateUuid(),
      pos: { x: tipPos.x, y: tipPos.y, z: tipPos.z },
      normal: { x: effectiveConeAxis.x, y: effectiveConeAxis.y, z: effectiveConeAxis.z },
      surfaceNormal: { x: tipNormal.x, y: tipNormal.y, z: tipNormal.z },
      profile: tipProfile as any,
      socketJointId: socketJointId,
    };

    return { socketJoint, contactCone };
  }

  function shouldConsolidate(
    trunkA: Trunk,
    trunkB: Trunk,
    snapshot: any,
    spacingSettings: any,
    mesh: THREE.Mesh | undefined
  ): boolean {
    if (!trunkA.contactCone || !trunkB.contactCone) return false;
    
    const minZ = spacingSettings.consolidationMinZ ?? 8.0;
    const tipA = new THREE.Vector3(trunkA.contactCone.pos.x, trunkA.contactCone.pos.y, trunkA.contactCone.pos.z);
    const tipB = new THREE.Vector3(trunkB.contactCone.pos.x, trunkB.contactCone.pos.y, trunkB.contactCone.pos.z);
    
    if (tipA.z < minZ || tipB.z < minZ) return false;

    const rootA = snapshot.roots[trunkA.rootId];
    const rootB = snapshot.roots[trunkB.rootId];
    if (!rootA || !rootB) return false;

    const baseA = new THREE.Vector3(rootA.transform.pos.x, rootA.transform.pos.y, rootA.transform.pos.z);
    const baseB = new THREE.Vector3(rootB.transform.pos.x, rootB.transform.pos.y, rootB.transform.pos.z);

    const baseDistXY = Math.sqrt(Math.pow(baseA.x - baseB.x, 2) + Math.pow(baseA.y - baseB.y, 2));
    const maxBaseDist = spacingSettings.consolidationBaseDistance ?? 2.0;
    if (baseDistXY > maxBaseDist) return false;

    const tipDistXY = Math.sqrt(Math.pow(tipA.x - tipB.x, 2) + Math.pow(tipA.y - tipB.y, 2));
    const maxTipDist = spacingSettings.consolidationTipDistance ?? 5.0;
    if (tipDistXY <= maxTipDist) return true;

    // Centroid angle check
    let centroidXY = new THREE.Vector2(0, 0);
    if (mesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox) {
        mesh.geometry.computeBoundingBox();
      }
      const bbox = mesh.geometry.boundingBox;
      if (bbox) {
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        centroidXY.set(center.x, center.y);
      }
    }
    
    const vectorA = new THREE.Vector2(tipA.x - centroidXY.x, tipA.y - centroidXY.y);
    const vectorB = new THREE.Vector2(tipB.x - centroidXY.x, tipB.y - centroidXY.y);
    const angleA = Math.atan2(vectorA.y, vectorA.x);
    const angleB = Math.atan2(vectorB.y, vectorB.x);
    let diff = Math.abs(angleA - angleB);
    if (diff > Math.PI) {
      diff = 2 * Math.PI - diff;
    }
    const diffDeg = diff * 180 / Math.PI;
    const maxTheta = spacingSettings.consolidationThetaAngle ?? 20.0;
    if (diffDeg <= maxTheta) return true;

    return false;
  }

  function performBranchConsolidation(
    hostTrunk: Trunk,
    lowerTrunk: Trunk,
    regionId: string,
    modelId: string,
    mesh: THREE.Mesh | undefined,
    snapshot: any
  ): boolean {
    if (!hostTrunk.contactCone || !lowerTrunk.contactCone) return false;

    const root = snapshot.roots[hostTrunk.rootId];
    if (!root) return false;

    const lowerTipPos = new THREE.Vector3(lowerTrunk.contactCone.pos.x, lowerTrunk.contactCone.pos.y, lowerTrunk.contactCone.pos.z);
    
    let bestKnotInfo: {
      segment: Segment;
      t: number;
      projectedPoint: THREE.Vector3;
      distance: number;
    } | null = null;
    let minDistance = Infinity;

    for (let i = 0; i < hostTrunk.segments.length; i++) {
      const segment = hostTrunk.segments[i];
      const endpoints = getTrunkSegmentEndpoints(hostTrunk, segment, i, root);
      if (!endpoints) continue;

      const A = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
      const B = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);

      const AB = new THREE.Vector3().subVectors(B, A);
      const AP = new THREE.Vector3().subVectors(lowerTipPos, A);
      const abLenSq = AB.lengthSq();
      let t = 0;
      if (abLenSq > 1e-8) {
        t = AP.dot(AB) / abLenSq;
        t = Math.max(0, Math.min(1, t));
      }
      const projected = new THREE.Vector3().addVectors(A, AB.multiplyScalar(t));
      
      if (lowerTipPos.z <= projected.z) continue;

      const dist = lowerTipPos.distanceTo(projected);
      if (dist < minDistance) {
        minDistance = dist;
        bestKnotInfo = {
          segment,
          t,
          projectedPoint: projected,
          distance: dist,
        };
      }
    }

    if (!bestKnotInfo) return false;

    if (mesh) {
      const dir = new THREE.Vector3().subVectors(bestKnotInfo.projectedPoint, lowerTipPos);
      const distance = dir.length();
      if (distance > 0.1) {
        dir.normalize();
        const raycaster = new THREE.Raycaster();
        const rayStart = lowerTipPos.clone().addScaledVector(dir, 0.05);
        const rayEnd = bestKnotInfo.projectedPoint.clone().addScaledVector(dir, -0.05);
        const rayDist = rayStart.distanceTo(rayEnd);
        raycaster.set(rayStart, dir);
        raycaster.far = rayDist;
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length > 0) {
          return false;
        }
      }
    }

    const knot: Knot = {
      id: generateUuid(),
      parentShaftId: bestKnotInfo.segment.id,
      t: bestKnotInfo.t,
      pos: { x: bestKnotInfo.projectedPoint.x, y: bestKnotInfo.projectedPoint.y, z: bestKnotInfo.projectedPoint.z },
      diameter: bestKnotInfo.segment.diameter + 0.1,
    };

    const tipNormal = lowerTrunk.contactCone.surfaceNormal || lowerTrunk.contactCone.normal || { x: 0, y: 0, z: 1 };
    const { branch } = buildBranchData({
      tipPos: { x: lowerTrunk.contactCone.pos.x, y: lowerTrunk.contactCone.pos.y, z: lowerTrunk.contactCone.pos.z },
      tipNormal: { x: tipNormal.x, y: tipNormal.y, z: tipNormal.z },
      modelId,
      parentKnot: knot,
    });

    if (branch) {
      removeTrunk(lowerTrunk.id);
      addKnot(knot);
      branch.roiId = regionId;
      addBranch(branch);
      return true;
    }

    return false;
  }

  try {
    const allAcceptedPoints = [
      ...acceptedMinima,
      ...acceptedPerimeter,
      ...acceptedInfill,
      ...acceptedCenterline
    ];

    const trunkIdsByStage = {
      minima: new Set<string>(),
      perimeter: new Set<string>(),
      infill: new Set<string>(),
      centerline: new Set<string>(),
    };

    for (const p of allAcceptedPoints) {
      const beforeState = getSupportSnapshot();
      const beforeTrunkIds = new Set(Object.keys(beforeState.trunks));

      processPointPlacement(p);

      const afterState = getSupportSnapshot();
      for (const id of Object.keys(afterState.trunks)) {
        if (!beforeTrunkIds.has(id)) {
          trunkIdsByStage[p.stage].add(id);
        }
      }
    }

    // Run branch consolidation stage-by-stage
    for (const r of regions) {
      const rId = r.id;
      for (const stageName of ['minima', 'perimeter', 'infill', 'centerline'] as const) {
        const spacingSettings = getSpacingSettings(rId, stageName);
        if (!spacingSettings || !spacingSettings.attemptBranchCreation) continue;

        const stageTrunkIds = trunkIdsByStage[stageName];
        if (stageTrunkIds.size < 2) continue;

        const failedConsolidations = new Set<string>();
        let changed = true;
        while (changed) {
          changed = false;
          const currentSnapshot = getSupportSnapshot();
          const currentCandidates = Object.values(currentSnapshot.trunks).filter(
            t => stageTrunkIds.has(t.id) && !failedConsolidations.has(t.id)
          );

          let pairToConsolidate: [Trunk, Trunk] | null = null;
          for (let i = 0; i < currentCandidates.length; i++) {
            for (let j = i + 1; j < currentCandidates.length; j++) {
              const trunkA = currentCandidates[i];
              const trunkB = currentCandidates[j];
              if (shouldConsolidate(trunkA, trunkB, currentSnapshot, spacingSettings, mesh)) {
                pairToConsolidate = [trunkA, trunkB];
                break;
              }
            }
            if (pairToConsolidate) break;
          }

          if (pairToConsolidate) {
            const [trunkA, trunkB] = pairToConsolidate;
            const tipA = new THREE.Vector3(trunkA.contactCone!.pos.x, trunkA.contactCone!.pos.y, trunkA.contactCone!.pos.z);
            const tipB = new THREE.Vector3(trunkB.contactCone!.pos.x, trunkB.contactCone!.pos.y, trunkB.contactCone!.pos.z);
            
            const hostTrunk = tipA.z >= tipB.z ? trunkA : trunkB;
            const lowerTrunk = tipA.z >= tipB.z ? trunkB : trunkA;

            const success = performBranchConsolidation(
              hostTrunk,
              lowerTrunk,
              rId,
              modelId,
              mesh,
              currentSnapshot
            );
            if (success) {
              stageTrunkIds.delete(lowerTrunk.id);
              changed = true;
            } else {
              failedConsolidations.add(lowerTrunk.id);
              changed = true; // Try with other candidates
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[SupportScriptingEngine] Error batching support additions', err);
  } finally {
    endSupportStateBatch();
  }

  supportPainterStore.setFailedCandidates(failedList);

  // 5. Save stats inside the actual region objects in the store map
  const finalRegions = new Map(supportPainterStore.getSnapshot().regions);
  for (const r of regions) {
    const stats = statsMap.get(r.id);
    r.placedCount = stats ? stats.placed : 0;
    r.attemptedCount = stats ? stats.attempted : 0;
    finalRegions.set(r.id, r);
  }
  supportPainterStore.restoreRegions(finalRegions);

  // Capture snapshot after execution and push a unified history step
  const afterState = getSupportSnapshot();
  const afterRegions = new Map(supportPainterStore.getSnapshot().regions);

  pushHistory({
    type: SUPPORT_EDIT_REPLACE,
    payload: {
      before: beforeState,
      after: afterState,
      painterRegionsBefore: beforeRegions,
      painterRegionsAfter: afterRegions,
    },
  });

  // ─── Trigger Toast Statistics Summary [TOAST_DISPATCH] ───
  // [AGENT_NOTE] Sends summary strings to the store to trigger visual notifications.
  const toastLines: string[] = [];
  for (const stats of statsMap.values()) {
    toastLines.push(`${stats.label}: placed ${stats.placed}/${stats.attempted} candidates`);
    const activeStages = (Object.keys(stats.stages) as ('minima' | 'perimeter' | 'infill' | 'centerline')[]).filter(
      s => stats.stages[s].attempted > 0
    );
    if (activeStages.length > 1) {
      const stageDetails = activeStages.map(s => {
        const name = s === 'minima' ? 'minima' : s === 'perimeter' ? 'perimeter' : s === 'infill' ? 'infill' : 'centerline';
        return `${name} ${stats.stages[s].placed}/${stats.stages[s].attempted}`;
      }).join(', ');
      toastLines.push(`  (${stageDetails})`);
    }
  }

  if (toastLines.length > 0) {
    supportPainterStore.showToast(toastLines);
  }

  console.log(
    `[SupportScriptingEngine] Complete! Attempted: ${rawMinima.length} raw minima, ${rawPerimeter.length} raw perimeters, ${rawInfill.length} raw infills. Placed successfully: ${acceptedMinima.length} anchors, ${acceptedPerimeter.length} perimeter columns, ${acceptedInfill.length} infill columns.`
  );
}

/**
 * Selective regeneration for a single ROI region.
 * Purges its existing generated supports first, then re-runs generation.
 */
export async function regenerateSupportsForRoi(
  modelId: string,
  mesh: THREE.Mesh,
  regionId: string
): Promise<void> {
  const regionsMap = supportPainterStore.getSnapshot().regions;
  const region = regionsMap.get(regionId);
  if (!region) {
    console.warn(`[SupportScriptingEngine] Cannot regenerate, region ${regionId} not found in store.`);
    return;
  }

  // 1. Purge existing supports linked to this ROI
  const beforeState = getSupportSnapshot();
  const nextState = deleteSupportsForRoi(beforeState, regionId);
  setSupportSnapshot(nextState);

  // 2. Re-run support generation for this single region using its saved parameters
  // Note: generateSupportsFromPainter will automatically handle normal calculations, boundary walks,
  // placement, and push a history transaction.
  await generateSupportsFromPainter(modelId, mesh, [region]);
}

