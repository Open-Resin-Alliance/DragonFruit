import * as THREE from 'three';
// Use drei's bundled three-mesh-bvh to avoid version conflicts
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '@react-three/drei/node_modules/three-mesh-bvh';

/**
 * Augment THREE.BufferGeometry with BVH acceleration methods.
 * This must be called once at app initialization.
 */
export function initializeBVH() {
  // Add BVH methods to BufferGeometry prototype
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  
  // Replace default raycast with accelerated version
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

/**
 * Add BVH acceleration to a geometry.
 * This builds a spatial acceleration structure that makes raycasting 100-1000x faster.
 * 
 * @param geometry - The geometry to accelerate
 * @returns The same geometry with BVH computed
 */
export function accelerateGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  // Check if computeBoundsTree is available (should be after initializeBVH)
  if (typeof (geometry as any).computeBoundsTree === 'function') {
    console.log('[BVH] Computing bounds tree for geometry...');
    const startTime = performance.now();
    
    (geometry as any).computeBoundsTree();
    
    const endTime = performance.now();
    console.log(`[BVH] Bounds tree computed in ${(endTime - startTime).toFixed(2)}ms`);
  } else {
    console.warn('[BVH] computeBoundsTree not available. Did you call initializeBVH()?');
  }
  
  return geometry;
}

/**
 * Dispose BVH data from a geometry to free memory.
 * 
 * @param geometry - The geometry to clean up
 */
export function disposeGeometryBVH(geometry: THREE.BufferGeometry): void {
  if (typeof (geometry as any).disposeBoundsTree === 'function') {
    (geometry as any).disposeBoundsTree();
  }
}
