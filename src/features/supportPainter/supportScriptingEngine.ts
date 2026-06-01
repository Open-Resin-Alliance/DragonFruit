import * as THREE from 'three';
import {
  type ROIRegion,
  type BrushType,
  type VoxlROIBoundaryLoop,
  type BrushMetadata,
  type SupportGenerationMetadata,
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
} from '@/supports/state';
import { getShaftProfile, getSettings } from '@/supports/Settings';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { placeSupportUnified, validateSupportPlacement } from '@/supports/PlacementLogic/UnifiedPlacement';
import { buildLeafData } from '@/supports/SupportTypes/Leaf/leafBuilder';
import { getTrunkSegmentEndpoints } from '@/supports/SupportPrimitives/Knot/knotUtils';
import { type Trunk, type Segment, type Knot } from '@/supports/types';
import { generateUuid } from '@/utils/uuid';

// ─── Brush Metadata for Toasts ───
// [AGENT_NOTE] Display names used for summary reporting in the toast component.
const BRUSH_DETAILS: Record<BrushType, { label: string }> = {
  MacroFace:      { label: 'MacroFace' },
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

interface WeldedTriangle {
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
    while (accumulatedDist + (segLen - tSeg * segLen) >= spacing) {
      const needed = spacing - accumulatedDist;
      tSeg += needed / segLen;
      const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
      samples.push({ pos, normal });
      accumulatedDist = 0;
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

export function solvePerimeterWithInflections(
  indices: number[],
  baseSpacing: number,
  solverMode: 'standard' | 'closest' | 'add' | 'remove',
  uniqueVertices: THREE.Vector3[],
  vertexNormals: Map<number, THREE.Vector3>
): BasicSampledPoint[] {
  if (indices.length < 2) return [];

  // A. Project boundary loop coordinates onto horizontal XY plane
  const q = indices.map(idx => new THREE.Vector2(uniqueVertices[idx].x, uniqueVertices[idx].y));

  // B. Run q through a running 1D Gaussian kernel to suppress high-frequency noise
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

  // C. Calculate 2D signed curvature angles between adjacent tangents
  const angles: number[] = [];
  for (let i = 0; i < qSmoothed.length; i++) {
    const prev = qSmoothed[(i - 1 + qSmoothed.length) % qSmoothed.length];
    const curr = qSmoothed[i];
    const next = qSmoothed[(i + 1) % qSmoothed.length];

    /* ORIGINAL:
    const t1 = new THREE.Vector2().subVectors(curr, prev).normalize();
    const t2 = new THREE.Vector2().subVectors(next, curr).normalize();
    */
    const diffVec1 = new THREE.Vector2().subVectors(curr, prev);
    const t1 = diffVec1.lengthSq() < 1e-8 ? new THREE.Vector2(1, 0) : diffVec1.normalize();
    
    const diffVec2 = new THREE.Vector2().subVectors(next, curr);
    const t2 = diffVec2.lengthSq() < 1e-8 ? new THREE.Vector2(1, 0) : diffVec2.normalize();

    let diff = Math.atan2(t2.y, t2.x) - Math.atan2(t1.y, t1.x);
    if (diff < -Math.PI) diff += 2 * Math.PI;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    angles.push(diff);
  }

  // D. Find inflection points where curvature signs change
  const inflections: number[] = [0]; // Always anchor at starting vertical minima
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] * angles[i - 1] < 0 && Math.abs(angles[i] - angles[i - 1]) > 0.02) {
      inflections.push(i);
    }
  }
  // Make sure we include the end of the loop
  if (inflections[inflections.length - 1] !== indices.length - 1) {
    inflections.push(indices.length - 1);
  }

  // E. Solve even spacing segment-by-segment
  const samples: BasicSampledPoint[] = [];
  for (let s = 0; s < inflections.length - 1; s++) {
    const startIdx = inflections[s];
    const endIdx = inflections[s + 1];

    const segIndices = indices.slice(startIdx, endIdx + 1);
    const L = getSegmentLength(segIndices, uniqueVertices);
    if (L < 0.1) continue;

    const N = L / baseSpacing;
    let NPrime = Math.round(N);
    if (solverMode === 'add') NPrime = Math.ceil(N);
    if (solverMode === 'remove') NPrime = Math.floor(N);
    NPrime = Math.max(1, NPrime);

    const targetSpacing = L / NPrime;

    // Linearly distribute NPrime supports evenly inside this segment
    const segSamples = sampleSegmentEvenly(segIndices, targetSpacing, NPrime, uniqueVertices, vertexNormals);
    
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
  spacing: number
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
    while (accumulatedDist + (segLen - tSeg * segLen) >= spacing) {
      const needed = spacing - accumulatedDist;
      tSeg += needed / segLen;
      const pos = new THREE.Vector3().lerpVectors(p0, p1, tSeg);
      const normal = new THREE.Vector3().lerpVectors(n0, n1, tSeg).normalize();
      samples.push({ pos, normal });
      accumulatedDist = 0;
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
      if (region.brushType === 'MacroFace' || region.brushType === 'Marker' || region.brushType === 'Unk Legacy Brush' || region.brushType === 'ManualCircle' || region.brushType === 'ManualSquare' || (region.brushType === 'PointPath' && !isPointPathLine)) {
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
        coplanarityAngleDeg: region.brushType === 'MacroFace' ? 15 : undefined,
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
    if (region.customBrush) {
      const op = region.customBrush.operations.find(o => o.type === stage && o.enabled);
      if (op && op.suppression.enabled) {
        return {
          enabled: true,
          distanceMm: op.suppression.distanceMm,
          types: op.suppression.suppressAgainst,
          mode: 'all' as const,
        };
      } else {
        return {
          enabled: false,
          distanceMm: 0,
          types: [] as ('minima' | 'perimeter' | 'infill' | 'centerline')[],
          mode: 'none' as const,
        };
      }
    }

    if (region.brushType === 'MinimaIslands') {
      return {
        enabled: false,
        distanceMm: 0,
        types: [] as ('minima' | 'perimeter' | 'infill' | 'centerline')[],
        mode: 'none' as const,
      };
    }

    const config = suppressionSettings[stage];
    const isOverrideCandidate =
      region.brushType === 'RoughEdge' ||
      region.brushType === 'SoftRidge';

    const effectiveMode = isOverrideCandidate ? 'all' : config.mode;
    if (effectiveMode === 'none') {
      return {
        enabled: false,
        distanceMm: 0,
        types: [] as ('minima' | 'perimeter' | 'infill' | 'centerline')[],
        mode: 'none' as const,
      };
    }

    let radius = stage === 'perimeter' || stage === 'centerline'
      ? perimeterSpacing
      : stage === 'infill'
        ? infillSpacing
        : minimaSuppressionRadius;

    if (region.brushType === 'RoughEdge' || region.brushType === 'SoftRidge') {
      radius = trunkWidth * 3.0;
    }

    return {
      enabled: true,
      distanceMm: radius,
      types: isOverrideCandidate ? ['minima', 'perimeter', 'infill', 'centerline'] as ('minima' | 'perimeter' | 'infill' | 'centerline')[] : config.types,
      mode: effectiveMode,
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

    for (const acc of accepted) {
      if (combinedTypes.has(acc.stage)) {
        if (combinedMode === 'all' || (combinedMode === 'current' && acc.regionId === cand.regionId)) {
          let effectiveRadius = maxDistance;
          if (cand.regionType === 'RoughEdge' || acc.regionType === 'RoughEdge' ||
              cand.regionType === 'SoftRidge' || acc.regionType === 'SoftRidge') {
            effectiveRadius = Math.max(effectiveRadius, trunkWidth * 3.0);
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

    const pipeline: {
      type: 'minima' | 'perimeter' | 'infill' | 'centerline';
      enabled: boolean;
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

    if (region.customBrush) {
      for (const op of region.customBrush.operations) {
        pipeline.push({
          type: op.type,
          enabled: op.enabled,
          spacing: {
            baseSpacingMm: op.spacing.baseSpacingMm,
            sequence: op.spacing.sequence,
            solverMode: op.spacing.solverMode,
            useInflectionPoints: op.spacing.useInflectionPoints,
            infillPattern: op.spacing.infillPattern,
            seedFromMinima: op.spacing.seedFromMinima,
            attemptLeafCreation: op.spacing.attemptLeafCreation,
          },
        });
      }
    } else {
      const isPointPathOrMarker = region.brushType === 'PointPath' || region.brushType === 'Marker' || region.brushType === 'RoughEdge' || region.brushType === 'Unk Legacy Brush';
      const isLineBrush = region.brushType === 'Ridge' || region.brushType === 'SoftRidge' || (
        region.brushType === 'PointPath' && (
          (region.brush?.parameters?.pointPathMode === 'line') ||
          (region.brush === undefined && state.pointPathMode === 'line' && !state.pointPathClosed)
        )
      );
      const isMinimaIslands = region.brushType === 'MinimaIslands';

      pipeline.push({
        type: 'minima',
        enabled: isMinimaIslands || (!isPointPathOrMarker && !isLineBrush),
        spacing: {
          baseSpacingMm: minimaSuppressionRadius,
          attemptLeafCreation: isMinimaIslands,
        },
      });
      pipeline.push({
        type: 'perimeter',
        enabled: !isMinimaIslands && !isPointPathOrMarker && !isLineBrush,
        spacing: { baseSpacingMm: perimeterSpacing },
      });
      pipeline.push({
        type: 'infill',
        enabled: !isMinimaIslands && !isLineBrush,
        spacing: { baseSpacingMm: infillSpacing },
      });
      pipeline.push({
        type: 'centerline',
        enabled: !isMinimaIslands && isLineBrush,
        spacing: { baseSpacingMm: perimeterSpacing, seedFromMinima: true },
      });
    }

    for (const stage of pipeline) {
      if (!stage.enabled) continue;

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
            leafInterval: stage.spacing.baseSpacingMm,
          });
        }
        candidates.sort((a, b) => a.pos.z - b.pos.z);
        rawMinima.push(...candidates);
      } else if (stage.type === 'perimeter') {
        const spine = regionSpines.get(region.id);
        if (spine) {
          const spacing = Math.max(0.1, stage.spacing.baseSpacingMm);
          const samples = sampleSpineWithNormals(spine.points, spine.normals, spacing);
          for (const sample of samples) {
            candidates.push({
              pos: sample.pos,
              normal: sample.normal,
              regionId: region.id,
              regionType: region.brushType,
              regionTriCount: region.triangleIds.size,
              stage: 'perimeter',
            });
          }
        } else {
          const loops = regionBoundaryLoops.get(region.id) || [];
          
          // 1. Alpha-Shape Envelope to bridge disjointed triangle islands
          const alphaRadius = region.customBrush?.selection?.alphaRadiusMm ?? state.brushRadiusMm ?? 1.5;
          const bridgedLoops = applyAlphaShapeToLoops(loops, uniqueVertices, vertexNormals, alphaRadius);
          
          // 2. Dynamic Euclidean Decimation Filter
          const spacing = Math.max(0.1, stage.spacing.baseSpacingMm);
          const tolerance = Math.max(0.5, spacing * 0.2);

          const simplifiedLoops = bridgedLoops.map(loop => ({
            ...loop,
            vertexIds: simplifyLoopEuclidean(loop.vertexIds, uniqueVertices, tolerance),
          }));

          for (const loop of simplifiedLoops) {
            if (loop.vertexIds.length < 2) continue;
            let samples: BasicSampledPoint[] = [];

            if (stage.spacing.useInflectionPoints) {
              const solverMode = stage.spacing.solverMode || 'standard';
              samples = solvePerimeterWithInflections(
                loop.vertexIds,
                spacing,
                solverMode,
                uniqueVertices,
                vertexNormals
              );
            } else if (stage.spacing.sequence && stage.spacing.sequence.length > 0) {
              samples = sampleSequencePolyline(
                loop.vertexIds,
                stage.spacing.sequence,
                uniqueVertices,
                vertexNormals
              );
            } else {
              samples = samplePolylineWithNormals(
                loop.vertexIds,
                spacing,
                uniqueVertices,
                vertexNormals
              );
            }

            for (const sample of samples) {
              candidates.push({
                pos: sample.pos,
                normal: sample.normal,
                regionId: region.id,
                regionType: region.brushType,
                regionTriCount: region.triangleIds.size,
                stage: 'perimeter',
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

            // Sample both segments symmetrically outward from M
            const samplesA = sampleSpineWithNormals(ptsA, normsA, spacing);
            const samplesB = sampleSpineWithNormals(ptsB, normsB, spacing);

            // Merge results, skipping the duplicate starting point of samplesB
            samples.push(...samplesA);
            if (samplesB.length > 1) {
              samples.push(...samplesB.slice(1));
            }
          } else {
            // Standard sequential walk from tip to tip
            samples = sampleSpineWithNormals(spine.points, spine.normals, spacing);
          }

          for (const sample of samples) {
            candidates.push({
              pos: sample.pos,
              normal: sample.normal,
              regionId: region.id,
              regionType: region.brushType,
              regionTriCount: region.triangleIds.size,
              stage: 'centerline',
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
                  });
                }
              }
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
                  });
                }
              }
            }
          }
        }
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

  const processPointPlacement = (col: SampledPoint) => {
    registerAttempt(col);

    const isMock = mesh?.name === 'mock-mesh-leaf-test';
    const effectiveMeshForPlacement = isMock ? undefined : mesh;

    let finalPos = col.pos.clone();
    let finalNormal = col.normal.clone();
    let isAccepted = validateSupportPlacement(finalPos, finalNormal, modelId, effectiveMeshForPlacement);

    if (!isAccepted && effectiveMeshForPlacement) {
      console.log(`[SupportScriptingEngine] Proposed tip at (${col.pos.x.toFixed(2)},${col.pos.y.toFixed(2)},${col.pos.z.toFixed(2)}) is unprintable or collides. Perturbing tip destination...`);
      
      let foundAcceptablePerturbation = false;

      /* [LEGACY_XY_PERTURBATION_STEPS]
      const searchRadiusSteps = [0.05, 0.10, 0.15, 0.20];
      */

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

          /* [LEGACY_XY_PERTURBATION]
          const offsetX = Math.cos(angle) * radius;
          const offsetY = Math.sin(angle) * radius;

          const proj = findSurfaceProjectedPoint(
            mesh,
            col.pos.x + offsetX,
            col.pos.y + offsetY,
            col.pos.z,
            col.normal
          );
          */

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
      }
    }

    if (isAccepted && col.stage === 'minima' && col.attemptLeafCreation && col.leafInterval) {
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
    }
  };

  try {
    // 5a. Place Z-minima heavy anchors
    for (const anchorPoint of acceptedMinima) {
      processPointPlacement(anchorPoint);
    }

    // 5b. Place perimeter, infill, and centerline columns
    const allColumns = [...acceptedPerimeter, ...acceptedInfill, ...acceptedCenterline];
    for (const col of allColumns) {
      processPointPlacement(col);
    }
  } catch (err) {
    console.error('[SupportScriptingEngine] Error batching support additions', err);
  } finally {
    endSupportStateBatch();
  }

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

