import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { accelerateGeometry } from '@/utils/bvh';

export type GeometryWithBounds = {
  geometry: THREE.BufferGeometry;
  bbox: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
};

export function useStlGeometry(fileUrl: string | null): GeometryWithBounds | null {
  const [geom, setGeom] = useState<GeometryWithBounds | null>(null);
  useEffect(() => {
    if (!fileUrl) {
      setGeom(null);
      return;
    }
    let cancelled = false;
    const loader = new STLLoader();
    console.log(`[${new Date().toISOString()}] [useStlGeometry] Starting STLLoader load for ${fileUrl}`);
    const startLoad = performance.now();
    loader.load(
      fileUrl,
      (bufferGeometry) => {
        if (cancelled) return;
        console.log(`[${new Date().toISOString()}] [useStlGeometry] STLLoader finished. Took ${(performance.now() - startLoad).toFixed(2)}ms`);

        console.log(`[${new Date().toISOString()}] [useStlGeometry] Starting Geometry Prep`);
        const startPrep = performance.now();
        const geometry = new THREE.BufferGeometry();
        geometry.copy(bufferGeometry as THREE.BufferGeometry);

        console.log(`[${new Date().toISOString()}] [useStlGeometry] Computing Normals`);
        geometry.computeVertexNormals();

        console.log(`[${new Date().toISOString()}] [useStlGeometry] Computing BBox`);
        geometry.computeBoundingBox();

        const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
        const preCenter = preBBox.getCenter(new THREE.Vector3());
        // Normalize: center X/Z at 0 and set bottom (minY) to 0 in local space
        geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
        geometry.computeBoundingBox();
        console.log(`[${new Date().toISOString()}] [useStlGeometry] Geometry Prep finished. Took ${(performance.now() - startPrep).toFixed(2)}ms`);

        // Add BVH acceleration for fast raycasting (critical for support placement)
        console.log(`[${new Date().toISOString()}] [useStlGeometry] Starting BVH Construction`);
        const startBVH = performance.now();
        accelerateGeometry(geometry);
        console.log(`[${new Date().toISOString()}] [useStlGeometry] BVH Construction finished. Took ${(performance.now() - startBVH).toFixed(2)}ms`);

        const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());

        console.log(`[${new Date().toISOString()}] [useStlGeometry] Calling setGeom`);
        setGeom({ geometry, bbox, center, size });
      },
      undefined,
      () => {
        setGeom(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);
  return geom;
}
