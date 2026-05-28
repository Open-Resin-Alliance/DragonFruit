import * as THREE from 'three';
import { type ROIRegion, type BrushType } from './supportPainterTypes';
import { supportPainterStore } from './supportPainterStore';
import {
  getSnapshot as getSupportSnapshot,
  setSnapshot as setSupportSnapshot,
  beginSupportStateBatch,
  endSupportStateBatch,
  addRoot,
  addTrunk,
  addAnchor,
  addBranch,
  addKnot,
  updateKnot,
  updateTrunk,
  addTwig,
  addStick,
} from '@/supports/state';
import { getShaftProfile, getSettings } from '@/supports/Settings';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';
import { decideGridPlacement } from '@/supports/PlacementLogic/Grid/gridPlacement';
import { computeAndApplyTrunkDiameterProfile } from '@/supports/SupportTypes/Trunk/TrunkReplacement';
import { buildTwig } from '@/supports/SupportTypes/Twig/twigBuilder';
import { buildStick } from '@/supports/SupportTypes/Stick/stickBuilder';

// ─── Brush Metadata for Toasts ───
// [AGENT_NOTE] Display names used for summary reporting in the toast component.
const BRUSH_DETAILS: Record<BrushType, { label: string }> = {
  MacroFace:      { label: 'MacroFace' },
  Ridge:          { label: 'Ridge Crease' },
  Point:          { label: 'Point Geodesic' },
  CylinderSides:  { label: 'Cyl. Sides' },
  CylinderMinima: { label: 'Cyl. Minima' },
  Ring:           { label: 'Z-Plane Ring' },
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

// ─── Extended SampledPoint [CANDIDATE_METADATA] ───
// [AGENT_NOTE] Carries original painted region context to allow per-ROI/per-stage suppression 
// and precise tracking of attempted vs placed statistics.
interface SampledPoint extends BasicSampledPoint {
  regionId: string;
  regionType: BrushType;
  regionTriCount: number;
  stage: 'minima' | 'perimeter' | 'infill';
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

  // 3. Process each committed region
  for (const region of regions) {
    const triangleIds = region.triangleIds;
    if (triangleIds.size === 0) continue;

    // 3a. Pre-calculate average vertex normals inside this ROI
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
      vertexNormals.get(idx)!.normalize();
    }

    // 3b. Identify boundary edges
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

      // ─── Perimeter Minima Alignment [PERIMETER_MINIMA] ───
      // [AGENT_NOTE] Shift/rotate the boundary path so the vertex with the lowest Z coordinate is first.
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
        // Rotate loopVertices so that minZIndex is at 0
        const rotated = [
          ...loopVertices.slice(minZIndex),
          ...loopVertices.slice(0, minZIndex)
        ];
        rotated.push(rotated[0]); // Maintain closed loop
        finalPath = rotated;
      }

      // Sample along this aligned polyline
      const samples = samplePolylineWithNormals(finalPath, perimeterSpacing, uniqueVertices, vertexNormals);
      for (const sample of samples) {
        rawPerimeter.push({
          pos: sample.pos,
          normal: sample.normal,
          regionId: region.id,
          regionType: region.brushType,
          regionTriCount: region.triangleIds.size,
          stage: 'perimeter',
        });
      }
    }

    // 3c. Local Z-Minima (Tip Snapping / Heavy Anchors)
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
        rawMinima.push({
          pos: pos.clone(),
          normal: (vertexNormals.get(idx) || new THREE.Vector3(0, 0, 1)).clone(),
          regionId: region.id,
          regionType: region.brushType,
          regionTriCount: region.triangleIds.size,
          stage: 'minima',
        });
      }
    }

    // 3d. Poisson-Disc Infill Sampling
    // Only populated for large surfaces (MacroFace / Cylinder)
    if (region.brushType === 'MacroFace' || region.brushType === 'CylinderSides') {
      const minXY = new THREE.Vector2(Infinity, Infinity);
      const maxXY = new THREE.Vector2(-Infinity, -Infinity);

      for (const triId of triangleIds) {
        const tri = triangles[triId];
        if (!tri) continue;
        for (const v of [tri.v0, tri.v1, tri.v2]) {
          minXY.x = Math.min(minXY.x, v.x);
          minXY.y = Math.min(minXY.y, v.y);
          maxXY.x = Math.max(maxXY.x, v.x);
          maxXY.y = Math.max(maxXY.y, v.y);
        }
      }

      const startX = minXY.x + infillSpacing / 2;
      const startY = minXY.y + infillSpacing / 2;

      for (let gx = startX; gx <= maxXY.x; gx += infillSpacing) {
        for (let gy = startY; gy <= maxXY.y; gy += infillSpacing) {
          // Standard jitter
          const jitterX = (Math.random() - 0.5) * infillSpacing * 0.3;
          const jitterY = (Math.random() - 0.5) * infillSpacing * 0.3;
          const px = gx + jitterX;
          const py = gy + jitterY;

          let bestZ = -Infinity;
          let matchingTri: WeldedTriangle | null = null;
          let bary: { u: number; v: number; w: number } | null = null;

          for (const triId of triangleIds) {
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
            rawInfill.push({
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

  // ─── Configurable Stage-Based Suppression Sequencer [SUPPRESSION_SEQUENCER] ───
  // [AGENT_NOTE] Processed sequentially across all ROIs based on target rules.
  // Dynamic radius applies: perimeter checks use perimeterSpacing, infill uses infillSpacing, minima uses minimaSuppressionRadius.
  const acceptedMinima: SampledPoint[] = [];
  const acceptedPerimeter: SampledPoint[] = [];
  const acceptedInfill: SampledPoint[] = [];

  // helper evaluator
  const evaluateSuppression = (cand: SampledPoint, config: typeof suppressionSettings.minima): boolean => {
    if (config.mode === 'none') return false;

    const allAccepted = [...acceptedMinima, ...acceptedPerimeter, ...acceptedInfill];
    for (const accepted of allAccepted) {
      if (config.types.includes(accepted.stage)) {
        // ROI scope check
        if (config.mode === 'current' && accepted.regionId !== cand.regionId) {
          continue;
        }
        // Match suppression radius to the compared target point
        const radius = accepted.stage === 'perimeter'
          ? perimeterSpacing
          : accepted.stage === 'infill'
            ? infillSpacing
            : minimaSuppressionRadius;

        if (distance2D(cand.pos, accepted.pos) < radius) {
          return true; // Suppressed!
        }
      }
    }
    return false;
  };

  // Stage 1: Evaluate Minima (sorted by Z ascending, lowest Z wins)
  const sortedMinima = [...rawMinima].sort((a, b) => a.pos.z - b.pos.z);
  for (const cand of sortedMinima) {
    if (!evaluateSuppression(cand, suppressionSettings.minima)) {
      acceptedMinima.push(cand);
    }
  }

  // Stage 2: Evaluate Perimeter
  for (const cand of rawPerimeter) {
    if (!evaluateSuppression(cand, suppressionSettings.perimeter)) {
      acceptedPerimeter.push(cand);
    }
  }

  // Stage 3: Evaluate Infill
  for (const cand of rawInfill) {
    if (!evaluateSuppression(cand, suppressionSettings.infill)) {
      acceptedInfill.push(cand);
    }
  }

  // 4. Helper function to compile and route cavity sticks straight down when pathfinding gets trapped
  const _cavityRaycaster = new THREE.Raycaster();
  const _downDir = new THREE.Vector3(0, 0, -1);

  const buildCavityStick = (
    tipPos: { x: number; y: number; z: number },
    tipNormal: { x: number; y: number; z: number },
    modelId: string,
    mesh: THREE.Mesh,
  ) => {
    _cavityRaycaster.set(
      new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z),
      _downDir,
    );
    const OFFSET_MM = 0.5;
    _cavityRaycaster.ray.origin.addScaledVector(
      new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
      OFFSET_MM,
    );
    _cavityRaycaster.ray.origin.z -= OFFSET_MM * 0.1;

    const hits = _cavityRaycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;

    const BELOW_EPS_MM = 0.1;
    const FLOOR_Z_MIN = 0.35;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    type Candidate = { hit: THREE.Intersection; normal: THREE.Vector3 };
    const MAX_HIT_SCAN = 64;
    let scanned = 0;
    let firstBelowCandidate: Candidate | null = null;
    let floorCandidate: Candidate | null = null;

    for (const h of hits) {
      scanned += 1;
      if (scanned > MAX_HIT_SCAN) break;
      if (h.point.z >= tipPos.z - BELOW_EPS_MM) continue;
      if (!h.face) continue;
      const n = h.face.normal.clone().applyNormalMatrix(normalMatrix).normalize();
      const candidate = { hit: h, normal: n };
      if (!firstBelowCandidate) firstBelowCandidate = candidate;
      if (n.z >= FLOOR_Z_MIN) {
        floorCandidate = candidate;
        break;
      }
    }

    const chosen = floorCandidate ?? firstBelowCandidate;
    if (!chosen) return null;

    const bPos = { x: chosen.hit.point.x, y: chosen.hit.point.y, z: chosen.hit.point.z };
    const bNormal = { x: chosen.normal.x, y: chosen.normal.y, z: chosen.normal.z };

    const settings = getSettings();
    const cutoff = settings.meshToMesh?.stickVsTwigCutoffMm ?? 5;
    const dx = tipPos.x - bPos.x;
    const dy = tipPos.y - bPos.y;
    const dz = tipPos.z - bPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const kind: 'twig' | 'stick' = dist > cutoff ? 'stick' : 'twig';

    if (kind === 'twig') {
      const { twig } = buildTwig({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
      return { kind, twig };
    }

    const { stick } = buildStick({ modelId, aPos: tipPos, aNormal: tipNormal, bPos, bNormal });
    return { kind: 'stick', stick };
  };

  // ─── Placement Statistics Tracking [STATS_TRACKING] ───
  // [AGENT_NOTE] Compiles exact attempt and placement stats mapped back to ROIs.
  const statsMap = new Map<string, {
    label: string;
    attempted: number;
    placed: number;
    stages: Record<'minima' | 'perimeter' | 'infill', { attempted: number; placed: number }>;
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

    const build = buildTrunkData({
      tipPos: col.pos,
      tipNormal: col.normal,
      modelId,
      mesh,
    });

    // Check closed cavity or self-overhang pathfinding failures and fall back to cavity sticks/twigs
    if (build.stagnated || build.exhaustedBudget) {
      if (mesh) {
        const cavity = buildCavityStick(col.pos, col.normal, modelId, mesh);
        if (cavity) {
          if (cavity.kind === 'twig' && cavity.twig) {
            addTwig(cavity.twig);
            registerPlacement(col);
          } else if (cavity.kind === 'stick' && cavity.stick) {
            addStick(cavity.stick);
            registerPlacement(col);
          }
        }
      }
      return;
    }

    // Standard high quality grid placement solver
    const snapshot = getSupportSnapshot();
    const decision = decideGridPlacement({
      settings,
      snapshot,
      candidate: build,
      tipPos: col.pos,
      tipNormal: col.normal,
      modelId,
      mesh,
    });

    if (decision.kind === 'place_trunk') {
      const tb = decision.trunkBuild;
      if (tb?.trunk && !tb.stagnated && !tb.exhaustedBudget && !tb.error) {
        addRoot(tb.root);
        addTrunk(tb.trunk);
        registerPlacement(col);
      }
    } else if (decision.kind === 'place_branch') {
      addKnot(decision.knot);
      addBranch(decision.branch);

      const snapshotAfterAdd = getSupportSnapshot();
      const hostTrunk = snapshotAfterAdd.trunks[decision.hostTrunkId];
      if (hostTrunk) {
        const applied = computeAndApplyTrunkDiameterProfile(snapshotAfterAdd, decision.hostTrunkId);
        if (applied) {
          for (const u of applied.knotUpdates) {
            updateKnot(u.after);
          }
          updateTrunk(applied.trunk);
        }
      }
      registerPlacement(col);
    } else if (decision.kind === 'place_anchor') {
      addAnchor(decision.anchor);
      registerPlacement(col);
    } else if (decision.kind === 'replace_trunk') {
      addKnot(decision.promoteKnot);
      addBranch(decision.promoteBranch);

      const tb = decision.trunkBuild;
      if (tb?.trunk) {
        addRoot(tb.root);
        addTrunk(tb.trunk);
        registerPlacement(col);
      }
    }
  };

  try {
    // 5a. Place Z-minima heavy anchors
    for (const anchorPoint of acceptedMinima) {
      processPointPlacement(anchorPoint);
    }

    // 5b. Place perimeter and infill columns
    const allColumns = [...acceptedPerimeter, ...acceptedInfill];
    for (const col of allColumns) {
      processPointPlacement(col);
    }
  } catch (err) {
    console.error('[SupportScriptingEngine] Error batching support additions', err);
  } finally {
    endSupportStateBatch();
  }

  // 5. Capture snapshot after execution and push a unified history step
  const afterState = getSupportSnapshot();

  pushHistory({
    type: SUPPORT_EDIT_REPLACE,
    payload: {
      before: beforeState,
      after: afterState,
    },
  });

  // ─── Trigger Toast Statistics Summary [TOAST_DISPATCH] ───
  // [AGENT_NOTE] Sends summary strings to the store to trigger visual notifications.
  const toastLines: string[] = [];
  for (const stats of statsMap.values()) {
    toastLines.push(`${stats.label}: placed ${stats.placed}/${stats.attempted} candidates`);
    const activeStages = (Object.keys(stats.stages) as ('minima' | 'perimeter' | 'infill')[]).filter(
      s => stats.stages[s].attempted > 0
    );
    if (activeStages.length > 1) {
      const stageDetails = activeStages.map(s => {
        const name = s === 'minima' ? 'minima' : s === 'perimeter' ? 'perimeter' : 'infill';
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
