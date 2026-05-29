import * as THREE from 'three';
import { BrushType } from './supportPainterTypes';

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
  brushRadiusMm: number = 4.0
): number[] {
  if (seedFaceIndex < 0 || seedFaceIndex >= map.faceCount) return [];

  // Compute local up vector and world scale on-the-fly from the live matrixWorld
  const inv = new THREE.Matrix4().copy(matrixWorld).invert();
  const localUp = new THREE.Vector3(0, 0, 1).transformDirection(inv);

  const scale = new THREE.Vector3();
  matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  const worldScale = (scale.x + scale.y + scale.z) / 3;

  switch (brushType) {
    case 'MacroFace':
      return walkMacroFace(map, seedFaceIndex, localUp);
    case 'Ridge':
      return walkRidge(map, seedFaceIndex, localUp);
    case 'CylinderSides':
      return walkCylinderSides(map, seedFaceIndex, localUp);
    case 'CylinderMinima':
      return walkCylinderMinima(map, seedFaceIndex, localUp);
    case 'Point':
      return walkManualCircle(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'ManualCircle':
      return walkManualCircle(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'ManualSquare':
      return walkManualSquare(map, seedFaceIndex, localUp, worldScale, brushRadiusMm);
    case 'Ring':
      return walkRing(map, seedFaceIndex, localUp, matrixWorld);
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

function walkMacroFace(map: ClientAdjacencyMap, seed: number, localUp: THREE.Vector3): number[] {
  const visited = new Set<number>();
  const queue: number[] = [seed];
  visited.add(seed);

  const seedNormal = map.faceNormals[seed];
  if (seedNormal.dot(localUp) > 0.2) return [];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const adjs = map.faceToFaces[curr];

    for (const adj of adjs) {
      if (!visited.has(adj)) {
        const nAdj = map.faceNormals[adj];
        if (nAdj.dot(localUp) <= 0.2) {
          const normalDeviation = seedNormal.angleTo(nAdj);
          const nCurr = map.faceNormals[curr];
          const edgeDihedral = nCurr.angleTo(nAdj);

          // 35 deg = 0.61 rad, 25 deg = 0.43 rad
          if (normalDeviation < 0.61 && edgeDihedral < 0.43) {
            visited.add(adj);
            queue.push(adj);
          }
        }
      }
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkRidge(map: ClientAdjacencyMap, seed: number, localUp: THREE.Vector3): number[] {
  const visited = new Set<number>();
  const seedNormal = map.faceNormals[seed];
  if (seedNormal.dot(localUp) > 0.2) return [];

  // Checks on-the-fly if face sits on a crease fold (angle with any neighbor > 12 deg / 0.21 rad)
  const isCrease = (f: number): boolean => {
    const norm = map.faceNormals[f];
    for (const adj of map.faceToFaces[f]) {
      if (norm.angleTo(map.faceNormals[adj]) > 0.21) return true;
    }
    return false;
  };

  if (!isCrease(seed)) return [];
  visited.add(seed);

  const getCreaseNeighbors = (f: number): { adj: number; angle: number }[] => {
    const norm = map.faceNormals[f];
    const list: { adj: number; angle: number }[] = [];
    for (const adj of map.faceToFaces[f]) {
      if (visited.has(adj)) continue;
      if (map.faceNormals[adj].dot(localUp) > 0.2) continue;
      const angle = norm.angleTo(map.faceNormals[adj]);
      if (angle > 0.21) {
        list.push({ adj, angle });
      }
    }
    list.sort((a, b) => b.angle - a.angle);
    return list;
  };

  const candidates = getCreaseNeighbors(seed);
  
  if (candidates.length > 0) {
    let curr = candidates[0].adj;
    visited.add(curr);
    while (true) {
      const next = getCreaseNeighbors(curr);
      if (next.length === 0) break;
      curr = next[0].adj;
      visited.add(curr);
    }
  }

  if (candidates.length > 1) {
    let curr = candidates[1].adj;
    visited.add(curr);
    while (true) {
      const next = getCreaseNeighbors(curr);
      if (next.length === 0) break;
      curr = next[0].adj;
      visited.add(curr);
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkCylinderSides(map: ClientAdjacencyMap, seed: number, localUp: THREE.Vector3): number[] {
  const visited = new Set<number>();
  const queue: number[] = [];

  const isAnisotropicCylinder = (f: number): boolean => {
    const norm = map.faceNormals[f];
    const angles = map.faceToFaces[f].map((adj) => norm.angleTo(map.faceNormals[adj]));
    if (angles.length === 0) return false;
    const maxAngle = Math.max(...angles);
    const minAngle = Math.min(...angles);
    // Anisotropic cylinder condition: curved in one direction (> 0.03 rad) and flat in another (< 0.05 rad)
    return maxAngle > 0.03 && minAngle < 0.05;
  };

  if (map.faceNormals[seed].dot(localUp) <= 0.2 && isAnisotropicCylinder(seed)) {
    queue.push(seed);
    visited.add(seed);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const adjs = map.faceToFaces[curr];
      for (const adj of adjs) {
        if (!visited.has(adj)) {
          if (map.faceNormals[adj].dot(localUp) <= 0.2 && isAnisotropicCylinder(adj)) {
            visited.add(adj);
            queue.push(adj);
          }
        }
      }
    }
  }

  return Array.from(visited).filter((idx) => idx === seed || map.faceNormals[idx].dot(localUp) <= 0.2);
}

function walkCylinderMinima(map: ClientAdjacencyMap, seed: number, localUp: THREE.Vector3): number[] {
  const visited = new Set<number>();

  const isAnisotropicCylinder = (f: number): boolean => {
    const norm = map.faceNormals[f];
    const angles = map.faceToFaces[f].map((adj) => norm.angleTo(map.faceNormals[adj]));
    if (angles.length === 0) return false;
    const maxAngle = Math.max(...angles);
    const minAngle = Math.min(...angles);
    return maxAngle > 0.03 && minAngle < 0.05;
  };

  if (map.faceNormals[seed].dot(localUp) <= 0.2 && isAnisotropicCylinder(seed)) {
    visited.add(seed);

    const getCylinderCandidates = (f: number): number[] => {
      const list: number[] = [];
      for (const adj of map.faceToFaces[f]) {
        if (visited.has(adj)) continue;
        if (map.faceNormals[adj].dot(localUp) > 0.2) continue;
        if (isAnisotropicCylinder(adj)) {
          list.push(adj);
        }
      }
      list.sort((a, b) => map.faceNormals[a].dot(localUp) - map.faceNormals[b].dot(localUp));
      return list;
    };

    const candidates = getCylinderCandidates(seed);

    if (candidates.length > 0) {
      let curr = candidates[0];
      visited.add(curr);
      while (true) {
        const next = getCylinderCandidates(curr);
        if (next.length === 0) break;
        curr = next[0];
        visited.add(curr);
      }
    }

    if (candidates.length > 1) {
      let curr = candidates[1];
      visited.add(curr);
      while (true) {
        const next = getCylinderCandidates(curr);
        if (next.length === 0) break;
        curr = next[0];
        visited.add(curr);
      }
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

function walkRing(map: ClientAdjacencyMap, seed: number, localUp: THREE.Vector3, matrixWorld: THREE.Matrix4): number[] {
  const visited = new Set<number>();
  const queue: number[] = [];

  if (map.faceNormals[seed].dot(localUp) <= 0.2) {
    const seedCentroidWorld = map.faceCentroids[seed].clone().applyMatrix4(matrixWorld);
    const seedZ = seedCentroidWorld.z;

    queue.push(seed);
    visited.add(seed);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const adjs = map.faceToFaces[curr];

      for (const adj of adjs) {
        if (!visited.has(adj)) {
          if (map.faceNormals[adj].dot(localUp) <= 0.2) {
            const adjCentroidWorld = map.faceCentroids[adj].clone().applyMatrix4(matrixWorld);
            if (adjCentroidWorld.z <= seedZ + 1.0 && adjCentroidWorld.z >= seedZ - 1.0) {
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
