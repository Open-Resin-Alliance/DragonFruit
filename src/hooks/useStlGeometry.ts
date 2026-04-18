import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accelerateGeometry } from '@/utils/bvh';
import { computeFlatteningPlanes, type FlatteningPlane } from '@/features/placeOnFace/logic/computeFlatteningPlanes';
import { repairGeometryWithManifold } from '@/utils/manifoldRepair';

export type MeshDefects = {
  /** Whether any non-finite vertex position values were found */
  hasDefects: boolean;
  /** Number of individual float components (x/y/z) replaced with 0 */
  repairedFloats: number;
  /** Total vertex count in the position buffer */
  totalVertices: number;
  /** Whether Manifold WASM successfully rebuilt the mesh topology */
  repairedByManifold?: boolean;
  /** Number of degenerate triangles collapsed by Manifold */
  degeneratesRemoved?: number;
};

export type GeometryWithBounds = {
  geometry: THREE.BufferGeometry;
  bbox: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  flatteningPlanes: FlatteningPlane[];
  /** Present when defective vertex data was detected and auto-repaired */
  meshDefects?: MeshDefects;
};

/**
 * Scans the geometry's position attribute for NaN/Inf values and replaces them
 * with 0, preventing Three.js bbox/sphere computations from producing NaN.
 * Returns a summary of what was repaired (or a clean result if nothing was wrong).
 */
function sanitizePositionAttribute(geometry: THREE.BufferGeometry): MeshDefects {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) return { hasDefects: false, repairedFloats: 0, totalVertices: 0 };

  const arr = posAttr.array as Float32Array;
  let repairedFloats = 0;

  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (arr as any)[i] = 0;
      repairedFloats++;
    }
  }

  if (repairedFloats > 0) {
    posAttr.needsUpdate = true;
  }

  return {
    hasDefects: repairedFloats > 0,
    repairedFloats,
    totalVertices: arr.length / 3,
  };
}

export interface ProcessGeometryOptions {
  center?: boolean;
}

// Cloning extremely large position buffers can require hundreds of MB and can
// fail with `RangeError: Array buffer allocation failed` on constrained heaps.
// Above this threshold we process the source geometry in place to avoid
// allocating a second full copy before normals/BVH work begins.
const IN_PLACE_PROCESSING_VERTEX_THRESHOLD = 12_000_000;

function stripEmbeddedColorAttributes(geometry: THREE.BufferGeometry): void {
  // DragonFruit controls model tinting centrally via mesh settings.
  // Ignore per-file embedded colors (e.g. binary STL color extension).
  if (geometry.getAttribute('color')) {
    geometry.deleteAttribute('color');
  }

  const withLoaderMetadata = geometry as THREE.BufferGeometry & {
    hasColors?: boolean;
    alpha?: number;
  };

  if ('hasColors' in withLoaderMetadata) {
    delete withLoaderMetadata.hasColors;
  }

  if ('alpha' in withLoaderMetadata) {
    delete withLoaderMetadata.alpha;
  }
}

