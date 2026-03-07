import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accelerateGeometry } from '@/utils/bvh';

export type GeometryWithBounds = {
  geometry: THREE.BufferGeometry;
  bbox: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
};

export interface ProcessGeometryOptions {
  center?: boolean;
}

export async function processGeometry(bufferGeometry: THREE.BufferGeometry, options: ProcessGeometryOptions = { center: true }): Promise<GeometryWithBounds> {
  return new Promise((resolve, reject) => {
    try {
      console.log(`[${new Date().toISOString()}] [processGeometry] Starting Geometry Prep`);
      const startPrep = performance.now();
      const geometry = new THREE.BufferGeometry();
      geometry.copy(bufferGeometry);

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

      // Add BVH acceleration for fast raycasting (critical for support placement)
      console.log(`[${new Date().toISOString()}] [processGeometry] Starting BVH Construction`);
      const startBVH = performance.now();
      accelerateGeometry(geometry);
      console.log(`[${new Date().toISOString()}] [processGeometry] BVH Construction finished. Took ${(performance.now() - startBVH).toFixed(2)}ms`);

      const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());

      resolve({ geometry, bbox, center, size });
    } catch (e) {
      reject(e);
    }
  });
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

function collectMergedGeometryFromObject3d(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);

  const geometries: THREE.BufferGeometry[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;

    const cloned = mesh.geometry.clone();
    // DragonFruit controls mesh tinting centrally; ignore per-file 3MF vertex colors.
    if (cloned.getAttribute('color')) {
      cloned.deleteAttribute('color');
    }
    cloned.applyMatrix4(mesh.matrixWorld);
    geometries.push(cloned);
  });

  if (geometries.length === 0) {
    throw new Error('3MF contains no mesh geometry.');
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
    throw new Error('Failed to merge 3MF meshes.');
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
          const mergedGeometry = collectMergedGeometryFromObject3d(object);
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
