import * as THREE from 'three';
import { disposeGeometryBVH } from '@/utils/bvh';

/**
 * Releases every heavy allocation a geometry owns.
 *
 * `BufferGeometry.dispose()` only tells the renderer to drop its GPU buffers;
 * the position/normal/index typed arrays stay attached and stay alive for as
 * long as any stale fiber, render list or module cache still points at the
 * geometry. That is what kept a cleared scene resident in system RAM. Dropping
 * the attributes makes such lingering references cheap.
 *
 * Only call this when the geometry is truly no longer drawn or kept for undo.
 */
export function releaseGeometryStorage(geometry: THREE.BufferGeometry): void {
  disposeGeometryBVH(geometry);
  try {
    geometry.dispose();
  } catch {
    // ignore disposal failures
  }
  for (const name of Object.keys(geometry.attributes)) {
    geometry.deleteAttribute(name);
  }
  geometry.setIndex(null);
  geometry.morphAttributes = {};
}
