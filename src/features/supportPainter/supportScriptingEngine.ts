import * as THREE from 'three';
import { type ROIRegion } from './supportPainterTypes';
import {
  getSnapshot as getSupportSnapshot,
  setSnapshot as setSupportSnapshot,
  beginSupportStateBatch,
  endSupportStateBatch,
  addRoot,
  addTrunk,
  addAnchor,
} from '@/supports/state';
import { getShaftProfile } from '@/supports/Settings';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { buildAnchorData } from '@/supports/SupportTypes/Anchor/anchorBuilder';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '@/supports/history/actionTypes';

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

interface SampledPoint {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
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
): SampledPoint[] {
  if (indices.length < 2) return [];

  const samples: SampledPoint[] = [];

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

  const trunkWidth = getShaftProfile()?.diameterMm ?? 1.5;
  const spacing = trunkWidth * 4.0; // center-to-center interval
  const perimeterSpacing = spacing;
  const infillSpacing = spacing;
  const minimaSuppressionRadius = spacing;

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

  // Collections for support placement
  const allHeavyAnchors: SampledPoint[] = [];
  const allPerimeterColumns: SampledPoint[] = [];
  const allInfillColumns: SampledPoint[] = [];

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
    const regionPerimeters: SampledPoint[][] = [];

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

      // Sample along this polyline
      const samples = samplePolylineWithNormals(path, perimeterSpacing, uniqueVertices, vertexNormals);
      if (samples.length > 0) {
        regionPerimeters.push(samples);
        allPerimeterColumns.push(...samples);
      }
    }

    // Flat list of all perimeter positions for this region
    const regionPerimeterPoints = regionPerimeters.flat();

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

    const localMinima: { pos: THREE.Vector3; normal: THREE.Vector3 }[] = [];
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
        localMinima.push({
          pos,
          normal: vertexNormals.get(idx) || new THREE.Vector3(0, 0, 1),
        });
      }
    }

    // Sort by Z coordinate ascending (lowest first) and suppress within 5.0mm
    localMinima.sort((a, b) => a.pos.z - b.pos.z);
    const regionMinima: typeof localMinima = [];

    for (const cand of localMinima) {
      let tooClose = false;
      for (const accepted of regionMinima) {
        if (distance2D(cand.pos, accepted.pos) < minimaSuppressionRadius) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        regionMinima.push(cand);
        allHeavyAnchors.push(cand);
      }
    }

    // 3d. Poisson-Disc Infill Sampling (spacing = 6.0 mm)
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

      const infillCandidates: SampledPoint[] = [];

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
            infillCandidates.push({
              pos: new THREE.Vector3(px, py, bestZ),
              normal: matchingTri.normal.clone(),
            });
          }
        }
      }

      // Suppress infill candidates too close to perimeters, heavy anchors, or other infills (in 2D horizontal plane)
      for (const cand of infillCandidates) {
        let tooClose = false;

        // Against Z-minima anchors
        for (const anchor of regionMinima) {
          if (distance2D(cand.pos, anchor.pos) < minimaSuppressionRadius) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        // Against perimeter columns
        for (const peri of regionPerimeterPoints) {
          if (distance2D(cand.pos, peri.pos) < minimaSuppressionRadius) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        // Against accepted infill
        for (const accepted of allInfillColumns) {
          if (distance2D(cand.pos, accepted.pos) < infillSpacing) {
            tooClose = true;
            break;
          }
        }

        if (!tooClose) {
          allInfillColumns.push(cand);
        }
      }
    }
  }

  // Filter out any perimeter columns that are too close to heavy anchors (Z-minima) in the horizontal plane (2D)
  const filteredPerimeterColumns: SampledPoint[] = [];
  for (const peri of allPerimeterColumns) {
    let tooCloseToAnchor = false;
    for (const anchor of allHeavyAnchors) {
      if (distance2D(peri.pos, anchor.pos) < minimaSuppressionRadius) {
        tooCloseToAnchor = true;
        break;
      }
    }
    if (!tooCloseToAnchor) {
      filteredPerimeterColumns.push(peri);
    }
  }

  // 4. Perform Support Generation inside a Transaction Batch
  beginSupportStateBatch();

  try {
    // 4a. Place Z-minima heavy anchors
    for (const anchorPoint of allHeavyAnchors) {
      const build = buildAnchorData({
        tipPos: anchorPoint.pos,
        tipNormal: anchorPoint.normal,
        modelId,
      });
      if (build?.anchor) {
        addAnchor(build.anchor);
      }
    }

    // 4b. Place perimeter and infill columns (Trunks)
    const allColumns = [...filteredPerimeterColumns, ...allInfillColumns];
    for (const col of allColumns) {
      const build = buildTrunkData({
        tipPos: col.pos,
        tipNormal: col.normal,
        modelId,
        mesh,
      });

      // Avoid placing stagnated, out-of-bound, or faulty routed supports that fail validation/safeguards (Issue 1)
      if (build?.trunk && !build.stagnated && !build.exhaustedBudget && !build.error) {
        addRoot(build.root);
        addTrunk(build.trunk);
      }
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

  console.log(
    `[SupportScriptingEngine] Complete! Generated: ${allHeavyAnchors.length} anchors, ${allPerimeterColumns.length} perimeter columns, ${allInfillColumns.length} infill columns.`
  );
}
