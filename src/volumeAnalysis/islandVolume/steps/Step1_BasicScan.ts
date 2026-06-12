import * as THREE from 'three';

export interface Step1BasicScanOptions {
  px_mm: number;
  support_buffer_mm: number;
  layerHeightMm: number;
}

/**
 * Legacy Step 1 compatibility shim.
 *
 * The newer island workflow uses voxelization orchestrators, but some workshop
 * pages still import this helper. We keep a tiny implementation so the build
 * remains stable while the old page is migrated.
 */
export async function runStep1Scan(
  geometry: THREE.BufferGeometry,
  _options: Step1BasicScanOptions,
): Promise<THREE.Vector3[]> {
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  const bbox = geometry.boundingBox;
  if (!bbox) {
    return [];
  }

  const centerX = (bbox.min.x + bbox.max.x) * 0.5;
  const centerY = (bbox.min.y + bbox.max.y) * 0.5;

  // Return a deterministic lowest-point marker for the legacy workshop UI.
  return [new THREE.Vector3(centerX, centerY, bbox.min.z)];
}
