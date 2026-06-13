import * as THREE from 'three';
import { BrushType, CustomBrushTemplate } from './supportPainterTypes';

export interface ClientAdjacencyMap {
  faceCount: number;
  faceToFaces: number[][];
  faceNormals: THREE.Vector3[];
  faceCentroids: THREE.Vector3[];
  faceZBounds: { min: number; max: number }[];
  macroNormalsCache?: Map<number, THREE.Vector3[]>;
  positions?: Float32Array | ArrayLike<number>;
  _topology?: {
    vertexPositions: THREE.Vector3[];
    faceVertices: [number, number, number][];
    edgeMap: Map<string, any>;
    vertexEdges: Set<string>[];
  };
  faceToFacesFlat?: Int32Array;
  faceNormalsFlat?: Float32Array;
  faceCentroidsFlat?: Float32Array;
  faceZBoundsFlat?: Float32Array;
  _macroNormalsFlatCache?: Map<number, Float32Array>;
}

export function wrapFlatAdjacencyMap(
  faceCount: number,
  faceToFacesFlat: Int32Array,
  faceNormalsFlat: Float32Array,
  faceCentroidsFlat: Float32Array,
  faceZBoundsFlat: Float32Array,
  positions: Float32Array | ArrayLike<number>
): ClientAdjacencyMap {
  const cachedFaceToFaces = new Array(faceCount);
  const cachedFaceNormals = new Array(faceCount);
  const cachedFaceCentroids = new Array(faceCount);
  const cachedFaceZBounds = new Array(faceCount);

  // Use flat, filled dummy arrays as Proxy targets so that built-in methods (.map, .forEach, etc.) work correctly
  const faceToFaces = new Proxy(new Array(faceCount).fill(undefined), {
    get(target, prop) {
      if (prop === 'length') return faceCount;
      const idx = Number(prop);
      if (isNaN(idx) || idx < 0 || idx >= faceCount) return (target as any)[prop];

      let arr = cachedFaceToFaces[idx];
      if (arr === undefined) {
        arr = [];
        const start = idx * 3;
        for (let i = 0; i < 3; i++) {
          const val = faceToFacesFlat[start + i];
          if (val !== -1) arr.push(val);
        }
        cachedFaceToFaces[idx] = arr;
      }
      return arr;
    }
  }) as any;

  const faceNormals = new Proxy(new Array(faceCount).fill(undefined), {
    get(target, prop) {
      if (prop === 'length') return faceCount;
      const idx = Number(prop);
      if (isNaN(idx) || idx < 0 || idx >= faceCount) return (target as any)[prop];

      let vec = cachedFaceNormals[idx];
      if (vec === undefined) {
        vec = new THREE.Vector3(
          faceNormalsFlat[idx * 3],
          faceNormalsFlat[idx * 3 + 1],
          faceNormalsFlat[idx * 3 + 2]
        );
        cachedFaceNormals[idx] = vec;
      }
      return vec;
    }
  }) as any;

  const faceCentroids = new Proxy(new Array(faceCount).fill(undefined), {
    get(target, prop) {
      if (prop === 'length') return faceCount;
      const idx = Number(prop);
      if (isNaN(idx) || idx < 0 || idx >= faceCount) return (target as any)[prop];

      let vec = cachedFaceCentroids[idx];
      if (vec === undefined) {
        vec = new THREE.Vector3(
          faceCentroidsFlat[idx * 3],
          faceCentroidsFlat[idx * 3 + 1],
          faceCentroidsFlat[idx * 3 + 2]
        );
        cachedFaceCentroids[idx] = vec;
      }
      return vec;
    }
  }) as any;

  const faceZBounds = new Proxy(new Array(faceCount).fill(undefined), {
    get(target, prop) {
      if (prop === 'length') return faceCount;
      const idx = Number(prop);
      if (isNaN(idx) || idx < 0 || idx >= faceCount) return (target as any)[prop];

      let bounds = cachedFaceZBounds[idx];
      if (bounds === undefined) {
        bounds = {
          min: faceZBoundsFlat[idx * 2],
          max: faceZBoundsFlat[idx * 2 + 1]
        };
        cachedFaceZBounds[idx] = bounds;
      }
      return bounds;
    }
  }) as any;

  return {
    faceCount,
    faceToFaces,
    faceNormals,
    faceCentroids,
    faceZBounds,
    positions,
  };
}

/**
 * Builds a high-performance face adjacency map and spatial cache on the client side
 * directly from the Three.js BufferGeometry, in LOCAL SPACE to ensure 100% robustness
 * against transform timing, scales, and rotation states. Runs in O(N) time and uses
 * flat typed arrays to minimize RAM footprint.
 */
export function buildClientAdjacencyMap(geometry: THREE.BufferGeometry): ClientAdjacencyMap {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!posAttr) {
    return { faceCount: 0, faceToFaces: [], faceNormals: [], faceCentroids: [], faceZBounds: [] };
  }
  const positions = posAttr.array;
  const indexAttr = geometry.index;
  const indices = indexAttr ? indexAttr.array : null;

  const faceCount = indices ? indices.length / 3 : posAttr.count / 3;

  // Flat output arrays to conserve RAM
  const faceToFacesFlat = new Int32Array(faceCount * 3).fill(-1);
  const faceNormalsFlat = new Float32Array(faceCount * 3);
  const faceCentroidsFlat = new Float32Array(faceCount * 3);
  const faceZBoundsFlat = new Float32Array(faceCount * 2);

  // Weld vertices using a numeric hash grid to avoid string allocations
  const vertexHash = new Map<number, number[]>();
  const vertexCoords: number[] = [];
  let nextVertexId = 0;

  const getVertexId = (x: number, y: number, z: number): number => {
    const rx = Math.round(x * 100000);
    const ry = Math.round(y * 100000);
    const rz = Math.round(z * 100000);
    const hash = (rx * 73856093 ^ ry * 19349663 ^ rz * 83492791) >>> 0;

    let list = vertexHash.get(hash);
    if (!list) {
      list = [];
      vertexHash.set(hash, list);
    }

    for (const id of list) {
      const vx = vertexCoords[id * 3];
      const vy = vertexCoords[id * 3 + 1];
      const vz = vertexCoords[id * 3 + 2];
      if (Math.abs(vx - x) < 1e-5 && Math.abs(vy - y) < 1e-5 && Math.abs(vz - z) < 1e-5) {
        return id;
      }
    }

    const id = nextVertexId++;
    list.push(id);
    vertexCoords.push(x, y, z);
    return id;
  };

  const faceVertices = new Int32Array(faceCount * 3);

  // Pass 1: Compute Centroids, Normals, Bounds, and welded Vertex IDs
  for (let f = 0; f < faceCount; f++) {
    let i0, i1, i2;
    if (indices) {
      i0 = indices[f * 3];
      i1 = indices[f * 3 + 1];
      i2 = indices[f * 3 + 2];
    } else {
      i0 = f * 3;
      i1 = f * 3 + 1;
      i2 = f * 3 + 2;
    }

    const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
    const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
    const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

    const vid0 = getVertexId(x0, y0, z0);
    const vid1 = getVertexId(x1, y1, z1);
    const vid2 = getVertexId(x2, y2, z2);

    faceVertices[f * 3]     = vid0;
    faceVertices[f * 3 + 1] = vid1;
    faceVertices[f * 3 + 2] = vid2;

    // Centroid
    faceCentroidsFlat[f * 3]     = (x0 + x1 + x2) / 3;
    faceCentroidsFlat[f * 3 + 1] = (y0 + y1 + y2) / 3;
    faceCentroidsFlat[f * 3 + 2] = (z0 + z1 + z2) / 3;

    // Normal
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    faceNormalsFlat[f * 3]     = nx;
    faceNormalsFlat[f * 3 + 1] = ny;
    faceNormalsFlat[f * 3 + 2] = nz;

    // Z Bounds
    faceZBoundsFlat[f * 2]     = Math.min(z0, z1, z2);
    faceZBoundsFlat[f * 2 + 1] = Math.max(z0, z1, z2);
  }

  // Pass 2: Map edges to faces using packed integer keys (O(N))
  // key = u * 16777216 + v (since max vertex ID is less than 16,777,216)
  const edgeToFaces = new Map<number, number[]>();
  
  for (let f = 0; f < faceCount; f++) {
    const v0 = faceVertices[f * 3];
    const v1 = faceVertices[f * 3 + 1];
    const v2 = faceVertices[f * 3 + 2];

    const e0 = v0 < v1 ? v0 * 16777216 + v1 : v1 * 16777216 + v0;
    const e1 = v1 < v2 ? v1 * 16777216 + v2 : v2 * 16777216 + v1;
    const e2 = v2 < v0 ? v2 * 16777216 + v0 : v0 * 16777216 + v2;

    for (const key of [e0, e1, e2]) {
      let list = edgeToFaces.get(key);
      if (!list) {
        list = [];
        edgeToFaces.set(key, list);
      }
      list.push(f);
    }
  }

  // Pass 3: Build faceToFacesFlat adjacency
  for (let f = 0; f < faceCount; f++) {
    const v0 = faceVertices[f * 3];
    const v1 = faceVertices[f * 3 + 1];
    const v2 = faceVertices[f * 3 + 2];

    const e0 = v0 < v1 ? v0 * 16777216 + v1 : v1 * 16777216 + v0;
    const e1 = v1 < v2 ? v1 * 16777216 + v2 : v2 * 16777216 + v1;
    const e2 = v2 < v0 ? v2 * 16777216 + v0 : v0 * 16777216 + v2;

    const keys = [e0, e1, e2];
    for (let e = 0; e < 3; e++) {
      const list = edgeToFaces.get(keys[e]);
      if (list) {
        for (const other of list) {
          if (other !== f) {
            faceToFacesFlat[f * 3 + e] = other;
            break;
          }
        }
      }
    }
  }

  const map = wrapFlatAdjacencyMap(
    faceCount,
    faceToFacesFlat,
    faceNormalsFlat,
    faceCentroidsFlat,
    faceZBoundsFlat,
    positions
  );

  map.faceToFacesFlat = faceToFacesFlat;
  map.faceNormalsFlat = faceNormalsFlat;
  map.faceCentroidsFlat = faceCentroidsFlat;
  map.faceZBoundsFlat = faceZBoundsFlat;

  return map;
}

