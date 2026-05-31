import * as THREE from 'three';
import { BrushType, CustomBrushTemplate } from './supportPainterTypes';

export interface ClientAdjacencyMap {
  faceCount: number;
  faceToFaces: number[][];
  faceNormals: THREE.Vector3[];
  faceCentroids: THREE.Vector3[];
  faceZBounds: { min: number; max: number }[];
}

/**
 * Builds a high-performance face adjacency map and spatial cache on the client side
 * directly from the Three.js BufferGeometry, in LOCAL SPACE to ensure 100% robustness
 * against transform timing, scales, and rotation states.
 */
export function buildClientAdjacencyMap(geometry: THREE.BufferGeometry): ClientAdjacencyMap {
  let geom = geometry;
  let needsDispose = false;

  if (geometry.index) {
    console.log('[useClientAdjacencyMap] Converting indexed geometry to non-indexed for accurate adjacency map building');
    try {
      geom = geometry.toNonIndexed();
      needsDispose = true;
    } catch (err) {
      console.error('[useClientAdjacencyMap] Failed to convert indexed geometry to non-indexed', err);
    }
  }

  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
  if (!posAttr) {
    if (needsDispose) geom.dispose();
    return { faceCount: 0, faceToFaces: [], faceNormals: [], faceCentroids: [], faceZBounds: [] };
  }
  const positions = posAttr.array;
  const faceCount = posAttr.count / 3;

  const faceToFaces: number[][] = Array.from({ length: faceCount }, () => []);
  const faceNormals: THREE.Vector3[] = [];
  const faceCentroids: THREE.Vector3[] = [];
  const faceZBounds: { min: number; max: number }[] = [];

  // Quantization key for vertex welding (5 decimal places, 1e-5 mm tolerance)
  const vertexToFacesMap = new Map<string, number[]>();

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();

  const getVertexKey = (x: number, y: number, z: number): string => {
    return `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
  };

  for (let f = 0; f < faceCount; f++) {
    const o = f * 9;
    v0.set(positions[o], positions[o + 1], positions[o + 2]);
    v1.set(positions[o + 3], positions[o + 4], positions[o + 5]);
    v2.set(positions[o + 6], positions[o + 7], positions[o + 8]);

    // 1. Centroid
    const centroid = new THREE.Vector3(
      (v0.x + v1.x + v2.x) / 3,
      (v0.y + v1.y + v2.y) / 3,
      (v0.z + v1.z + v2.z) / 3
    );
    faceCentroids.push(centroid);

    // 2. Normal
    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
    faceNormals.push(normal);

    // 3. Z Bounds
    const minZ = Math.min(v0.z, v1.z, v2.z);
    const maxZ = Math.max(v0.z, v1.z, v2.z);
    faceZBounds.push({ min: minZ, max: maxZ });

    // 4. Welding index
    const k0 = getVertexKey(v0.x, v0.y, v0.z);
    const k1 = getVertexKey(v1.x, v1.y, v1.z);
    const k2 = getVertexKey(v2.x, v2.y, v2.z);

    for (const key of [k0, k1, k2]) {
      let list = vertexToFacesMap.get(key);
      if (!list) {
        list = [];
        vertexToFacesMap.set(key, list);
      }
      list.push(f);
    }
  }

  // Build Face-to-Face Adjacency (faces sharing at least 2 coincident vertices)
  const sharedCounts = new Map<number, number>();

  for (let f = 0; f < faceCount; f++) {
    const o = f * 9;
    v0.set(positions[o], positions[o + 1], positions[o + 2]);
    v1.set(positions[o + 3], positions[o + 4], positions[o + 5]);
    v2.set(positions[o + 6], positions[o + 7], positions[o + 8]);

    const k0 = getVertexKey(v0.x, v0.y, v0.z);
    const k1 = getVertexKey(v1.x, v1.y, v1.z);
    const k2 = getVertexKey(v2.x, v2.y, v2.z);

    sharedCounts.clear();
    for (const key of [k0, k1, k2]) {
      const list = vertexToFacesMap.get(key) || [];
      for (const other of list) {
        if (other === f) continue;
        sharedCounts.set(other, (sharedCounts.get(other) || 0) + 1);
      }
    }

    for (const [other, count] of sharedCounts.entries()) {
      if (count >= 2) {
        faceToFaces[f].push(other);
      }
    }
  }

  if (needsDispose) {
    geom.dispose();
  }

  return {
    faceCount,
    faceToFaces,
    faceNormals,
    faceCentroids,
    faceZBounds,
  };
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
      if (pointPathParams && pointPathParams.points.length > 0) {
        const pts = pointPathParams.points.map((p) => p.faceIndex);
        if (seedFaceIndex >= 0 && seedFaceIndex < map.faceCount && !pointPathParams.closed) {
          pts.push(seedFaceIndex);
        }
        if (pointPathParams.mode === 'line') {
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

function walkMacroFace(
  map: ClientAdjacencyMap,
  seed: number,
  localUp: THREE.Vector3,
  customBrush?: CustomBrushTemplate
): number[] {
  const visited = new Set<number>();
  const queue: number[] = [seed];
  visited.add(seed);

  const seedNormal = map.faceNormals[seed];
  const selection = customBrush?.selection;
  const degToRad = Math.PI / 180;
  const localDown = new THREE.Vector3().copy(localUp).negate();

  const enableSlope = selection?.enableSlopeLimit ?? true;
  const enableNormalCone = selection?.enableNormalConeLimit ?? true;
  const enableDihedral = selection?.enableDihedralLimit ?? true;
  const enableCurvature = selection?.enableCurvatureLimit ?? false;

  // Overhang slope check for seed
  if (selection) {
    if (enableSlope) {
      const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
      const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
      const seedSlope = seedNormal.angleTo(localDown);
      if (seedSlope < minSlopeRad || seedSlope > maxSlopeRad) return [];
    }
  } else {
    if (seedNormal.dot(localUp) > 0.2) return [];
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const adjs = map.faceToFaces[curr];

    for (const adj of adjs) {
      if (!visited.has(adj)) {
        const nAdj = map.faceNormals[adj];
        
        let slopeOk = false;
        if (selection) {
          if (enableSlope) {
            const minSlopeRad = selection.overhangSlopeMinDeg * degToRad;
            const maxSlopeRad = selection.overhangSlopeMaxDeg * degToRad;
            const adjSlope = nAdj.angleTo(localDown);
            slopeOk = adjSlope >= minSlopeRad && adjSlope <= maxSlopeRad;
          } else {
            slopeOk = true;
          }
        } else {
          slopeOk = nAdj.dot(localUp) <= 0.2;
        }

        if (slopeOk) {
          const normalDeviation = seedNormal.angleTo(nAdj);
          const nCurr = map.faceNormals[curr];
          const edgeDihedral = nCurr.angleTo(nAdj);

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
            // 35 deg = 0.61 rad, 25 deg = 0.43 rad
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
        const slope = map.faceNormals[idx].angleTo(localDown);
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

  const getPeakCurvature = (f: number): { neighborIdx: number; angle: number } => {
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
    return { neighborIdx, angle: maxAngle };
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
  const getLocalNormalVariance = (f: number): number => {
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
    return count > 0 ? varianceSum / count : 0;
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

  const getPeakCurvature = (f: number): { neighborIdx: number; angle: number } => {
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
    return { neighborIdx, angle: maxAngle };
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

  const smoothedPath = smoothPointPath(map, rawPath);
  const boundary = new Set<number>(smoothedPath);

  const firstSeed = points[0];
  const seedNormal = map.faceNormals[firstSeed];

  const tangentU = new THREE.Vector3(1, 0, 0).cross(seedNormal);
  if (tangentU.lengthSq() < 1e-4) {
    tangentU.copy(new THREE.Vector3(0, 1, 0).cross(seedNormal));
  }
  tangentU.normalize();
  const tangentV = new THREE.Vector3().crossVectors(seedNormal, tangentU).normalize();

  const seedCentroid = map.faceCentroids[firstSeed];

  const boundaryList = Array.from(boundary);
  const projected2D: { u: number; v: number }[] = boundaryList.map((face) => {
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

  let interiorSeed = -1;
  let bestDistSq = Infinity;

  const checkFaces = new Set<number>();
  const scanQueue: number[] = [...boundaryList];
  const scanVisited = new Set<number>(boundaryList);

  let ringsScanned = 0;
  while (scanQueue.length > 0 && ringsScanned < 15) {
    const levelSize = scanQueue.length;
    for (let l = 0; l < levelSize; l++) {
      const curr = scanQueue.shift()!;
      const adjs = map.faceToFaces[curr];
      for (const adj of adjs) {
        if (!scanVisited.has(adj)) {
          scanVisited.add(adj);
          scanQueue.push(adj);
          checkFaces.add(adj);
        }
      }
    }
    ringsScanned++;
  }

  for (const face of checkFaces) {
    const rel = new THREE.Vector3().subVectors(map.faceCentroids[face], seedCentroid);
    const u = rel.dot(tangentU);
    const v = rel.dot(tangentV);

    if (isPointInPolygon(u, v, projected2D)) {
      const distSq = (u - avgU) * (u - avgU) + (v - avgV) * (v - avgV);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        interiorSeed = face;
      }
    }
  }

  if (interiorSeed === -1) {
    return boundaryList;
  }

  const filled = new Set<number>(boundary);
  const fillQueue: number[] = [interiorSeed];
  filled.add(interiorSeed);

  const maxFillCount = Math.max(1000, map.faceCount * 0.20);
  let failed = false;

  while (fillQueue.length > 0) {
    const curr = fillQueue.shift()!;
    if (filled.size > maxFillCount) {
      failed = true;
      break;
    }

    const adjs = map.faceToFaces[curr];
    for (const adj of adjs) {
      if (!filled.has(adj)) {
        filled.add(adj);
        fillQueue.push(adj);
      }
    }
  }

  if (failed) {
    return boundaryList;
  }

  return Array.from(filled);
}