export async function processGeometry(bufferGeometry: THREE.BufferGeometry, options: ProcessGeometryOptions = { center: true }): Promise<GeometryWithBounds> {
  console.log(`[${new Date().toISOString()}] [processGeometry] Starting Geometry Prep`);
  const startPrep = performance.now();
  const sourcePosition = bufferGeometry.getAttribute('position') as THREE.BufferAttribute | null;
  const sourceVertexCount = sourcePosition?.count ?? 0;

  let geometry: THREE.BufferGeometry;
  if (sourceVertexCount >= IN_PLACE_PROCESSING_VERTEX_THRESHOLD) {
    console.warn(
      `[processGeometry] Large geometry detected (${sourceVertexCount.toLocaleString()} vertices).` +
      ' Processing in place to avoid copy-time allocation spikes.',
    );
    geometry = bufferGeometry;
  } else {
    geometry = new THREE.BufferGeometry();
    try {
      geometry.copy(bufferGeometry);
    } catch (error) {
      if (error instanceof RangeError) {
        console.warn(
          '[processGeometry] Geometry copy allocation failed; falling back to in-place processing.',
          error,
        );
        geometry = bufferGeometry;
      } else {
        throw error;
      }
    }
  }

  stripEmbeddedColorAttributes(geometry);

  // Sanitize any non-finite position values before any Three.js computation
  // to prevent NaN bbox/sphere and subsequent renderer crashes.
  let meshDefects = sanitizePositionAttribute(geometry);
  if (meshDefects.hasDefects) {
    console.warn(
      `[processGeometry] Defective mesh detected: ${meshDefects.repairedFloats} non-finite position` +
      ` values (out of ${meshDefects.totalVertices * 3} floats) replaced with 0.`,
    );

    // Attempt full topology repair via Manifold (welds open edges, collapses
    // degenerate triangles, rebuilds a valid watertight solid).
    console.log(`[${new Date().toISOString()}] [processGeometry] Attempting Manifold repair`);
    const startManifold = performance.now();
    const repairStats = await repairGeometryWithManifold(geometry);
    if (repairStats) {
      console.log(
        `[processGeometry] Manifold repair succeeded in ${(performance.now() - startManifold).toFixed(2)}ms.` +
        ` Merged edges: ${repairStats.manifoldMergedEdges}, degenerates removed: ${repairStats.degeneratesRemoved}`,
      );
      meshDefects = {
        ...meshDefects,
        repairedByManifold: true,
        degeneratesRemoved: repairStats.degeneratesRemoved,
      };
    } else {
      console.warn(`[processGeometry] Manifold repair unavailable or failed — using NaN-sanitized geometry.`);
    }
  }

  // Yield to let the loading indicator repaint before each heavy synchronous op
  await new Promise<void>(r => setTimeout(r, 0));

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing Normals`);
  geometry.computeVertexNormals();

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing BBox`);
  geometry.computeBoundingBox();

  const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
  const preCenter = preBBox.getCenter(new THREE.Vector3());

  // Normalize: center X/Z at 0 and set bottom (minY) to 0 in local space
  if (options.center) {
    geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
  }
  geometry.computeBoundingBox();
  console.log(`[${new Date().toISOString()}] [processGeometry] Geometry Prep finished. Took ${(performance.now() - startPrep).toFixed(2)}ms`);

  // Yield before BVH (expensive synchronous tree build)
  await new Promise<void>(r => setTimeout(r, 0));

  // Add BVH acceleration for fast raycasting (critical for support placement)
  console.log(`[${new Date().toISOString()}] [processGeometry] Starting BVH Construction`);
  const startBVH = performance.now();
  accelerateGeometry(geometry);
  console.log(`[${new Date().toISOString()}] [processGeometry] BVH Construction finished. Took ${(performance.now() - startBVH).toFixed(2)}ms`);

  const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  // Yield before ConvexHull / flattening planes computation
  await new Promise<void>(r => setTimeout(r, 0));

  console.log(`[${new Date().toISOString()}] [processGeometry] Computing Flattening Planes`);
  const startPlanes = performance.now();
  const flatteningPlanes = computeFlatteningPlanes(geometry);
  console.log(`[${new Date().toISOString()}] [processGeometry] Flattening Planes finished. Took ${(performance.now() - startPlanes).toFixed(2)}ms`);

  return { geometry, bbox, center, size, flatteningPlanes, ...(meshDefects.hasDefects ? { meshDefects } : {}) };
}