/**
 * Executes a high-performance client-side region-wrapping search based on the active smart brush,
 * resolving Z-overhangs and centroids on-the-fly dynamically relative to the model's matrixWorld.
 */
export function proposeRegionOnClient(
  map: ClientAdjacencyMap,
  seedFaceIndex: number,
  brushType: BrushType,
  matrixWorld: THREE.Matrix4,
  brushRadiusMm: number = 4.0,
  customBrush?: CustomBrushTemplate,
  markerParams?: {
    radiusMm: number;
    shape: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon';
    rotationDeg: number;
    collisionMode: 'fence' | 'push' | 'merge';
  },
  occupiedFaces?: Set<number>,
  pointPathParams?: {
    points: { point: [number, number, number]; faceIndex: number }[];
    widthMm: number;
    mode: 'line' | 'polygon';
    closed: boolean;
  }
): number[] {
  if (seedFaceIndex < 0 || seedFaceIndex >= map.faceCount) {
    if (brushType === 'PointPath' && pointPathParams && pointPathParams.points.length > 0) {
      // Allow execution to proceed without a valid seed face for PointPath drawing
    } else {
      return [];
    }
  }

  // Compute local up vector and world scale on-the-fly from the live matrixWorld
  const inv = new THREE.Matrix4().copy(matrixWorld).invert();
  const localUp = new THREE.Vector3(0, 0, 1).transformDirection(inv);

  const scale = new THREE.Vector3();
  matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  const worldScale = (scale.x + scale.y + scale.z) / 3;

  switch (brushType) {
    case 'MacroFace':
      return walkMacroFace(map, seedFaceIndex, localUp, customBrush);
    case 'TexturedFace': {
      const syntheticBrush: CustomBrushTemplate = {
        id: 'default-textured-face',
        name: 'Textured Face',
        color: '#14B8A6',
        selection: {
          enableNormalConeLimit: true,
          normalConeAngleMinDeg: 0,
          normalConeAngleMaxDeg: 30,
          enableSlopeLimit: true,
          overhangSlopeMinDeg: 0,
          overhangSlopeMaxDeg: 90,
          enableDihedralLimit: true,
          dihedralAngleToleranceDeg: 45,
          enableMacroNormalFiltering: true,
          useMacroNormalForCone: true,
          useMacroNormalForSlope: true,
          macroNormalSmoothingIterations: 15,
          macroNormalSmoothingLambda: 0.50,
          curvatureMin: 0,
          curvatureMax: 0,
        },
        operations: [],
      };
      return walkMacroFace(map, seedFaceIndex, localUp, syntheticBrush);
    }
    case 'Ridge':
      return walkRidge(map, seedFaceIndex, localUp, customBrush);
    case 'RoughEdge':
      return walkRoughEdge(map, seedFaceIndex, localUp, customBrush);
    case 'SoftRidge':
      return walkSoftRidge(map, seedFaceIndex, localUp, customBrush);
    case 'Point':
      if (customBrush?.selection?.geodesicPathType === 'square') {
        return walkManualSquare(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
      }
      return walkManualCircle(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'ManualCircle':
      return walkManualCircle(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'ManualSquare':
      return walkManualSquare(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'Ring':
      return walkRing(map, seedFaceIndex, localUp, matrixWorld, customBrush);
    case 'Marker':
      if (markerParams) {
        return walkMarkerShape(
          map,
          seedFaceIndex,
          localUp,
          worldScale,
          markerParams.radiusMm,
          markerParams.shape,
          markerParams.rotationDeg,
          markerParams.collisionMode,
          occupiedFaces
        );
      }
      return walkManualCircle(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'PointPath':
    case 'PointPerimeter':
      if (pointPathParams && pointPathParams.points.length > 0) {
        const pts = pointPathParams.points.map((p) => p.faceIndex);
        if (seedFaceIndex >= 0 && seedFaceIndex < map.faceCount && !pointPathParams.closed) {
          pts.push(seedFaceIndex);
        }
        if (brushType === 'PointPath' && pointPathParams.mode === 'line') {
          return walkPointPathLine(map, pts, pointPathParams.widthMm, localUp, worldScale);
        } else {
          return walkPointPathPolygon(map, pts, localUp, worldScale);
        }
      } else if (seedFaceIndex >= 0 && seedFaceIndex < map.faceCount) {
        return [seedFaceIndex];
      }
    case 'Unk Legacy Brush':
      if (seedFaceIndex >= 0 && seedFaceIndex < map.faceCount) {
        return [seedFaceIndex];
      }
      return [];
    default:
      // Legacy 1-ring fallback
      if (map.faceNormals[seedFaceIndex].dot(localUp) <= 0.2) {
        const list = [seedFaceIndex, ...map.faceToFaces[seedFaceIndex]];
        return list.filter((idx) => idx === seedFaceIndex || map.faceNormals[idx].dot(localUp) <= 0.2);
      }
      return [];
  }
}

// --- Smart Brush Graph Search Walks ---

function getFaceCurvature(map: ClientAdjacencyMap, faceIdx: number): number {
  const norm = map.faceNormals[faceIdx];
  const neighbors = map.faceToFaces[faceIdx];
  if (neighbors.length === 0) return 0;
  let maxAngle = 0;
  for (const adj of neighbors) {
    const angle = norm.angleTo(map.faceNormals[adj]);
    if (angle > maxAngle) maxAngle = angle;
  }
  return maxAngle;
}

export function walkMacroFace(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const queue: number[] = [seed];
  visited.add(seed);

  const selection = customBrush?.selection;
  const enableMacroNormal = selection?.enableMacroNormalFiltering ?? (
    (selection?.macroNormalSmoothingIterations ?? 0) > 0 && 
    (!!selection?.useMacroNormalForCone || !!selection?.useMacroNormalForSlope)
  );
  const iterations = enableMacroNormal ? (selection?.macroNormalSmoothingIterations ?? 0) : 0;
  const lambda = selection?.macroNormalSmoothingLambda ?? 0.5;
  const useMacroCone = enableMacroNormal && !!selection?.useMacroNormalForCone;
  const useMacroSlope = enableMacroNormal && !!selection?.useMacroNormalForSlope;

  let macroNormals = map.faceNormals;
  if (iterations > 0 && (useMacroCone || useMacroSlope)) {
    macroNormals = getOrComputeMacroNormals(map, iterations, lambda);
  }

  const seedNormalRaw = map.faceNormals[seed];
  const seedNormalSlope = useMacroSlope ? macroNormals[seed] : seedNormalRaw;
  const seedNormalCone = useMacroCone ? macroNormals[seed] : seedNormalRaw;

  const degToRad = Math.PI / 180;
  const localDown = new THREE.Vector3().copy(localUp).negate();

  const enableSlope = selection?.enableSlopeLimit ?? true;
  const enableNormalCone = selection?.enableNormalConeLimit ?? true;
  const enableDihedral = selection?.enableDihedralLimit ?? true;
  const enableCurvature = selection?.enableCurvatureLimit ?? false;
  const enableCenterline = selection?.enableCenterlineConstraints ?? false;

  // Overhang slope check for seed
  if (selection) {
    if (enableSlope) {
      const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
      const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
      const seedSlope = seedNormalSlope.angleTo(localDown);
      if (seedSlope < minSlopeRad || seedSlope > maxSlopeRad) return [];
    }
  } else {
    if (seedNormalRaw.dot(localUp) > 0.2) return [];
  }

  // Distance-to-segment squared helper
  const getDistanceToSegmentSq = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number => {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(p, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq < 1e-8) return p.distanceToSquared(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = a.clone().addScaledVector(ab, t);
    return p.distanceToSquared(proj);
  };

  // PASS 1: Extract 1D Centerline Backbone if enabled
  const centerlineFaces = new Set<number>([seed]);
  const centerlineList: number[] = [seed];

  if (enableCenterline) {
    const curvLimitRad = (selection?.centerlineCurvatureLimitDeg ?? 25) * degToRad;

    const traceDirection = (firstStepFace: number) => {
      const path = [seed, firstStepFace];
      let curr = firstStepFace;
      let prev = seed;

      while (true) {
        const adjs = map.faceToFaces[curr] || [];
        let bestNeighbor = -1;
        let bestScore = -1;

        const currCentroid = map.faceCentroids[curr];
        const prevCentroid = map.faceCentroids[prev];
        const dirPrev = new THREE.Vector3().subVectors(currCentroid, prevCentroid).normalize();

        for (const adj of adjs) {
          if (centerlineFaces.has(adj)) continue;
          if (map.faceNormals[adj].dot(localUp) > 0.2) continue;

          const nAdj = map.faceNormals[adj];
          if (selection) {
            if (enableSlope) {
              const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
              const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
              const nSlope = useMacroSlope ? macroNormals[adj] : nAdj;
              const adjSlope = nSlope.angleTo(localDown);
              if (adjSlope < minSlopeRad || adjSlope > maxSlopeRad) continue;
            }
          } else {
            if (nAdj.dot(localUp) > 0.2) continue;
          }

          const adjCentroid = map.faceCentroids[adj];
          const dirNext = new THREE.Vector3().subVectors(adjCentroid, currCentroid).normalize();
          const alignment = dirNext.dot(dirPrev);

          if (alignment > bestScore) {
            bestScore = alignment;
            bestNeighbor = adj;
          }
        }

        if (bestNeighbor === -1) break;

        const angle = Math.acos(Math.max(-1, Math.min(1, bestScore)));
        if (angle > curvLimitRad) break;

        path.push(bestNeighbor);
        centerlineFaces.add(bestNeighbor);
        prev = curr;
        curr = bestNeighbor;
      }
      return path.slice(1);
    };

    const seedAdjs = map.faceToFaces[seed] || [];
    const seedCentroid = map.faceCentroids[seed];
    const candidateSteps = seedAdjs.filter(adj => map.faceNormals[adj].dot(localUp) <= 0.2);

    if (candidateSteps.length >= 2) {
      const stepA = candidateSteps[0];
      const dirA = new THREE.Vector3().subVectors(map.faceCentroids[stepA], seedCentroid).normalize();

      let stepB = -1;
      let minDot = 1.0;
      for (let i = 1; i < candidateSteps.length; i++) {
        const adj = candidateSteps[i];
        const dir = new THREE.Vector3().subVectors(map.faceCentroids[adj], seedCentroid).normalize();
        const dot = dir.dot(dirA);
        if (dot < minDot) {
          minDot = dot;
          stepB = adj;
        }
      }

      if (stepB !== -1 && minDot < 0) {
        centerlineFaces.add(stepA);
        centerlineFaces.add(stepB);
        const forward = traceDirection(stepA);
        const backward = traceDirection(stepB);
        centerlineList.unshift(...backward.reverse());
        centerlineList.push(...forward);
      }
    }
  }

  // PASS 2: BFS propagation with corridor constraints
  const widthSpreadMm = selection?.centerlineWidthSpreadMm ?? 0.3;
  const widthSpreadMmSq = widthSpreadMm * widthSpreadMm;

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const adjs = map.faceToFaces[curr];

    for (const adj of adjs) {
      if (!visited.has(adj)) {
        const nAdjRaw = map.faceNormals[adj];
        const nAdjSlope = useMacroSlope ? macroNormals[adj] : nAdjRaw;

        let slopeOk = false;
        if (selection) {
          if (enableSlope) {
            const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
            const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
            const adjSlope = nAdjSlope.angleTo(localDown);
            slopeOk = adjSlope >= minSlopeRad && adjSlope <= maxSlopeRad;
          } else {
            slopeOk = true;
          }
        } else {
          slopeOk = nAdjRaw.dot(localUp) <= 0.2;
        }

        if (slopeOk) {
          // Centerline Corridor Constraint
          if (enableCenterline) {
            const adjCentroid = map.faceCentroids[adj];
            let minDistSq = Infinity;
            if (centerlineList.length >= 2) {
              for (let j = 0; j < centerlineList.length - 1; j++) {
                const distSq = getDistanceToSegmentSq(
                  adjCentroid,
                  map.faceCentroids[centerlineList[j]],
                  map.faceCentroids[centerlineList[j + 1]]
                );
                if (distSq < minDistSq) minDistSq = distSq;
              }
            } else {
              minDistSq = adjCentroid.distanceToSquared(map.faceCentroids[seed]);
            }
            if (minDistSq > widthSpreadMmSq) continue;
          }

          const nAdjCone = useMacroCone ? macroNormals[adj] : nAdjRaw;
          const normalDeviation = seedNormalCone.angleTo(nAdjCone);
          const nCurr = map.faceNormals[curr];
          const edgeDihedral = nCurr.angleTo(nAdjRaw);

          if (selection) {
            let curvatureOk = true;
            if (enableCurvature) {
              const maxDihedral = getFaceCurvature(map, adj);
              const curvMin = selection.curvatureMin ?? 0;
              const curvMax = selection.curvatureMax ?? 1;
              curvatureOk = maxDihedral >= curvMin && maxDihedral <= curvMax;
            }

            let normalConeOk = true;
            if (enableNormalCone) {
              const minConeRad = selection.normalConeAngleMinDeg * degToRad;
              const maxConeRad = selection.normalConeAngleMaxDeg * degToRad;
              normalConeOk = normalDeviation >= minConeRad && normalDeviation <= maxConeRad;
            }

            let dihedralOk = true;
            if (enableDihedral) {
              const dihedralTolRad = selection.dihedralAngleToleranceDeg * degToRad;
              dihedralOk = edgeDihedral <= dihedralTolRad;
            }

            if (normalConeOk && dihedralOk && curvatureOk) {
              visited.add(adj);
              queue.push(adj);
            }
          } else {
            if (normalDeviation < 0.61 && edgeDihedral < 0.43) {
              visited.add(adj);
              queue.push(adj);
            }
          }
        }
      }
    }
  }

  if (selection) {
    if (enableSlope) {
      const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
      const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
      return Array.from(visited).filter((idx) => {
        if (idx === seed) return true;
        const nSlope = useMacroSlope ? macroNormals[idx] : map.faceNormals[idx];
        const slope = nSlope.angleTo(localDown);
        return slope >= minSlopeRad && slope <= maxSlopeRad;
      });
    } else {
      return Array.from(visited);
    }
  } else {
    return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
  }
}

function walkRidge(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const seedNormal = map.faceNormals[seed];
  if (seedNormal.dot(localUp) > 0.2) return [];

  const selection = customBrush?.selection;
  const HIGH_THRESHOLD = (selection?.creaseSeedAngleDeg ?? 8) * (Math.PI / 180);
  const LOW_THRESHOLD = (selection?.creasePropagateAngleDeg ?? 3) * (Math.PI / 180);
  const alignLimit = selection?.ridgeAlignmentTolerance ?? 0.3;

  const peakCurvatureCache = new Map<number, { neighborIdx: number; angle: number }>();
  const getPeakCurvature = (f: number): { neighborIdx: number; angle: number } => {
    let cached = peakCurvatureCache.get(f);
    if (cached !== undefined) return cached;

    const norm = map.faceNormals[f];
    let maxAngle = 0;
    let neighborIdx = -1;
    for (const adj of map.faceToFaces[f]) {
      const angle = norm.angleTo(map.faceNormals[adj]);
      if (angle > maxAngle) {
        maxAngle = angle;
        neighborIdx = adj;
      }
    }
    const res = { neighborIdx, angle: maxAngle };
    peakCurvatureCache.set(f, res);
    return res;
  };

  const seedPeak = getPeakCurvature(seed);
  if (seedPeak.angle < HIGH_THRESHOLD) return [];
  visited.add(seed);

  const propagateChain = (startFace: number) => {
    let curr = startFace;
    while (true) {
      const { neighborIdx, angle } = getPeakCurvature(curr);
      if (neighborIdx === -1 || angle < LOW_THRESHOLD) break;

      // Compute local ridge axis vector
      const normCurr = map.faceNormals[curr];
      const normCrease = map.faceNormals[neighborIdx];
      const grad = new THREE.Vector3().subVectors(normCurr, normCrease);
      const ridgeAxis = new THREE.Vector3().crossVectors(normCurr, grad);
      if (ridgeAxis.lengthSq() < 1e-6) break;
      ridgeAxis.normalize();

      // Look at unvisited neighbors and choose the one closest to the ridge axis
      const adjs = map.faceToFaces[curr];
      let bestAdj = -1;
      let bestScore = -1;

      for (const adj of adjs) {
        if (visited.has(adj)) continue;
        if (map.faceNormals[adj].dot(localUp) > 0.2) continue; // Overhang constraint

        const adjPeak = getPeakCurvature(adj);
        if (adjPeak.angle < LOW_THRESHOLD) continue;

        // Compute direction displacement vector
        const disp = new THREE.Vector3().subVectors(map.faceCentroids[adj], map.faceCentroids[curr]);
        if (disp.lengthSq() < 1e-6) continue;
        disp.normalize();

        const score = Math.abs(disp.dot(ridgeAxis));
        if (score > bestScore) {
          bestScore = score;
          bestAdj = adj;
        }
      }

      if (bestAdj === -1 || bestScore < alignLimit) break;
      curr = bestAdj;
      visited.add(curr);
    }
  };

  const normSeed = map.faceNormals[seed];
  const normCreaseSeed = map.faceNormals[seedPeak.neighborIdx];
  const gradSeed = new THREE.Vector3().subVectors(normSeed, normCreaseSeed);
  const ridgeAxisSeed = new THREE.Vector3().crossVectors(normSeed, gradSeed);

  if (ridgeAxisSeed.lengthSq() < 1e-6) {
    // Fallback if cross product is degenerate
    const fallbacks = map.faceToFaces[seed].filter(
      (adj) => getPeakCurvature(adj).angle >= LOW_THRESHOLD && map.faceNormals[adj].dot(localUp) <= 0.2
    );
    if (fallbacks.length > 0) {
      visited.add(fallbacks[0]);
      propagateChain(fallbacks[0]);
    }
    if (fallbacks.length > 1) {
      visited.add(fallbacks[1]);
      propagateChain(fallbacks[1]);
    }
  } else {
    ridgeAxisSeed.normalize();

    const adjsSeed = map.faceToFaces[seed];
    let bestForwardAdj = -1;
    let bestForwardScore = -1;
    let bestBackwardAdj = -1;
    let bestBackwardScore = -1;

    for (const adj of adjsSeed) {
      if (map.faceNormals[adj].dot(localUp) > 0.2) continue;
      const adjPeak = getPeakCurvature(adj);
      if (adjPeak.angle < LOW_THRESHOLD) continue;

      const disp = new THREE.Vector3().subVectors(map.faceCentroids[adj], map.faceCentroids[seed]);
      if (disp.lengthSq() < 1e-6) continue;
      disp.normalize();

      const dotVal = disp.dot(ridgeAxisSeed);
      const score = Math.abs(dotVal);
      if (dotVal > 0) {
        if (score > bestForwardScore) {
          bestForwardScore = score;
          bestForwardAdj = adj;
        }
      } else {
        if (score > bestBackwardScore) {
          bestBackwardScore = score;
          bestBackwardAdj = adj;
        }
      }
    }

    if (bestForwardAdj !== -1 && bestForwardScore >= alignLimit) {
      visited.add(bestForwardAdj);
      propagateChain(bestForwardAdj);
    }
    if (bestBackwardAdj !== -1 && bestBackwardScore >= alignLimit) {
      visited.add(bestBackwardAdj);
      propagateChain(bestBackwardAdj);
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

export function walkRoughEdge(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const seedNormal = map.faceNormals[seed];
  if (seedNormal.dot(localUp) > 0.2) return [];

  // Precompute local normal entropy/variance in a 2-ring neighborhood for all candidates
  const varianceCache = new Map<number, number>();
  const getLocalNormalVariance = (f: number): number => {
    const cached = varianceCache.get(f);
    if (cached !== undefined) return cached;

    const neighbors = new Set<number>([f, ...(map.faceToFaces[f] || [])]);
    for (const n of map.faceToFaces[f] || []) {
      for (const nn of map.faceToFaces[n] || []) {
        neighbors.add(nn);
      }
    }
    const norm = map.faceNormals[f];
    let varianceSum = 0;
    let count = 0;
    for (const n of neighbors) {
      const angle = norm.angleTo(map.faceNormals[n]);
      varianceSum += angle * angle;
      count++;
    }
    const res = count > 0 ? varianceSum / count : 0;
    varianceCache.set(f, res);
    return res;
  };

  // 1. Variance Hysteresis (Phase C)
  // Leverage custom roughness threshold dynamically, or fall back to standard smart defaults
  const SEED_THRESHOLD = customBrush?.selection?.roughnessThreshold ?? 0.08;
  const PROPAGATION_THRESHOLD = customBrush?.selection?.roughnessThreshold ?? (customBrush ? 0.06 : 0.08);

  const seedVariance = getLocalNormalVariance(seed);
  if (seedVariance <= SEED_THRESHOLD) return [];

  const queue: number[] = [seed];
  visited.add(seed);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const adjs = map.faceToFaces[curr] || [];

    // 2. Limit Branch-Valence (Phase C)
    // Count the number of high-entropy neighbors at each step
    let roughNeighborCount = 0;
    for (const adj of adjs) {
      if (getLocalNormalVariance(adj) > PROPAGATION_THRESHOLD) {
        roughNeighborCount++;
      }
    }

    // If a face has more than three high-entropy neighbors, treat it as a junction/intersection and terminate
    if (roughNeighborCount > 3) {
      continue;
    }

    for (const adj of adjs) {
      if (visited.has(adj)) continue;
      if (map.faceNormals[adj].dot(localUp) > 0.2) continue; // Overhang check

      const variance = getLocalNormalVariance(adj);
      if (variance > PROPAGATION_THRESHOLD) {
        visited.add(adj);
        queue.push(adj);
      }
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

export function walkSoftRidge(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const seedNormal = map.faceNormals[seed];
  if (seedNormal.dot(localUp) > 0.2) return [];

  const selection = customBrush?.selection;
  // Lower thresholds for soft ridges (e.g. 1.5 deg seed, 0.5 deg propagate)
  const HIGH_THRESHOLD = (selection?.creaseSeedAngleDeg ?? 1.5) * (Math.PI / 180);
  const LOW_THRESHOLD = (selection?.creasePropagateAngleDeg ?? 0.5) * (Math.PI / 180);
  const alignLimit = selection?.ridgeAlignmentTolerance ?? 0.3;

  const peakCurvatureCache = new Map<number, { neighborIdx: number; angle: number }>();
  const getPeakCurvature = (f: number): { neighborIdx: number; angle: number } => {
    let cached = peakCurvatureCache.get(f);
    if (cached !== undefined) return cached;

    const norm = map.faceNormals[f];
    let maxAngle = 0;
    let neighborIdx = -1;
    for (const adj of map.faceToFaces[f] || []) {
      const angle = norm.angleTo(map.faceNormals[adj]);
      if (angle > maxAngle) {
        maxAngle = angle;
        neighborIdx = adj;
      }
    }
    const res = { neighborIdx, angle: maxAngle };
    peakCurvatureCache.set(f, res);
    return res;
  };

  const seedPeak = getPeakCurvature(seed);
  if (seedPeak.angle < HIGH_THRESHOLD) return [];
  visited.add(seed);

  const normSeed = map.faceNormals[seed];
  const normCreaseSeed = map.faceNormals[seedPeak.neighborIdx];
  const gradSeed = new THREE.Vector3().subVectors(normSeed, normCreaseSeed);
  const ridgeAxisSeed = new THREE.Vector3().crossVectors(normSeed, gradSeed);
  const isSeedAxisValid = ridgeAxisSeed.lengthSq() >= 1e-6;
  if (isSeedAxisValid) {
    ridgeAxisSeed.normalize();
  }

  const propagateChain = (startFace: number) => {
    let curr = startFace;
    while (true) {
      const { neighborIdx, angle } = getPeakCurvature(curr);
      if (neighborIdx === -1 || angle < LOW_THRESHOLD) break;

      // Compute local ridge axis vector
      const normCurr = map.faceNormals[curr];
      const normCrease = map.faceNormals[neighborIdx];
      const grad = new THREE.Vector3().subVectors(normCurr, normCrease);
      const ridgeAxis = new THREE.Vector3().crossVectors(normCurr, grad);
      if (ridgeAxis.lengthSq() < 1e-6) break;
      ridgeAxis.normalize();

      // Look at unvisited neighbors and choose the one closest to the ridge axis
      const adjs = map.faceToFaces[curr] || [];
      let bestAdj = -1;
      let bestScore = -1;

      for (const adj of adjs) {
        if (visited.has(adj)) continue;
        if (map.faceNormals[adj].dot(localUp) > 0.2) continue; // Overhang constraint

        const adjPeak = getPeakCurvature(adj);
        if (adjPeak.angle < LOW_THRESHOLD) continue;

        // Compute direction displacement vector
        const disp = new THREE.Vector3().subVectors(map.faceCentroids[adj], map.faceCentroids[curr]);
        if (disp.lengthSq() < 1e-6) continue;
        disp.normalize();

        // Directional crease vector clamp constraint (Phase B)
        if (isSeedAxisValid) {
          const scoreSeed = Math.abs(disp.dot(ridgeAxisSeed));
          if (scoreSeed < 0.3) continue; // Reject lateral loops
        }

        const score = Math.abs(disp.dot(ridgeAxis));
        if (score > bestScore) {
          bestScore = score;
          bestAdj = adj;
        }
      }

      if (bestAdj === -1 || bestScore < alignLimit) break;
      curr = bestAdj;
      visited.add(curr);
    }
  };

  if (!isSeedAxisValid) {
    // Fallback if cross product is degenerate
    const fallbacks = (map.faceToFaces[seed] || []).filter(
      (adj) => getPeakCurvature(adj).angle >= LOW_THRESHOLD && map.faceNormals[adj].dot(localUp) <= 0.2
    );
    if (fallbacks.length > 0) {
      visited.add(fallbacks[0]);
      propagateChain(fallbacks[0]);
    }
    if (fallbacks.length > 1) {
      visited.add(fallbacks[1]);
      propagateChain(fallbacks[1]);
    }
  } else {
    const adjsSeed = map.faceToFaces[seed] || [];
    let bestForwardAdj = -1;
    let bestForwardScore = -1;
    let bestBackwardAdj = -1;
    let bestBackwardScore = -1;

    for (const adj of adjsSeed) {
      if (map.faceNormals[adj].dot(localUp) > 0.2) continue;
      const adjPeak = getPeakCurvature(adj);
      if (adjPeak.angle < LOW_THRESHOLD) continue;

      const disp = new THREE.Vector3().subVectors(map.faceCentroids[adj], map.faceCentroids[seed]);
      if (disp.lengthSq() < 1e-6) continue;
      disp.normalize();

      const dotVal = disp.dot(ridgeAxisSeed);
      const score = Math.abs(dotVal);

      // Enforce clamp on seed neighbor selection too
      if (score < 0.3) continue;

      if (dotVal > 0) {
        if (score > bestForwardScore) {
          bestForwardScore = score;
          bestForwardAdj = adj;
        }
      } else {
        if (score > bestBackwardScore) {
          bestBackwardScore = score;
          bestBackwardAdj = adj;
        }
      }
    }

    if (bestForwardAdj !== -1 && bestForwardScore >= alignLimit) {
      visited.add(bestForwardAdj);
      propagateChain(bestForwardAdj);
    }
    if (bestBackwardAdj !== -1 && bestBackwardScore >= alignLimit) {
      visited.add(bestBackwardAdj);
      propagateChain(bestBackwardAdj);
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkManualCircle(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  worldScale: number,
  radiusMm: number
): number[] {
  const proposed: number[] = [];
  const dists = new Map<number, number>();
  
  interface DijkstraState {
    cost: number;
    face: number;
  }

  const queue: DijkstraState[] = [];
  if (map.faceNormals[seed].dot(localUp) <= 0.2) {
    dists.set(seed, 0);
    queue.push({ cost: 0, face: seed });

    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost);
      const { cost, face } = queue.shift()!;

      if (cost > radiusMm) continue;
      if (!proposed.includes(face)) {
        proposed.push(face);
      }

      const centroidCurr = map.faceCentroids[face];
      const adjs = map.faceToFaces[face];

      for (const adj of adjs) {
        if (map.faceNormals[adj].dot(localUp) <= 0.2) {
          const centroidAdj = map.faceCentroids[adj];
          const stepCost = centroidCurr.distanceTo(centroidAdj) * worldScale;
          const nextCost = cost + stepCost;

          const currentBest = dists.get(adj) ?? Infinity;
          if (nextCost < currentBest && nextCost <= radiusMm) {
            dists.set(adj, nextCost);
            queue.push({ cost: nextCost, face: adj });
          }
        }
      }
    }
  }

  return proposed.filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkManualSquare(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  worldScale: number,
  radiusMm: number
): number[] {
  const proposed: number[] = [];
  const dists = new Map<number, number>();
  
  const seedNormal = map.faceNormals[seed];
  const seedCentroid = map.faceCentroids[seed];
  
  if (seedNormal.dot(localUp) > 0.2) return [];

  // Construct local orthonormal tangent coordinate axes on the seed plane
  const tangentU = new THREE.Vector3(1, 0, 0).cross(seedNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(seedNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(seedNormal, tangentU).normalize();

  interface DijkstraState {
    cost: number;
    face: number;
  }

  const queue: DijkstraState[] = [];
  dists.set(seed, 0);
  queue.push({ cost: 0, face: seed });

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { cost, face } = queue.shift()!;

    if (cost > radiusMm * 1.414) continue; // Diagonal max bound guard

    // Project face centroid vector onto seed tangent plane
    const faceCentroid = map.faceCentroids[face];
    const diff = new THREE.Vector3().subVectors(faceCentroid, seedCentroid).multiplyScalar(worldScale);
    const du = diff.dot(tangentU);
    const dv = diff.dot(tangentV);

    // Apply square boundary clamp: |du| <= R and |dv| <= R
    if (Math.abs(du) <= radiusMm && Math.abs(dv) <= radiusMm) {
      if (!proposed.includes(face)) {
        proposed.push(face);
      }
    }

    const centroidCurr = map.faceCentroids[face];
    const adjs = map.faceToFaces[face];

    for (const adj of adjs) {
      if (map.faceNormals[adj].dot(localUp) <= 0.2) {
        const centroidAdj = map.faceCentroids[adj];
        const stepCost = centroidCurr.distanceTo(centroidAdj) * worldScale;
        const nextCost = cost + stepCost;

        const currentBest = dists.get(adj) ?? Infinity;
        if (nextCost < currentBest && nextCost <= radiusMm * 1.414) {
          dists.set(adj, nextCost);
          queue.push({ cost: nextCost, face: adj });
        }
      }
    }
  }

  return proposed.filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkRing(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  matrixWorld: THREE.Matrix4,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const queue: number[] = [];

  if (map.faceNormals[seed].dot(localUp) <= 0.2) {
    const seedCentroidWorld = map.faceCentroids[seed].clone().applyMatrix4(matrixWorld);
    const seedZ = seedCentroidWorld.z;

    const zTol = customBrush?.selection?.zHeightEnvelopeToleranceMm ?? 1.0;

    queue.push(seed);
    visited.add(seed);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const adjs = map.faceToFaces[curr];

      for (const adj of adjs) {
        if (!visited.has(adj)) {
          if (map.faceNormals[adj].dot(localUp) <= 0.2) {
            const adjCentroidWorld = map.faceCentroids[adj].clone().applyMatrix4(matrixWorld);
            if (adjCentroidWorld.z <= seedZ + zTol && adjCentroidWorld.z >= seedZ - zTol) {
              visited.add(adj);
              queue.push(adj);
            }
          }
        }
      }
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkMarkerShape(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  worldScale: number,
  radiusMm: number,
  shape: 'circle' | 'line' | 'rectangle' | 'square' | 'hexagon',
  rotationDeg: number,
  collisionMode: 'fence' | 'push' | 'merge',
  occupiedFaces?: Set<number>
): number[] {
  const proposed: number[] = [];
  const dists = new Map<number, number>();

  const seedNormal = map.faceNormals[seed];
  const seedCentroid = map.faceCentroids[seed];

  if (seedNormal.dot(localUp) > 0.2) return [];

  // Construct local orthonormal tangent coordinate axes on the seed plane
  const tangentU = new THREE.Vector3(1, 0, 0).cross(seedNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(seedNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(seedNormal, tangentU).normalize();

  // Rotation angles
  const theta = (rotationDeg * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  interface DijkstraState {
    cost: number;
    face: number;
  }

  const queue: DijkstraState[] = [];

  // Seed node check
  if (collisionMode === 'fence' && occupiedFaces?.has(seed)) {
    return [];
  }

  dists.set(seed, 0);
  queue.push({ cost: 0, face: seed });

  // Boundary check function
  const checkInside = (ru: number, rv: number): boolean => {
    switch (shape) {
      case 'circle':
        return ru * ru + rv * rv <= radiusMm * radiusMm;
      case 'line':
        return Math.abs(ru) <= radiusMm && Math.abs(rv) <= 0.25;
      case 'rectangle':
        return Math.abs(ru) <= radiusMm && Math.abs(rv) <= radiusMm * 0.5;
      case 'square':
        return Math.abs(ru) <= radiusMm && Math.abs(rv) <= radiusMm;
      case 'hexagon':
        return Math.abs(ru) <= radiusMm * 0.866 && (Math.abs(ru) * 0.5 + Math.abs(rv) * 0.866) <= radiusMm * 0.866;
      default:
        return false;
    }
  };

  // We set Dijkstra cost limit to radiusMm * 1.5 to guarantee corners are reached
  const maxDijkstraCost = radiusMm * 1.5;

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { cost, face } = queue.shift()!;

    if (cost > maxDijkstraCost) continue;

    // Project and check boundaries
    const faceCentroid = map.faceCentroids[face];
    const diff = new THREE.Vector3().subVectors(faceCentroid, seedCentroid).multiplyScalar(worldScale);
    const du = diff.dot(tangentU);
    const dv = diff.dot(tangentV);

    // Rotate
    const ru = du * cosTheta - dv * sinTheta;
    const rv = du * sinTheta + dv * cosTheta;

    if (checkInside(ru, rv)) {
      if (!proposed.includes(face)) {
        proposed.push(face);
      }
    }

    const centroidCurr = map.faceCentroids[face];
    const adjs = map.faceToFaces[face];

    for (const adj of adjs) {
      if (collisionMode === 'fence' && occupiedFaces?.has(adj)) {
        continue; // Blocked by fence
      }

      if (map.faceNormals[adj].dot(localUp) <= 0.2) {
        const centroidAdj = map.faceCentroids[adj];
        const stepCost = centroidCurr.distanceTo(centroidAdj) * worldScale;
        const nextCost = cost + stepCost;

        const currentBest = dists.get(adj) ?? Infinity;
        if (nextCost < currentBest && nextCost <= maxDijkstraCost) {
          dists.set(adj, nextCost);
          queue.push({ cost: nextCost, face: adj });
        }
      }
    }
  }

  return proposed.filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function insertSorted(queue: { cost: number; face: number }[], item: { cost: number; face: number }) {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (queue[mid].cost < item.cost) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  queue.splice(low, 0, item);
}

export function findDijkstraFacePath(
  map: ClientAdjacencyMap,
  startFace: number,
  endFace: number,
  worldScale: number
): number[] {
  if (startFace === endFace) return [startFace];

  const dists = new Map<number, number>();
  const prev = new Map<number, number>();

  interface PathState {
    cost: number;
    face: number;
  }

  const queue: PathState[] = [];
  dists.set(startFace, 0);
  queue.push({ cost: 0, face: startFace });

  while (queue.length > 0) {
    const { cost, face } = queue.shift()!;

    if (face === endFace) break;

    const currentBest = dists.get(face) ?? Infinity;
    if (cost > currentBest) continue;

    const centroidCurr = map.faceCentroids[face];
    const adjs = map.faceToFaces[face];

    for (const adj of adjs) {
      const centroidAdj = map.faceCentroids[adj];
      const stepCost = centroidCurr.distanceTo(centroidAdj) * worldScale;
      const nextCost = cost + stepCost;

      const adjBest = dists.get(adj) ?? Infinity;
      if (nextCost < adjBest) {
        dists.set(adj, nextCost);
        prev.set(adj, face);
        insertSorted(queue, { cost: nextCost, face: adj });
      }
    }
  }

  if (!prev.has(endFace)) {
    return [startFace, endFace];
  }

  const path: number[] = [];
  let curr: number | undefined = endFace;
  while (curr !== undefined) {
    path.push(curr);
    curr = prev.get(curr);
  }
  return path.reverse();
}

function smoothPointPath(
  map: ClientAdjacencyMap,
  path: number[]
): number[] {
  if (path.length < 3) return [...path];

  // 1. Extract 3D centroids
  const centroids = path.map(f => map.faceCentroids[f]);

  // 2. 1D sliding Gaussian filter
  const smoothedCentroids: THREE.Vector3[] = [];
  const w = 2; // window span
  const sigma = 1.0;
  const weights = [-2, -1, 0, 1, 2].map(j => Math.exp(-(j * j) / (2 * sigma * sigma)));
  const sumWeights = weights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < centroids.length; i++) {
    const sum = new THREE.Vector3();
    for (let j = -w; j <= w; j++) {
      const idx = Math.max(0, Math.min(centroids.length - 1, i + j));
      sum.addScaledVector(centroids[idx], weights[j + w]);
    }
    sum.divideScalar(sumWeights);
    smoothedCentroids.push(sum);
  }

  // 3. Local projection back to the mesh surface
  const candidateFaces = new Set<number>();
  for (const face of path) {
    candidateFaces.add(face);
    const neighbors = map.faceToFaces[face] || [];
    for (const n of neighbors) {
      candidateFaces.add(n);
    }
  }

  const smoothedPath: number[] = [];
  for (const smoothedPt of smoothedCentroids) {
    let bestFace = -1;
    let minDistSq = Infinity;
    for (const face of candidateFaces) {
      const distSq = map.faceCentroids[face].distanceToSquared(smoothedPt);
      if (distSq < minDistSq) {
        minDistSq = distSq;
        bestFace = face;
      }
    }
    if (bestFace !== -1) {
      smoothedPath.push(bestFace);
    }
  }

  return smoothedPath;
}

export function walkPointPathLine(
  map: ClientAdjacencyMap,
  points: number[],
  widthMm: number,
  localUp: THREE.Vector3,
  worldScale: number
): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    return walkManualCircle(map, points[0], localUp, worldScale, widthMm * 0.5);
  }

  const rawPath: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const segment = findDijkstraFacePath(map, points[i], points[i + 1], worldScale);
    for (const face of segment) {
      if (rawPath.length === 0 || rawPath[rawPath.length - 1] !== face) {
        rawPath.push(face);
      }
    }
  }

  const smoothedPath = smoothPointPath(map, rawPath);
  const skeleton = new Set<number>(smoothedPath);

  const radiusMm = widthMm * 0.5;
  const proposed: number[] = [];
  const dists = new Map<number, number>();

  interface DijkstraState {
    cost: number;
    face: number;
  }

  const queue: DijkstraState[] = [];

  for (const face of skeleton) {
    dists.set(face, 0);
    insertSorted(queue, { cost: 0, face });
  }

  while (queue.length > 0) {
    const { cost, face } = queue.shift()!;

    if (cost > radiusMm) continue;
    if (!proposed.includes(face)) {
      proposed.push(face);
    }

    const centroidCurr = map.faceCentroids[face];
    const adjs = map.faceToFaces[face];

    for (const adj of adjs) {
      const centroidAdj = map.faceCentroids[adj];
      const stepCost = centroidCurr.distanceTo(centroidAdj) * worldScale;
      const nextCost = cost + stepCost;

      const currentBest = dists.get(adj) ?? Infinity;
      if (nextCost < currentBest && nextCost <= radiusMm) {
        dists.set(adj, nextCost);
        insertSorted(queue, { cost: nextCost, face: adj });
      }
    }
  }

  return proposed;
}

export function walkPointPathPolygon(
  map: ClientAdjacencyMap,
  points: number[],
  localUp: THREE.Vector3,
  worldScale: number
): number[] {
  if (points.length === 0) return [];
  if (points.length < 3) {
    return walkPointPathLine(map, points, 2.0, localUp, worldScale);
  }

  const rawPath: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const nextIdx = (i + 1) % points.length;
    const segment = findDijkstraFacePath(map, points[i], points[nextIdx], worldScale);
    for (const face of segment) {
      if (rawPath.length === 0 || rawPath[rawPath.length - 1] !== face) {
        rawPath.push(face);
      }
    }
  }

  // Ensure it is closed
  if (rawPath.length > 0 && rawPath[0] !== rawPath[rawPath.length - 1]) {
    rawPath.push(rawPath[0]);
  }

  const boundary = new Set<number>(rawPath);
  const boundaryList = Array.from(boundary);

  const firstSeed = points[0];
  const seedNormal = map.faceNormals[firstSeed];

  const tangentU = new THREE.Vector3(1, 0, 0).cross(seedNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(seedNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(seedNormal, tangentU).normalize();

  const seedCentroid = map.faceCentroids[firstSeed];

  const projected2D: { u: number; v: number }[] = points.map((face) => {
    const rel = new THREE.Vector3().subVectors(map.faceCentroids[face], seedCentroid);
    return {
      u: rel.dot(tangentU),
      v: rel.dot(tangentV),
    };
  });

  let sumU = 0, sumV = 0;
  for (const pt of projected2D) {
    sumU += pt.u;
    sumV += pt.v;
  }
  const avgU = sumU / projected2D.length;
  const avgV = sumV / projected2D.length;

  const isPointInPolygon = (u: number, v: number, poly: { u: number; v: number }[]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].u, yi = poly[i].v;
      const xj = poly[j].u, yj = poly[j].v;
      const intersect = ((yi > v) !== (yj > v)) && (u < (xj - xi) * (v - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  // 2D Point-in-Triangle test using Barycentric Coordinates
  const pointInTriangle2D = (
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
  ): { in: boolean } => {
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
      return { in: false };
    }
    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return {
      in: u >= -1e-5 && v >= -1e-5 && (u + v) <= 1 + 1e-5,
    };
  };

  // Helper for segment intersection
  const lineSegmentsIntersect = (
    p1: { u: number; v: number }, q1: { u: number; v: number },
    p2: { u: number; v: number }, q2: { u: number; v: number }
  ): boolean => {
    const det = (q1.u - p1.u) * (q2.v - p2.v) - (q2.u - p2.u) * (q1.v - p1.v);
    if (Math.abs(det) < 1e-8) return false;
    const t = ((p2.u - p1.u) * (q2.v - p2.v) - (q2.u - p2.u) * (p2.v - p1.v)) / det;
    const u = ((p2.u - p1.u) * (q1.v - p1.v) - (q1.u - p1.u) * (p2.v - p1.v)) / det;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };

  // Helper for triangle-polygon overlap
  const triangleOverlapsPolygon = (
    tu0: number, tv0: number,
    tu1: number, tv1: number,
    tu2: number, tv2: number,
    poly: { u: number; v: number }[]
  ): boolean => {
    // 1. Any triangle vertex is inside the polygon
    if (isPointInPolygon(tu0, tv0, poly)) return true;
    if (isPointInPolygon(tu1, tv1, poly)) return true;
    if (isPointInPolygon(tu2, tv2, poly)) return true;

    // 2. Any polygon vertex is inside the triangle
    for (const pv of poly) {
      const res = pointInTriangle2D(pv.u, pv.v, tu0, tv0, tu1, tv1, tu2, tv2);
      if (res.in) return true;
    }

    // 3. Any triangle edge intersects any polygon edge
    const tVerts = [
      { u: tu0, v: tv0 },
      { u: tu1, v: tv1 },
      { u: tu2, v: tv2 }
    ];
    for (let i = 0; i < 3; i++) {
      const tp1 = tVerts[i];
      const tp2 = tVerts[(i + 1) % 3];
      for (let j = 0; j < poly.length; j++) {
        const pp1 = poly[j];
        const pp2 = poly[(j + 1) % poly.length];
        if (lineSegmentsIntersect(tp1, tp2, pp1, pp2)) return true;
      }
    }

    return false;
  };

  const minU = Math.min(...projected2D.map(p => p.u));
  const maxU = Math.max(...projected2D.map(p => p.u));
  const minV = Math.min(...projected2D.map(p => p.v));
  const maxV = Math.max(...projected2D.map(p => p.v));

  // Run a localized BFS search starting from boundaryList to gather candidate faces within the bounding box
  const candidateFaces = new Set<number>(boundaryList);
  const scanQueue: number[] = [...boundaryList];
  const scanVisited = new Set<number>(boundaryList);

  while (scanQueue.length > 0) {
    const curr = scanQueue.shift()!;
    const adjs = map.faceToFaces[curr] || [];
    for (const adj of adjs) {
      if (!scanVisited.has(adj)) {
        scanVisited.add(adj);
        const rel = new THREE.Vector3().subVectors(map.faceCentroids[adj], seedCentroid);
        const u = rel.dot(tangentU);
        const v = rel.dot(tangentV);
        // Bounding box filter (with 2.0mm safety margin to ensure no boundary faces are clipped)
        if (u >= minU - 2.0 && u <= maxU + 2.0 && v >= minV - 2.0 && v <= maxV + 2.0) {
          scanQueue.push(adj);
          candidateFaces.add(adj);
        }
      }
    }
  }

  const finalFaces: number[] = [];
  for (const face of candidateFaces) {
    // Project the 3 vertices of the face
    const positions = map.positions;
    if (!positions) {
      finalFaces.push(face);
      continue;
    }
    
    // Retrieve vertices in local space
    const v0 = new THREE.Vector3(positions[face * 9], positions[face * 9 + 1], positions[face * 9 + 2]);
    const v1 = new THREE.Vector3(positions[face * 9 + 3], positions[face * 9 + 4], positions[face * 9 + 5]);
    const v2 = new THREE.Vector3(positions[face * 9 + 6], positions[face * 9 + 7], positions[face * 9 + 8]);

    const rel0 = new THREE.Vector3().subVectors(v0, seedCentroid);
    const rel1 = new THREE.Vector3().subVectors(v1, seedCentroid);
    const rel2 = new THREE.Vector3().subVectors(v2, seedCentroid);

    const tu0 = rel0.dot(tangentU), tv0 = rel0.dot(tangentV);
    const tu1 = rel1.dot(tangentU), tv1 = rel1.dot(tangentV);
    const tu2 = rel2.dot(tangentU), tv2 = rel2.dot(tangentV);

    if (triangleOverlapsPolygon(tu0, tv0, tu1, tv1, tu2, tv2, projected2D)) {
      finalFaces.push(face);
    }
  }

  return finalFaces;
}

function getOrComputeMacroNormals(
  map: ClientAdjacencyMap,
  iterations: number,
  lambda: number
): THREE.Vector3[] {
  if (!map._macroNormalsFlatCache) {
    map._macroNormalsFlatCache = new Map<number, Float32Array>();
  }
  if (!map.macroNormalsCache) {
    map.macroNormalsCache = new Map<number, THREE.Vector3[]>();
  }
  const cachedProxy = map.macroNormalsCache.get(iterations);
  if (cachedProxy) return cachedProxy;

  const count = map.faceCount;
  
  let faceNormalsFlat = map.faceNormalsFlat;
  if (!faceNormalsFlat && map.faceNormals) {
    faceNormalsFlat = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const n = map.faceNormals[i];
      if (n) {
        faceNormalsFlat[i * 3] = n.x;
        faceNormalsFlat[i * 3 + 1] = n.y;
        faceNormalsFlat[i * 3 + 2] = n.z;
      }
    }
  }
  if (!faceNormalsFlat) {
    faceNormalsFlat = new Float32Array(count * 3);
  }

  let faceToFacesFlat = map.faceToFacesFlat;
  if (!faceToFacesFlat && map.faceToFaces) {
    faceToFacesFlat = new Int32Array(count * 3).fill(-1);
    for (let i = 0; i < count; i++) {
      const adjs = map.faceToFaces[i];
      if (adjs) {
        if (adjs.length > 0) faceToFacesFlat[i * 3] = adjs[0];
        if (adjs.length > 1) faceToFacesFlat[i * 3 + 1] = adjs[1];
        if (adjs.length > 2) faceToFacesFlat[i * 3 + 2] = adjs[2];
      }
    }
  }

  const normals = new Float32Array(faceNormalsFlat);
  const temp = new Float32Array(count * 3);

  for (let iter = 0; iter < iterations; iter++) {
    temp.set(normals);

    for (let i = 0; i < count; i++) {
      const startAdj = i * 3;
      let adj0 = -1, adj1 = -1, adj2 = -1;
      if (faceToFacesFlat) {
        adj0 = faceToFacesFlat[startAdj];
        adj1 = faceToFacesFlat[startAdj + 1];
        adj2 = faceToFacesFlat[startAdj + 2];
      } else {
        const adjs = map.faceToFaces[i];
        if (adjs) {
          if (adjs.length > 0) adj0 = adjs[0];
          if (adjs.length > 1) adj1 = adjs[1];
          if (adjs.length > 2) adj2 = adjs[2];
        }
      }

      let adjCount = 0;
      let sumX = 0, sumY = 0, sumZ = 0;

      if (adj0 !== -1) {
        sumX += temp[adj0 * 3];
        sumY += temp[adj0 * 3 + 1];
        sumZ += temp[adj0 * 3 + 2];
        adjCount++;
      }
      if (adj1 !== -1) {
        sumX += temp[adj1 * 3];
        sumY += temp[adj1 * 3 + 1];
        sumZ += temp[adj1 * 3 + 2];
        adjCount++;
      }
      if (adj2 !== -1) {
        sumX += temp[adj2 * 3];
        sumY += temp[adj2 * 3 + 1];
        sumZ += temp[adj2 * 3 + 2];
        adjCount++;
      }

      if (adjCount === 0) continue;

      const avgX = sumX / adjCount;
      const avgY = sumY / adjCount;
      const avgZ = sumZ / adjCount;

      const currX = temp[i * 3];
      const currY = temp[i * 3 + 1];
      const currZ = temp[i * 3 + 2];

      let nx = currX + (avgX - currX) * lambda;
      let ny = currY + (avgY - currY) * lambda;
      let nz = currZ + (avgZ - currZ) * lambda;

      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      }

      normals[i * 3] = nx;
      normals[i * 3 + 1] = ny;
      normals[i * 3 + 2] = nz;
    }
  }

  map._macroNormalsFlatCache.set(iterations, normals);

  const cachedVectors = new Array(count);
  const proxy = new Proxy(new Array(count).fill(undefined), {
    get(target, prop) {
      if (prop === 'length') return count;
      const idx = Number(prop);
      if (isNaN(idx) || idx < 0 || idx >= count) return (target as any)[prop];

      let vec = cachedVectors[idx];
      if (vec === undefined) {
        vec = new THREE.Vector3(
          normals[idx * 3],
          normals[idx * 3 + 1],
          normals[idx * 3 + 2]
        );
        cachedVectors[idx] = vec;
      }
      return vec;
    }
  }) as any;

  map.macroNormalsCache.set(iterations, proxy);
  return proxy;
}

export function walkSharpCorner(
  map: ClientAdjacencyMap,
  geometry: THREE.BufferGeometry,
  seedFaceIndex: number,
  seedPointWorld: THREE.Vector3,
  matrixWorld: THREE.Matrix4,
  dihedralThresholdDeg: number,
  wrapCurves: boolean
): { point: [number, number, number]; normal?: [number, number, number]; faceIndex?: number }[] {
  const invMatrixWorld = new THREE.Matrix4().copy(matrixWorld).invert();
  const seedPointLocal = seedPointWorld.clone().applyMatrix4(invMatrixWorld);

  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!positionAttr) return [];
  const positions = positionAttr.array;
  const faceCount = positionAttr.count / 3;

  interface EdgeInfo {
    id: string;
    v0: number;
    v1: number;
    faces: number[];
  }

  let topology = map._topology;
  if (!topology) {
    const vertexMap = new Map<string, number>();
    const vertexPositions: THREE.Vector3[] = [];

    const getVertexId = (x: number, y: number, z: number): number => {
      const key = `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
      let id = vertexMap.get(key);
      if (id === undefined) {
        id = vertexPositions.length;
        vertexMap.set(key, id);
        vertexPositions.push(new THREE.Vector3(x, y, z));
      }
      return id;
    };

    const faceVertices: [number, number, number][] = [];
    for (let f = 0; f < faceCount; f++) {
      const o = f * 9;
      const v0 = getVertexId(positions[o], positions[o + 1], positions[o + 2]);
      const v1 = getVertexId(positions[o + 3], positions[o + 4], positions[o + 5]);
      const v2 = getVertexId(positions[o + 6], positions[o + 7], positions[o + 8]);
      faceVertices.push([v0, v1, v2]);
    }

    const edgeMap = new Map<string, EdgeInfo>();
    const vertexEdges = Array.from({ length: vertexPositions.length }, () => new Set<string>());

    const addFaceEdge = (v0: number, v1: number, faceIdx: number) => {
      const minV = Math.min(v0, v1);
      const maxV = Math.max(v0, v1);
      const key = `${minV}_${maxV}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { id: key, v0: minV, v1: maxV, faces: [] };
        edgeMap.set(key, edge);
        vertexEdges[minV].add(key);
        vertexEdges[maxV].add(key);
      }
      if (!edge.faces.includes(faceIdx)) {
        edge.faces.push(faceIdx);
      }
    };

    for (let f = 0; f < faceCount; f++) {
      const [v0, v1, v2] = faceVertices[f];
      addFaceEdge(v0, v1, f);
      addFaceEdge(v1, v2, f);
      addFaceEdge(v2, v0, f);
    }

    topology = {
      vertexPositions,
      faceVertices,
      edgeMap,
      vertexEdges,
    };
    map._topology = topology;
  }

  const { vertexPositions, faceVertices, edgeMap, vertexEdges } = topology;

  const getEdgeDihedral = (edge: EdgeInfo): number => {
    if (edge.faces.length === 0) return 0;
    if (edge.faces.length === 1) {
      return Math.PI;
    }
    let maxAngle = 0;
    for (let i = 0; i < edge.faces.length; i++) {
      for (let j = i + 1; j < edge.faces.length; j++) {
        const n1 = map.faceNormals[edge.faces[i]];
        const n2 = map.faceNormals[edge.faces[j]];
        if (n1 && n2) {
          const angle = n1.angleTo(n2);
          if (angle > maxAngle) maxAngle = angle;
        }
      }
    }
    return maxAngle;
  };

  const dihedralThresholdRad = dihedralThresholdDeg * Math.PI / 180;
  const minorThresholdRad = 25 * Math.PI / 180;

  const isCreaseEdge = (edge: EdgeInfo): boolean => {
    return getEdgeDihedral(edge) >= dihedralThresholdRad;
  };

  if (seedFaceIndex < 0 || seedFaceIndex >= faceCount) return [];
  const seedFace = faceVertices[seedFaceIndex];
  const seedFaceEdges = [
    `${Math.min(seedFace[0], seedFace[1])}_${Math.max(seedFace[0], seedFace[1])}`,
    `${Math.min(seedFace[1], seedFace[2])}_${Math.max(seedFace[1], seedFace[2])}`,
    `${Math.min(seedFace[2], seedFace[0])}_${Math.max(seedFace[2], seedFace[0])}`,
  ];

  let bestEdgeKey: string | null = null;
  let bestDist = Infinity;

  const getDistanceToSegment = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number => {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(p, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq < 1e-8) return p.distanceTo(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const proj = a.clone().addScaledVector(ab, t);
    return p.distanceTo(proj);
  };

  for (const ek of seedFaceEdges) {
    const edge = edgeMap.get(ek);
    if (edge) {
      const dist = getDistanceToSegment(seedPointLocal, vertexPositions[edge.v0], vertexPositions[edge.v1]);
      if (dist < bestDist) {
        bestDist = dist;
        bestEdgeKey = ek;
      }
    }
  }

  if (bestEdgeKey) {
    const edge = edgeMap.get(bestEdgeKey)!;
    if (!isCreaseEdge(edge)) {
      let maxD = -1;
      let chosenKey = bestEdgeKey;
      for (const ek of seedFaceEdges) {
        const eInfo = edgeMap.get(ek);
        if (eInfo) {
          const d = getEdgeDihedral(eInfo);
          if (d > maxD) {
            maxD = d;
            chosenKey = ek;
          }
        }
      }
      bestEdgeKey = chosenKey;
    }
  }

  if (!bestEdgeKey) return [];
  const startEdge = edgeMap.get(bestEdgeKey)!;
  if (!isCreaseEdge(startEdge)) {
    return [];
  }

  const pathA: number[] = [startEdge.v0];
  const pathB: number[] = [startEdge.v1];
  const visitedVertices = new Set<number>([startEdge.v0, startEdge.v1]);

  const propagate = (path: number[], initialPrev: number) => {
    let curr = path[path.length - 1];
    let prev = initialPrev;

    while (true) {
      const connectedEdges = Array.from(vertexEdges[curr]).map(ek => edgeMap.get(ek)!).filter(Boolean);
      const candidates = connectedEdges.filter(e => !(e.v0 === curr && e.v1 === prev) && !(e.v0 === prev && e.v1 === curr));

      const creaseCandidates = candidates.filter(e => isCreaseEdge(e));
      if (creaseCandidates.length === 0) break;

      let filtered = creaseCandidates;
      if (creaseCandidates.length > 1) {
        filtered = creaseCandidates.filter(e => getEdgeDihedral(e) >= minorThresholdRad);
        if (filtered.length === 0) {
          filtered = creaseCandidates;
        }
      }

      let nextEdge: EdgeInfo | null = null;

      if (filtered.length === 1) {
        nextEdge = filtered[0];
      } else if (filtered.length > 1) {
        if (wrapCurves) {
          const dirCurr = new THREE.Vector3().subVectors(vertexPositions[curr], vertexPositions[prev]).normalize();
          let bestAlign = -Infinity;
          let bestCandidate: EdgeInfo | null = null;
          for (const e of filtered) {
            const nextV = e.v0 === curr ? e.v1 : e.v0;
            const dirNext = new THREE.Vector3().subVectors(vertexPositions[nextV], vertexPositions[curr]).normalize();
            const align = dirNext.dot(dirCurr);
            if (align > bestAlign) {
              bestAlign = align;
              bestCandidate = e;
            }
          }
          if (bestCandidate && bestAlign >= 0.5) {
            nextEdge = bestCandidate;
          }
        }
      }

      if (!nextEdge) break;

      const nextV = nextEdge.v0 === curr ? nextEdge.v1 : nextEdge.v0;
      if (visitedVertices.has(nextV)) {
        path.push(nextV);
        break;
      }

      path.push(nextV);
      visitedVertices.add(nextV);
      prev = curr;
      curr = nextV;
    }
  };

  propagate(pathA, startEdge.v1);
  propagate(pathB, startEdge.v0);

  const combinedPath = [...pathA].reverse().concat(pathB);
  const result: { point: [number, number, number]; normal?: [number, number, number]; faceIndex?: number }[] = [];

  for (let i = 0; i < combinedPath.length; i++) {
    const vIdx = combinedPath[i];
    const pt = vertexPositions[vIdx];

    const connectedEdges = Array.from(vertexEdges[vIdx]).map(ek => edgeMap.get(ek)!).filter(Boolean);
    const creaseEdges = connectedEdges.filter(e => isCreaseEdge(e));
    
    const faceIndices = new Set<number>();
    for (const ce of creaseEdges) {
      for (const f of ce.faces) {
        faceIndices.add(f);
      }
    }
    if (faceIndices.size === 0) {
      for (const ce of connectedEdges) {
        for (const f of ce.faces) {
          faceIndices.add(f);
        }
      }
    }

    const avgNormal = new THREE.Vector3();
    for (const f of faceIndices) {
      const fNorm = map.faceNormals[f];
      if (fNorm) avgNormal.add(fNorm);
    }
    if (faceIndices.size > 0) {
      avgNormal.normalize();
    } else {
      avgNormal.set(0, 0, 1);
    }

    const firstFaceIndex = faceIndices.size > 0 ? Array.from(faceIndices)[0] : seedFaceIndex;

    result.push({
      point: [pt.x, pt.y, pt.z],
      normal: [avgNormal.x, avgNormal.y, avgNormal.z],
      faceIndex: firstFaceIndex
    });
  }

  return result;
}

function projectPointToFacePath(
  map: ClientAdjacencyMap,
  facePath: number[],
  q: THREE.Vector3,
  tri: THREE.Triangle,
  outPoint: THREE.Vector3,
  outNormal: THREE.Vector3
): number {
  let bestFace = facePath[0];
  let bestDistSq = Infinity;
  const tempPt = new THREE.Vector3();
  const positions = map.positions;

  for (const faceIdx of facePath) {
    if (!positions) {
      const centroid = map.faceCentroids[faceIdx];
      const distSq = q.distanceToSquared(centroid);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        outPoint.copy(centroid);
        const normal = map.faceNormals[faceIdx];
        if (normal) outNormal.copy(normal);
        bestFace = faceIdx;
      }
      continue;
    }

    const o = faceIdx * 9;
    tri.a.set(positions[o], positions[o+1], positions[o+2]);
    tri.b.set(positions[o+3], positions[o+4], positions[o+5]);
    tri.c.set(positions[o+6], positions[o+7], positions[o+8]);

    tri.closestPointToPoint(q, tempPt);
    const distSq = q.distanceToSquared(tempPt);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      outPoint.copy(tempPt);
      const normal = map.faceNormals[faceIdx];
      if (normal) outNormal.copy(normal);
      bestFace = faceIdx;
    }
  }
  return bestFace;
}

export function expandPathWithDijkstra(
  map: ClientAdjacencyMap,
  controlPoints: { point: [number, number, number]; faceIndex: number; normal?: [number, number, number] }[],
  isClosed: boolean
): { point: [number, number, number]; faceIndex: number; normal: [number, number, number] | undefined }[] {
  if (controlPoints.length === 0) return [];
  if (controlPoints.length === 1) {
    const cp = controlPoints[0];
    return [{
      point: cp.point,
      faceIndex: cp.faceIndex,
      normal: cp.normal || [map.faceNormals[cp.faceIndex].x, map.faceNormals[cp.faceIndex].y, map.faceNormals[cp.faceIndex].z]
    }];
  }

  const expanded: { point: [number, number, number]; faceIndex: number; normal: [number, number, number] | undefined }[] = [];
  const tri = new THREE.Triangle();
  const outPt = new THREE.Vector3();
  const outNorm = new THREE.Vector3();

  const numSegments = isClosed && controlPoints.length >= 3 ? controlPoints.length : controlPoints.length - 1;

  for (let i = 0; i < numSegments; i++) {
    const cp0 = controlPoints[i];
    const cp1 = controlPoints[(i + 1) % controlPoints.length];

    const facePath = findDijkstraFacePath(map, cp0.faceIndex, cp1.faceIndex, 1.0);
    
    const p0 = new THREE.Vector3(...cp0.point);
    const p1 = new THREE.Vector3(...cp1.point);
    const distance = p0.distanceTo(p1);
    
    // sample points along segment every 0.25mm
    const numSamples = Math.max(2, Math.ceil(distance / 0.25));

    for (let s = 0; s < numSamples; s++) {
      const t = s / numSamples;
      const q = new THREE.Vector3().lerpVectors(p0, p1, t);
      
      const faceIdx = projectPointToFacePath(map, facePath, q, tri, outPt, outNorm);
      
      expanded.push({
        point: [outPt.x, outPt.y, outPt.z],
        faceIndex: faceIdx,
        normal: [outNorm.x, outNorm.y, outNorm.z]
      });
    }
  }

  // If not closed, append the last control point exactly
  if (!isClosed) {
    const lastCp = controlPoints[controlPoints.length - 1];
    expanded.push({
      point: lastCp.point,
      faceIndex: lastCp.faceIndex,
      normal: lastCp.normal || [map.faceNormals[lastCp.faceIndex].x, map.faceNormals[lastCp.faceIndex].y, map.faceNormals[lastCp.faceIndex].z]
    });
  }

  return expanded;
}
