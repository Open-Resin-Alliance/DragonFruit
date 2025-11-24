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
    loader.load(
      fileUrl,
      (bufferGeometry) => {
        if (cancelled) return;
        const geometry = new THREE.BufferGeometry();
        geometry.copy(bufferGeometry as THREE.BufferGeometry);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
        const preCenter = preBBox.getCenter(new THREE.Vector3());
        // Normalize: center X/Z at 0 and set bottom (minY) to 0 in local space
        geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
        geometry.computeBoundingBox();
        
        // Add BVH acceleration for fast raycasting (critical for support placement)
        accelerateGeometry(geometry);
        
        const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
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