export async function loadStlGeometry(fileUrl: string): Promise<GeometryWithBounds> {
  return new Promise((resolve, reject) => {
    const loader = new STLLoader();
    console.log(`[${new Date().toISOString()}] [loadStlGeometry] Starting STLLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (bufferGeometry) => {
        console.log(`[${new Date().toISOString()}] [loadStlGeometry] STLLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);
        processGeometry(bufferGeometry).then(resolve).catch(reject);
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

function collectMergedGeometryFromObject3d(root: THREE.Object3D, sourceLabel: '3MF' | 'OBJ'): THREE.BufferGeometry {
  root.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;

    const cloned = mesh.geometry.clone();
    // DragonFruit controls mesh tinting centrally; ignore per-file vertex colors.
    if (cloned.getAttribute('color')) {
      cloned.deleteAttribute('color');
    }
    cloned.applyMatrix4(mesh.matrixWorld);
    geometries.push(cloned);
  });

  if (geometries.length === 0) {
    throw new Error(`${sourceLabel} contains no mesh geometry.`);
  }

  if (geometries.length === 1) {
    return geometries[0];
  }

  const merged = mergeGeometries(geometries, false);
  geometries.forEach((g) => {
    if (g !== merged) {
      try {
        g.dispose();
      } catch {
        // ignore
      }
    }
  });

  if (!merged) {
    throw new Error(`Failed to merge ${sourceLabel} meshes.`);
  }

  return merged;
}

export async function load3mfGeometry(fileUrl: string): Promise<GeometryWithBounds> {
  return new Promise((resolve, reject) => {
    const loader = new ThreeMFLoader();
    console.log(`[${new Date().toISOString()}] [load3mfGeometry] Starting ThreeMFLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (object) => {
        console.log(`[${new Date().toISOString()}] [load3mfGeometry] ThreeMFLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        try {
          const mergedGeometry = collectMergedGeometryFromObject3d(object, '3MF');
          void processGeometry(mergedGeometry)
            .then(resolve)
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

export async function loadObjGeometry(fileUrl: string): Promise<GeometryWithBounds> {
  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    console.log(`[${new Date().toISOString()}] [loadObjGeometry] OBJLoader load for ${fileUrl}`);
    const startLoad = performance.now();

    loader.load(
      fileUrl,
      (object) => {
        console.log(`[${new Date().toISOString()}] [loadObjGeometry] OBJLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        try {
          const mergedGeometry = collectMergedGeometryFromObject3d(object, 'OBJ');
          void processGeometry(mergedGeometry)
            .then(resolve)
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

export async function loadMeshGeometry(fileUrl: string, fileName?: string): Promise<GeometryWithBounds> {
  const ext = (fileName ?? '').trim().toLowerCase();
  if (ext.endsWith('.3mf')) {
    return load3mfGeometry(fileUrl);
  }
  if (ext.endsWith('.obj')) {
    return loadObjGeometry(fileUrl);
  }
  return loadStlGeometry(fileUrl);
}

export function useStlGeometry(fileUrl: string | null, directGeometry?: THREE.BufferGeometry | null): GeometryWithBounds | null {
  const [geom, setGeom] = useState<GeometryWithBounds | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Case 1: Direct Geometry (e.g. from LYS import)
    if (directGeometry) {
      console.log(`[${new Date().toISOString()}] [useStlGeometry] Processing direct geometry`);
      processGeometry(directGeometry)
        .then((data) => {
          if (!cancelled) setGeom(data);
        })
        .catch((err) => {
          console.error("Failed to process direct geometry", err);
          if (!cancelled) setGeom(null);
        });
      return () => { cancelled = true; };
    }

    // Case 2: File URL (mesh import)
    if (fileUrl) {
      loadStlGeometry(fileUrl)
        .then((data) => {
          if (!cancelled) {
            console.log(`[${new Date().toISOString()}] [useStlGeometry] Calling setGeom`);
            setGeom(data);
          }
        })
        .catch((err) => {
          console.error("Failed to load STL", err);
          if (!cancelled) setGeom(null);
        });

      return () => { cancelled = true; };
    }

    // Case 3: No input
    setGeom(null);
    return;
  }, [fileUrl, directGeometry]);

  return geom;
}
