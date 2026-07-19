import * as THREE from 'three';
import type { HollowPreviewCacheEntry } from './hollowingPreviewTypes';

export function buildGeometryVersionKey(geometry: THREE.BufferGeometry): string {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  const index = geometry.getIndex();

  return [
    geometry.uuid,
    position?.count ?? 0,
    position?.version ?? 0,
    index?.count ?? 0,
    index?.version ?? 0,
  ].join(':');
}

export function createGeometryFromPreviewPositions(positions: Float32Array): THREE.BufferGeometry {
  const copied = new Float32Array(positions.length);
  copied.set(positions);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(copied, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function disposeHollowPreviewCacheEntry(entry: HollowPreviewCacheEntry): void {
  entry.previewGeometry?.dispose();
  entry.infillGeometry?.dispose();
}

export function isHollowPreviewGeometryCacheOwned(
  geometry: THREE.BufferGeometry | null,
  entries: Iterable<HollowPreviewCacheEntry>,
): boolean {
  if (!geometry) return false;
  for (const entry of entries) {
    if (entry.previewGeometry === geometry || entry.infillGeometry === geometry) {
      return true;
    }
  }
  return false;
}

export function disposeHollowPreviewGeometryIfUncached(
  geometry: THREE.BufferGeometry | null,
  entries: Iterable<HollowPreviewCacheEntry>,
): void {
  if (!geometry) return;
  if (isHollowPreviewGeometryCacheOwned(geometry, entries)) return;
  geometry.dispose();
}
